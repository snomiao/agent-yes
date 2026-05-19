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
mod url;

// Only the names actually consumed by main.rs are re-exported. The sub-
// modules keep their own internal types (AgentBehaviour, CoordinatorState,
// AgentMessage etc.) but exporting them at this level just produced unused-
// re-export warnings since this is a binary crate, not a library.
#[cfg(feature = "swarm")]
pub use node::{SwarmCommand, SwarmConfig, SwarmEvent2, SwarmNode};
#[cfg(feature = "swarm")]
pub use url::{generate_room_code, SwarmUrlConfig};

#[cfg(not(feature = "swarm"))]
pub fn swarm_not_available() {
    eprintln!("Swarm mode requires the 'swarm' feature. Rebuild with:");
    eprintln!("  cargo build --release --features swarm");
}
