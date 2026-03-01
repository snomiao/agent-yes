//! Experimental P2P swarm module for multi-agent networking
//!
//! This module enables multiple agent-yes instances to discover each other
//! and coordinate work through a peer-to-peer network.

#[cfg(feature = "swarm")]
mod behaviour;
#[cfg(feature = "swarm")]
mod coordinator;
#[cfg(feature = "swarm")]
mod messages;
#[cfg(feature = "swarm")]
mod node;

#[cfg(feature = "swarm")]
pub use behaviour::AgentBehaviour;
#[cfg(feature = "swarm")]
pub use coordinator::CoordinatorState;
#[cfg(feature = "swarm")]
pub use messages::{AgentMessage, AgentRequest, AgentResponse, TaskStatus};
#[cfg(feature = "swarm")]
pub use node::{SwarmCommand, SwarmConfig, SwarmEvent2, SwarmNode};

#[cfg(not(feature = "swarm"))]
pub fn swarm_not_available() {
    eprintln!("Swarm mode requires the 'swarm' feature. Rebuild with:");
    eprintln!("  cargo build --release --features swarm");
}
