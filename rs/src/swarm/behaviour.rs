//! Network behaviour for the agent swarm

use crate::swarm::messages::{AgentRequest, AgentResponse};
use futures::prelude::*;
use libp2p::{
    gossipsub::{self, IdentTopic, MessageAuthenticity, ValidationMode},
    identify,
    kad::{self, store::MemoryStore},
    mdns,
    ping,
    request_response::{self, Codec, ProtocolSupport},
    swarm::NetworkBehaviour,
    PeerId,
};
use std::time::Duration;
use std::{collections::hash_map::DefaultHasher, hash::Hash, hash::Hasher, io};
use tracing::debug;

/// Protocol name for request-response
pub const AGENT_PROTOCOL: &str = "/agent-yes/1.0.0";

/// The composed network behaviour for agent swarm
#[derive(NetworkBehaviour)]
#[behaviour(to_swarm = "AgentBehaviourEvent")]
pub struct AgentBehaviour {
    /// mDNS for local network discovery
    pub mdns: mdns::tokio::Behaviour,

    /// Kademlia DHT for internet-scale discovery
    pub kademlia: kad::Behaviour<MemoryStore>,

    /// Gossipsub for pub/sub messaging
    pub gossipsub: gossipsub::Behaviour,

    /// Request-response for direct agent communication
    pub request_response: request_response::Behaviour<AgentProtocolCodec>,

    /// Ping for connection health
    pub ping: ping::Behaviour,

    /// Identify for peer information exchange
    pub identify: identify::Behaviour,
}

/// Events emitted by the agent behaviour
#[derive(Debug)]
pub enum AgentBehaviourEvent {
    Mdns(mdns::Event),
    Kademlia(kad::Event),
    Gossipsub(gossipsub::Event),
    RequestResponse(request_response::Event<AgentRequest, AgentResponse>),
    Ping(ping::Event),
    Identify(identify::Event),
}

impl From<mdns::Event> for AgentBehaviourEvent {
    fn from(event: mdns::Event) -> Self {
        AgentBehaviourEvent::Mdns(event)
    }
}

impl From<kad::Event> for AgentBehaviourEvent {
    fn from(event: kad::Event) -> Self {
        AgentBehaviourEvent::Kademlia(event)
    }
}

impl From<gossipsub::Event> for AgentBehaviourEvent {
    fn from(event: gossipsub::Event) -> Self {
        AgentBehaviourEvent::Gossipsub(event)
    }
}

impl From<request_response::Event<AgentRequest, AgentResponse>> for AgentBehaviourEvent {
    fn from(event: request_response::Event<AgentRequest, AgentResponse>) -> Self {
        AgentBehaviourEvent::RequestResponse(event)
    }
}

impl From<ping::Event> for AgentBehaviourEvent {
    fn from(event: ping::Event) -> Self {
        AgentBehaviourEvent::Ping(event)
    }
}

impl From<identify::Event> for AgentBehaviourEvent {
    fn from(event: identify::Event) -> Self {
        AgentBehaviourEvent::Identify(event)
    }
}

impl AgentBehaviour {
    /// Create a new agent behaviour
    pub fn new(local_peer_id: PeerId, topic: &str) -> anyhow::Result<Self> {
        // mDNS for local discovery
        let mdns = mdns::tokio::Behaviour::new(mdns::Config::default(), local_peer_id)?;

        // Kademlia DHT
        let store = MemoryStore::new(local_peer_id);
        let kademlia = kad::Behaviour::new(local_peer_id, store);

        // Gossipsub
        let message_id_fn = |message: &gossipsub::Message| {
            let mut hasher = DefaultHasher::new();
            message.data.hash(&mut hasher);
            message.source.hash(&mut hasher);
            gossipsub::MessageId::from(hasher.finish().to_string())
        };

        let gossipsub_config = gossipsub::ConfigBuilder::default()
            .heartbeat_interval(Duration::from_secs(1))
            .validation_mode(ValidationMode::Strict)
            .message_id_fn(message_id_fn)
            .build()
            .map_err(|e| anyhow::anyhow!("Gossipsub config error: {}", e))?;

        let mut gossipsub = gossipsub::Behaviour::new(
            MessageAuthenticity::Signed(libp2p::identity::Keypair::generate_ed25519()),
            gossipsub_config,
        )
        .map_err(|e| anyhow::anyhow!("Gossipsub error: {}", e))?;

        // Subscribe to the topic
        let topic = IdentTopic::new(topic);
        gossipsub.subscribe(&topic)?;
        debug!("Subscribed to topic: {}", topic);

        // Request-response
        let request_response = request_response::Behaviour::new(
            [(
                libp2p::StreamProtocol::new(AGENT_PROTOCOL),
                ProtocolSupport::Full,
            )],
            request_response::Config::default(),
        );

        // Ping
        let ping = ping::Behaviour::new(ping::Config::new());

        // Identify
        let identify = identify::Behaviour::new(identify::Config::new(
            "/agent-yes/1.0.0".to_string(),
            libp2p::identity::Keypair::generate_ed25519().public(),
        ));

        Ok(Self {
            mdns,
            kademlia,
            gossipsub,
            request_response,
            ping,
            identify,
        })
    }

    /// Publish a message to the gossipsub topic
    pub fn publish(&mut self, topic: &str, message: &[u8]) -> anyhow::Result<()> {
        let topic = IdentTopic::new(topic);
        self.gossipsub
            .publish(topic, message)
            .map_err(|e| anyhow::anyhow!("Publish error: {:?}", e))?;
        Ok(())
    }

    /// Send a direct request to a peer
    pub fn send_request(&mut self, peer: &PeerId, request: AgentRequest) -> request_response::OutboundRequestId {
        self.request_response.send_request(peer, request)
    }

    /// Send a response to a request
    pub fn send_response(
        &mut self,
        channel: request_response::ResponseChannel<AgentResponse>,
        response: AgentResponse,
    ) -> Result<(), AgentResponse> {
        self.request_response.send_response(channel, response)
    }
}

/// Codec for agent protocol (request-response)
#[derive(Debug, Clone, Default)]
pub struct AgentProtocolCodec;

impl Codec for AgentProtocolCodec {
    type Protocol = libp2p::StreamProtocol;
    type Request = AgentRequest;
    type Response = AgentResponse;

    fn read_request<'life0, 'life1, 'life2, 'async_trait, T>(
        &'life0 mut self,
        _protocol: &'life1 Self::Protocol,
        io: &'life2 mut T,
    ) -> std::pin::Pin<
        Box<dyn Future<Output = io::Result<Self::Request>> + Send + 'async_trait>,
    >
    where
        T: AsyncRead + Unpin + Send + 'async_trait,
        'life0: 'async_trait,
        'life1: 'async_trait,
        'life2: 'async_trait,
        Self: 'async_trait,
    {
        Box::pin(async move {
            let mut buf = Vec::new();
            let mut reader = io.take(1024 * 1024); // 1MB limit
            reader.read_to_end(&mut buf).await?;
            serde_json::from_slice(&buf)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
        })
    }

    fn read_response<'life0, 'life1, 'life2, 'async_trait, T>(
        &'life0 mut self,
        _protocol: &'life1 Self::Protocol,
        io: &'life2 mut T,
    ) -> std::pin::Pin<
        Box<dyn Future<Output = io::Result<Self::Response>> + Send + 'async_trait>,
    >
    where
        T: AsyncRead + Unpin + Send + 'async_trait,
        'life0: 'async_trait,
        'life1: 'async_trait,
        'life2: 'async_trait,
        Self: 'async_trait,
    {
        Box::pin(async move {
            let mut buf = Vec::new();
            let mut reader = io.take(1024 * 1024); // 1MB limit
            reader.read_to_end(&mut buf).await?;
            serde_json::from_slice(&buf)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
        })
    }

    fn write_request<'life0, 'life1, 'life2, 'async_trait, T>(
        &'life0 mut self,
        _protocol: &'life1 Self::Protocol,
        io: &'life2 mut T,
        req: Self::Request,
    ) -> std::pin::Pin<Box<dyn Future<Output = io::Result<()>> + Send + 'async_trait>>
    where
        T: AsyncWrite + Unpin + Send + 'async_trait,
        'life0: 'async_trait,
        'life1: 'async_trait,
        'life2: 'async_trait,
        Self: 'async_trait,
    {
        Box::pin(async move {
            let data = serde_json::to_vec(&req)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
            io.write_all(&data).await?;
            io.close().await?;
            Ok(())
        })
    }

    fn write_response<'life0, 'life1, 'life2, 'async_trait, T>(
        &'life0 mut self,
        _protocol: &'life1 Self::Protocol,
        io: &'life2 mut T,
        res: Self::Response,
    ) -> std::pin::Pin<Box<dyn Future<Output = io::Result<()>> + Send + 'async_trait>>
    where
        T: AsyncWrite + Unpin + Send + 'async_trait,
        'life0: 'async_trait,
        'life1: 'async_trait,
        'life2: 'async_trait,
        Self: 'async_trait,
    {
        Box::pin(async move {
            let data = serde_json::to_vec(&res)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
            io.write_all(&data).await?;
            io.close().await?;
            Ok(())
        })
    }
}
