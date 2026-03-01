//! Swarm node - main entry point for P2P networking

use crate::swarm::behaviour::{AgentBehaviour, AgentBehaviourEvent};
use crate::swarm::coordinator::CoordinatorState;
use crate::swarm::messages::{AgentCapabilities, AgentMessage, AgentRequest, AgentResponse};
use anyhow::Result;
use futures::StreamExt;
use libp2p::{
    gossipsub::IdentTopic,
    identity::Keypair,
    kad,
    mdns,
    request_response,
    swarm::SwarmEvent,
    Multiaddr, PeerId, Swarm,
};
use std::collections::HashSet;
use std::time::Duration;
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};
use uuid::Uuid;

/// Configuration for the swarm node
#[derive(Debug, Clone)]
pub struct SwarmConfig {
    /// Listen address (default: /ip4/0.0.0.0/tcp/0)
    pub listen_addr: String,
    /// Topic for gossipsub
    pub topic: String,
    /// Bootstrap peers
    pub bootstrap_peers: Vec<String>,
    /// CLI name (claude, codex, etc.)
    pub cli: String,
    /// Current working directory
    pub cwd: String,
    /// Room code for this session (generated fresh each time)
    pub room_code: Option<String>,
    /// Room code to resolve via DHT (when connecting via room code)
    pub room_code_to_resolve: Option<String>,
}

impl Default for SwarmConfig {
    fn default() -> Self {
        Self {
            listen_addr: "/ip4/0.0.0.0/tcp/0".to_string(),
            topic: "agent-yes-swarm".to_string(),
            bootstrap_peers: vec![],
            cli: "claude".to_string(),
            cwd: std::env::current_dir()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string(),
            room_code: None,
            room_code_to_resolve: None,
        }
    }
}

/// Commands that can be sent to the swarm
#[derive(Debug)]
pub enum SwarmCommand {
    /// Broadcast a task to the swarm
    BroadcastTask { prompt: String },
    /// Send a chat message
    Chat { message: String },
    /// Get swarm status
    GetStatus,
    /// Shutdown the swarm
    Shutdown,
}

/// Events from the swarm
#[derive(Debug, Clone)]
pub enum SwarmEvent2 {
    /// New peer discovered
    PeerDiscovered { peer_id: String },
    /// Peer disconnected
    PeerLeft { peer_id: String },
    /// Task received
    TaskReceived { task_id: String, prompt: String },
    /// Task status update
    TaskUpdate { task_id: String, status: String },
    /// Chat message received
    ChatReceived { agent_id: String, message: String },
    /// Became coordinator
    BecameCoordinator,
    /// New coordinator elected
    NewCoordinator { coordinator_id: String },
    /// Swarm status
    Status {
        peer_count: usize,
        is_coordinator: bool,
        coordinator_id: Option<String>,
    },
}

/// The swarm node
pub struct SwarmNode {
    swarm: Swarm<AgentBehaviour>,
    config: SwarmConfig,
    agent_id: String,
    peer_id: PeerId,
    coordinator: CoordinatorState,
    known_peers: HashSet<PeerId>,
    topic: IdentTopic,
    /// Collected listen addresses for sharing
    listen_addrs: Vec<String>,
}

impl SwarmNode {
    /// Create a new swarm node
    pub async fn new(config: SwarmConfig) -> Result<Self> {
        let agent_id = format!("agent-{}", Uuid::new_v4().to_string().split('-').next().unwrap_or("unknown"));

        info!("Creating swarm node: {}", agent_id);
        info!("  Listen: {}", config.listen_addr);
        info!("  Topic: {}", config.topic);
        info!("  CLI: {}", config.cli);

        // Generate keypair for this node
        let keypair = Keypair::generate_ed25519();
        let peer_id = PeerId::from(keypair.public());

        info!("  PeerId: {}", peer_id);

        // Create the swarm
        let swarm = libp2p::SwarmBuilder::with_existing_identity(keypair)
            .with_tokio()
            .with_tcp(
                libp2p::tcp::Config::default(),
                libp2p::noise::Config::new,
                libp2p::yamux::Config::default,
            )?
            .with_behaviour(|key| {
                AgentBehaviour::new(PeerId::from(key.public()), &config.topic)
                    .expect("Failed to create behaviour")
            })?
            .with_swarm_config(|c| c.with_idle_connection_timeout(Duration::from_secs(60)))
            .build();

        let topic = IdentTopic::new(&config.topic);
        let coordinator = CoordinatorState::new(agent_id.clone());

        Ok(Self {
            swarm,
            config,
            agent_id,
            peer_id,
            coordinator,
            known_peers: HashSet::new(),
            topic,
            listen_addrs: Vec::new(),
        })
    }

    /// Start the swarm node
    pub async fn run(
        mut self,
        mut cmd_rx: mpsc::Receiver<SwarmCommand>,
        event_tx: mpsc::Sender<SwarmEvent2>,
    ) -> Result<()> {
        // Start listening
        let listen_addr: Multiaddr = self.config.listen_addr.parse()?;
        self.swarm.listen_on(listen_addr)?;

        // Connect to bootstrap peers
        for addr_str in &self.config.bootstrap_peers {
            if let Ok(addr) = addr_str.parse::<Multiaddr>() {
                info!("Dialing bootstrap peer: {}", addr);
                if let Err(e) = self.swarm.dial(addr) {
                    warn!("Failed to dial bootstrap peer: {}", e);
                }
            }
        }

        // Resolve room code via DHT if provided
        if let Some(ref code) = self.config.room_code_to_resolve {
            info!("Looking up room code {} in DHT...", code);
            let key = format!("room:{}", code);
            let record_key = kad::RecordKey::new(&key);
            self.swarm.behaviour_mut().kademlia.get_record(record_key);
        }

        // Announce ourselves after a short delay
        let mut announce_timer = tokio::time::interval(Duration::from_secs(5));
        let mut heartbeat_timer = tokio::time::interval(Duration::from_secs(1));
        let mut connection_info_printed = false;

        info!("Swarm node started, entering event loop");

        loop {
            tokio::select! {
                // Handle swarm events
                event = self.swarm.select_next_some() => {
                    if let Err(e) = self.handle_swarm_event(event, &event_tx, &mut connection_info_printed).await {
                        error!("Error handling swarm event: {}", e);
                    }
                }

                // Handle commands
                Some(cmd) = cmd_rx.recv() => {
                    match cmd {
                        SwarmCommand::Shutdown => {
                            info!("Shutting down swarm");
                            // Announce leave
                            let msg = AgentMessage::Leave { agent_id: self.agent_id.clone() };
                            let _ = self.publish_message(&msg);
                            break;
                        }
                        SwarmCommand::BroadcastTask { prompt } => {
                            let task_id = Uuid::new_v4().to_string();
                            info!("Broadcasting task: {}", task_id);
                            let msg = AgentMessage::TaskBroadcast {
                                task_id,
                                prompt,
                                requirements: None,
                            };
                            let _ = self.publish_message(&msg);
                        }
                        SwarmCommand::Chat { message } => {
                            let msg = AgentMessage::Chat {
                                agent_id: self.agent_id.clone(),
                                message,
                            };
                            let _ = self.publish_message(&msg);
                        }
                        SwarmCommand::GetStatus => {
                            let _ = event_tx.send(SwarmEvent2::Status {
                                peer_count: self.known_peers.len(),
                                is_coordinator: self.coordinator.is_coordinator(),
                                coordinator_id: self.coordinator.get_coordinator().cloned(),
                            }).await;
                        }
                    }
                }

                // Periodic announcement
                _ = announce_timer.tick() => {
                    self.announce().await?;
                }

                // Coordinator heartbeat check
                _ = heartbeat_timer.tick() => {
                    // Check election timeout
                    if let Some(won) = self.coordinator.check_election_timeout() {
                        if won {
                            let _ = event_tx.send(SwarmEvent2::BecameCoordinator).await;
                        }
                    }

                    // Check coordinator timeout
                    if self.coordinator.check_coordinator_timeout() {
                        info!("Coordinator timed out, starting election");
                        self.coordinator.start_election();
                        let msg = AgentMessage::CoordinatorElection {
                            agent_id: self.agent_id.clone(),
                            priority: self.coordinator.priority,
                        };
                        let _ = self.publish_message(&msg);
                    }

                    // Send heartbeat if coordinator
                    if self.coordinator.should_send_heartbeat() {
                        let msg = AgentMessage::CoordinatorHeartbeat {
                            coordinator_id: self.agent_id.clone(),
                            timestamp: std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_secs(),
                        };
                        let _ = self.publish_message(&msg);
                        self.coordinator.heartbeat_sent();
                    }
                }
            }
        }

        Ok(())
    }

    /// Handle a swarm event
    async fn handle_swarm_event(
        &mut self,
        event: SwarmEvent<AgentBehaviourEvent>,
        event_tx: &mpsc::Sender<SwarmEvent2>,
        connection_info_printed: &mut bool,
    ) -> Result<()> {
        match event {
            SwarmEvent::NewListenAddr { address, .. } => {
                let full_addr = format!("{}/p2p/{}", address, self.peer_id);
                info!("Listening on {}", full_addr);
                self.listen_addrs.push(full_addr.clone());

                // Print connection info after we have at least one address
                if !*connection_info_printed && !self.listen_addrs.is_empty() {
                    *connection_info_printed = true;
                    self.print_connection_info();

                    // Publish room code to DHT
                    if let Some(code) = self.config.room_code.clone() {
                        self.publish_room_code(&code);
                    }
                }
            }

            SwarmEvent::Behaviour(AgentBehaviourEvent::Mdns(mdns::Event::Discovered(peers))) => {
                for (peer_id, addr) in peers {
                    if peer_id != self.peer_id && !self.known_peers.contains(&peer_id) {
                        info!("Discovered peer via mDNS: {} at {}", peer_id, addr);
                        self.known_peers.insert(peer_id);
                        self.swarm.behaviour_mut().kademlia.add_address(&peer_id, addr);
                        let _ = event_tx.send(SwarmEvent2::PeerDiscovered {
                            peer_id: peer_id.to_string(),
                        }).await;
                    }
                }
            }

            SwarmEvent::Behaviour(AgentBehaviourEvent::Mdns(mdns::Event::Expired(peers))) => {
                for (peer_id, _) in peers {
                    if self.known_peers.remove(&peer_id) {
                        info!("Peer expired: {}", peer_id);
                        let _ = event_tx.send(SwarmEvent2::PeerLeft {
                            peer_id: peer_id.to_string(),
                        }).await;
                    }
                }
            }

            SwarmEvent::Behaviour(AgentBehaviourEvent::Gossipsub(libp2p::gossipsub::Event::Message {
                message,
                propagation_source,
                ..
            })) => {
                if let Ok(msg) = serde_json::from_slice::<AgentMessage>(&message.data) {
                    self.handle_agent_message(msg, propagation_source, event_tx).await?;
                }
            }

            SwarmEvent::Behaviour(AgentBehaviourEvent::RequestResponse(
                request_response::Event::Message { peer, message },
            )) => {
                match message {
                    request_response::Message::Request { request, channel, .. } => {
                        let response = self.handle_request(request).await;
                        let _ = self.swarm.behaviour_mut().send_response(channel, response);
                    }
                    request_response::Message::Response { response, .. } => {
                        debug!("Received response from {}: {:?}", peer, response);
                    }
                }
            }

            SwarmEvent::Behaviour(AgentBehaviourEvent::Kademlia(kad::Event::RoutingUpdated {
                peer, ..
            })) => {
                debug!("Kademlia routing updated for peer: {}", peer);
            }

            SwarmEvent::Behaviour(AgentBehaviourEvent::Kademlia(kad::Event::OutboundQueryProgressed {
                result: kad::QueryResult::GetRecord(Ok(kad::GetRecordOk::FoundRecord(record))),
                ..
            })) => {
                // Room code resolution: found a record
                let key_str = String::from_utf8_lossy(record.record.key.as_ref());
                if key_str.starts_with("room:") {
                    if let Ok(peer_addr) = String::from_utf8(record.record.value.clone()) {
                        info!("Resolved room code to peer: {}", peer_addr);
                        // Dial the resolved peer
                        if let Ok(addr) = peer_addr.parse::<Multiaddr>() {
                            if let Err(e) = self.swarm.dial(addr) {
                                warn!("Failed to dial resolved peer: {}", e);
                            }
                        }
                    }
                }
            }

            SwarmEvent::Behaviour(AgentBehaviourEvent::Kademlia(kad::Event::OutboundQueryProgressed {
                result: kad::QueryResult::GetRecord(Err(err)),
                ..
            })) => {
                warn!("Room code lookup failed: {:?}", err);
            }

            SwarmEvent::Behaviour(AgentBehaviourEvent::Kademlia(kad::Event::OutboundQueryProgressed {
                result: kad::QueryResult::PutRecord(Ok(_)),
                ..
            })) => {
                debug!("Room code published to DHT successfully");
            }

            SwarmEvent::ConnectionEstablished { peer_id, .. } => {
                debug!("Connection established: {}", peer_id);
                if peer_id != self.peer_id {
                    self.known_peers.insert(peer_id);
                }
            }

            SwarmEvent::ConnectionClosed { peer_id, .. } => {
                debug!("Connection closed: {}", peer_id);
            }

            _ => {}
        }

        Ok(())
    }

    /// Handle an agent message from gossipsub
    async fn handle_agent_message(
        &mut self,
        msg: AgentMessage,
        source: PeerId,
        event_tx: &mpsc::Sender<SwarmEvent2>,
    ) -> Result<()> {
        match msg {
            AgentMessage::Announce(capabilities) => {
                debug!("Agent announced: {} ({})", capabilities.agent_id, capabilities.cli);
                self.coordinator.register_agent(capabilities);
            }

            AgentMessage::Leave { agent_id } => {
                debug!("Agent left: {}", agent_id);
                self.coordinator.remove_agent(&agent_id);
            }

            AgentMessage::TaskBroadcast { task_id, prompt, .. } => {
                info!("Task broadcast: {} - {}", task_id, prompt.chars().take(50).collect::<String>());
                let _ = event_tx.send(SwarmEvent2::TaskReceived { task_id, prompt }).await;
            }

            AgentMessage::TaskClaim { task_id, agent_id } => {
                info!("Task {} claimed by {}", task_id, agent_id);
            }

            AgentMessage::TaskUpdate { task_id, status } => {
                info!("Task {} status: {:?}", task_id, status);
                self.coordinator.update_task(&task_id, status.clone());
                let _ = event_tx.send(SwarmEvent2::TaskUpdate {
                    task_id,
                    status: format!("{:?}", status),
                }).await;
            }

            AgentMessage::CoordinatorElection { agent_id, priority } => {
                self.coordinator.handle_election(agent_id.clone(), priority);
                // Respond with our own election message
                if self.coordinator.state == crate::swarm::coordinator::ElectionState::Electing {
                    let msg = AgentMessage::CoordinatorElection {
                        agent_id: self.agent_id.clone(),
                        priority: self.coordinator.priority,
                    };
                    let _ = self.publish_message(&msg);
                }
            }

            AgentMessage::CoordinatorHeartbeat { coordinator_id, .. } => {
                self.coordinator.handle_coordinator_heartbeat(coordinator_id.clone());
                if self.coordinator.get_coordinator() == Some(&coordinator_id) {
                    let _ = event_tx.send(SwarmEvent2::NewCoordinator { coordinator_id }).await;
                }
            }

            AgentMessage::Chat { agent_id, message } => {
                let _ = event_tx.send(SwarmEvent2::ChatReceived { agent_id, message }).await;
            }
        }

        Ok(())
    }

    /// Handle a direct request
    async fn handle_request(&mut self, request: AgentRequest) -> AgentResponse {
        match request {
            AgentRequest::GetStatus => {
                let caps = AgentCapabilities::new(
                    self.agent_id.clone(),
                    self.config.cli.clone(),
                    self.config.cwd.clone(),
                );
                AgentResponse::Status(caps)
            }

            AgentRequest::Ping => {
                AgentResponse::Pong { agent_id: self.agent_id.clone() }
            }

            AgentRequest::GetTasks => {
                let tasks: Vec<_> = self.coordinator.tasks
                    .iter()
                    .map(|(id, t)| (id.clone(), t.status.clone()))
                    .collect();
                AgentResponse::Tasks { tasks }
            }

            AgentRequest::ExecuteTask { task_id, .. } => {
                // For now, just accept - actual execution would be handled by the agent
                AgentResponse::TaskAccepted { task_id }
            }

            AgentRequest::CancelTask { task_id } => {
                AgentResponse::TaskCancelled { task_id }
            }

            AgentRequest::JoinSwarm { capabilities } => {
                self.coordinator.register_agent(capabilities);
                AgentResponse::JoinAccepted {
                    coordinator_id: self.coordinator.get_coordinator().cloned().unwrap_or_default(),
                }
            }
        }
    }

    /// Announce our presence
    async fn announce(&mut self) -> Result<()> {
        let capabilities = AgentCapabilities::new(
            self.agent_id.clone(),
            self.config.cli.clone(),
            self.config.cwd.clone(),
        );
        let msg = AgentMessage::Announce(capabilities);
        // Ignore publish errors (e.g., InsufficientPeers when alone)
        let _ = self.publish_message(&msg);
        Ok(())
    }

    /// Publish a message to gossipsub (may fail silently if no peers)
    fn publish_message(&mut self, msg: &AgentMessage) -> Result<()> {
        let data = serde_json::to_vec(msg)?;
        match self.swarm.behaviour_mut().publish(&self.config.topic, &data) {
            Ok(_) => Ok(()),
            Err(e) => {
                // Don't treat InsufficientPeers as a fatal error
                debug!("Publish failed (may be normal if no peers): {:?}", e);
                Ok(())
            }
        }
    }

    /// Print connection info banner
    fn print_connection_info(&self) {
        use crate::swarm::url::SwarmUrlConfig;

        let separator = "=".repeat(80);

        println!();
        println!("{}", separator);
        println!("SWARM STARTED");
        println!("{}", separator);
        println!("Topic:     {}", self.config.topic);

        if let Some(ref code) = self.config.room_code {
            println!("Room Code: {}", code);
        }

        println!("Peer ID:   {}", self.peer_id);
        println!();
        println!("Share with teammates:");
        println!();

        // Same network (LAN) - just topic
        println!("  Same network (LAN):");
        println!("    agent-yes --swarm {}", self.config.topic);
        println!();

        // Remote (Internet) - full URL with peer addresses
        if !self.listen_addrs.is_empty() {
            let url_config = SwarmUrlConfig {
                topic: self.config.topic.clone(),
                ..Default::default()
            };
            let swarm_url = url_config.to_swarm_url(&self.listen_addrs);
            println!("  Remote (Internet):");
            println!("    agent-yes --swarm \"{}\"", swarm_url);
            println!();
        }

        // Room code
        if let Some(ref code) = self.config.room_code {
            println!("  Short code:");
            println!("    agent-yes --swarm {}", code);
            println!();
        }

        println!("{}", separator);
        println!();
    }

    /// Publish room code to DHT for resolution
    fn publish_room_code(&mut self, code: &str) {
        // Use the first listen address (prefer non-localhost)
        let addr = self.listen_addrs.iter()
            .find(|a| !a.contains("127.0.0.1") && !a.contains("::1"))
            .or(self.listen_addrs.first());

        if let Some(addr) = addr {
            let key = format!("room:{}", code.to_uppercase().replace('-', ""));
            let record = kad::Record {
                key: kad::RecordKey::new(&key),
                value: addr.as_bytes().to_vec(),
                publisher: Some(self.peer_id),
                expires: Some(std::time::Instant::now() + std::time::Duration::from_secs(3600)),
            };

            debug!("Publishing room code {} -> {} to DHT", code, addr);
            if let Err(e) = self.swarm.behaviour_mut().kademlia.put_record(record, kad::Quorum::One) {
                warn!("Failed to publish room code to DHT: {:?}", e);
            }
        }
    }
}
