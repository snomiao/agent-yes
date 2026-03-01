//! Coordinator election and task distribution

use crate::swarm::messages::{AgentCapabilities, AgentId, TaskId, TaskStatus};
use std::collections::HashMap;
use std::time::{Duration, Instant};
use tracing::{debug, info, warn};

/// Timeout for coordinator heartbeat
const COORDINATOR_TIMEOUT: Duration = Duration::from_secs(10);

/// Interval for coordinator heartbeat
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(3);

/// State of the coordinator election
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ElectionState {
    /// No coordinator known
    NoCoordinator,
    /// Election in progress
    Electing,
    /// We are the coordinator
    Coordinator,
    /// Another agent is the coordinator
    Follower { coordinator_id: AgentId },
}

/// Task assignment
#[derive(Debug, Clone)]
pub struct TaskAssignment {
    pub task_id: TaskId,
    pub prompt: String,
    pub status: TaskStatus,
    pub assigned_at: Instant,
}

/// Coordinator state management
#[derive(Debug)]
pub struct CoordinatorState {
    /// Our agent ID
    pub agent_id: AgentId,

    /// Our priority for election (higher wins)
    pub priority: u64,

    /// Current election state
    pub state: ElectionState,

    /// Known agents in the swarm
    pub agents: HashMap<AgentId, AgentCapabilities>,

    /// Tasks being managed
    pub tasks: HashMap<TaskId, TaskAssignment>,

    /// Pending tasks waiting for assignment
    pub pending_tasks: Vec<(TaskId, String)>,

    /// Last heartbeat from coordinator
    pub last_coordinator_heartbeat: Option<Instant>,

    /// Last time we sent a heartbeat (if coordinator)
    pub last_heartbeat_sent: Option<Instant>,

    /// Election start time
    pub election_start: Option<Instant>,

    /// Highest priority seen during election
    pub highest_priority_seen: Option<(AgentId, u64)>,
}

impl CoordinatorState {
    /// Create new coordinator state
    pub fn new(agent_id: AgentId) -> Self {
        // Priority based on random value + timestamp for uniqueness
        let priority = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as u64;

        Self {
            agent_id,
            priority,
            state: ElectionState::NoCoordinator,
            agents: HashMap::new(),
            tasks: HashMap::new(),
            pending_tasks: Vec::new(),
            last_coordinator_heartbeat: None,
            last_heartbeat_sent: None,
            election_start: None,
            highest_priority_seen: None,
        }
    }

    /// Start an election
    pub fn start_election(&mut self) {
        info!("Starting coordinator election");
        self.state = ElectionState::Electing;
        self.election_start = Some(Instant::now());
        self.highest_priority_seen = Some((self.agent_id.clone(), self.priority));
    }

    /// Handle election message from another agent
    pub fn handle_election(&mut self, agent_id: AgentId, priority: u64) {
        debug!("Received election message from {} with priority {}", agent_id, priority);

        match &self.state {
            ElectionState::NoCoordinator => {
                // Start participating in election
                self.start_election();
            }
            ElectionState::Electing => {
                // Update highest priority if this one is higher
                if let Some((_, highest)) = &self.highest_priority_seen {
                    if priority > *highest || (priority == *highest && agent_id > self.agent_id) {
                        self.highest_priority_seen = Some((agent_id, priority));
                    }
                }
            }
            ElectionState::Coordinator => {
                // If someone has higher priority, step down
                if priority > self.priority {
                    info!("Stepping down as coordinator, {} has higher priority", agent_id);
                    self.state = ElectionState::Follower {
                        coordinator_id: agent_id.clone(),
                    };
                    self.last_coordinator_heartbeat = Some(Instant::now());
                }
            }
            ElectionState::Follower { coordinator_id } => {
                // If the new agent has higher priority than current coordinator
                if priority > self.priority {
                    debug!("New potential coordinator: {} (was {})", agent_id, coordinator_id);
                }
            }
        }
    }

    /// Handle coordinator heartbeat
    pub fn handle_coordinator_heartbeat(&mut self, coordinator_id: AgentId) {
        match &self.state {
            ElectionState::NoCoordinator | ElectionState::Electing => {
                // Accept this coordinator
                info!("Accepting {} as coordinator", coordinator_id);
                self.state = ElectionState::Follower {
                    coordinator_id: coordinator_id.clone(),
                };
                self.last_coordinator_heartbeat = Some(Instant::now());
                self.election_start = None;
            }
            ElectionState::Coordinator => {
                // Another coordinator? Compare priorities
                if coordinator_id != self.agent_id {
                    warn!(
                        "Received heartbeat from another coordinator: {}",
                        coordinator_id
                    );
                    // The one with higher ID stays (simple conflict resolution)
                    if coordinator_id > self.agent_id {
                        info!("Stepping down in favor of {}", coordinator_id);
                        self.state = ElectionState::Follower {
                            coordinator_id: coordinator_id.clone(),
                        };
                        self.last_coordinator_heartbeat = Some(Instant::now());
                    }
                }
            }
            ElectionState::Follower { coordinator_id: current } => {
                if *current == coordinator_id {
                    self.last_coordinator_heartbeat = Some(Instant::now());
                } else {
                    // Different coordinator - use the one with higher ID
                    if coordinator_id > *current {
                        self.state = ElectionState::Follower {
                            coordinator_id: coordinator_id.clone(),
                        };
                        self.last_coordinator_heartbeat = Some(Instant::now());
                    }
                }
            }
        }
    }

    /// Check election timeout and finalize if needed
    pub fn check_election_timeout(&mut self) -> Option<bool> {
        if let ElectionState::Electing = &self.state {
            if let Some(start) = self.election_start {
                if start.elapsed() > Duration::from_secs(3) {
                    // Election timeout - check if we won
                    if let Some((winner_id, _)) = &self.highest_priority_seen {
                        if *winner_id == self.agent_id {
                            info!("Won coordinator election!");
                            self.state = ElectionState::Coordinator;
                            self.election_start = None;
                            return Some(true);
                        } else {
                            info!("Lost election to {}", winner_id);
                            self.state = ElectionState::Follower {
                                coordinator_id: winner_id.clone(),
                            };
                            self.election_start = None;
                            return Some(false);
                        }
                    }
                }
            }
        }
        None
    }

    /// Check if coordinator heartbeat has timed out
    pub fn check_coordinator_timeout(&mut self) -> bool {
        if let ElectionState::Follower { coordinator_id } = &self.state {
            if let Some(last) = self.last_coordinator_heartbeat {
                if last.elapsed() > COORDINATOR_TIMEOUT {
                    warn!("Coordinator {} timed out", coordinator_id);
                    self.state = ElectionState::NoCoordinator;
                    return true;
                }
            }
        }
        false
    }

    /// Check if we should send a heartbeat (if coordinator)
    pub fn should_send_heartbeat(&self) -> bool {
        if self.state == ElectionState::Coordinator {
            if let Some(last) = self.last_heartbeat_sent {
                return last.elapsed() > HEARTBEAT_INTERVAL;
            }
            return true;
        }
        false
    }

    /// Mark heartbeat as sent
    pub fn heartbeat_sent(&mut self) {
        self.last_heartbeat_sent = Some(Instant::now());
    }

    /// Register an agent
    pub fn register_agent(&mut self, capabilities: AgentCapabilities) {
        let agent_id = capabilities.agent_id.clone();
        debug!("Registered agent: {} ({})", agent_id, capabilities.cli);
        self.agents.insert(agent_id, capabilities);
    }

    /// Remove an agent
    pub fn remove_agent(&mut self, agent_id: &AgentId) {
        debug!("Removed agent: {}", agent_id);
        self.agents.remove(agent_id);
    }

    /// Add a task to the pending queue
    pub fn add_task(&mut self, task_id: TaskId, prompt: String) {
        debug!("Added task: {}", task_id);
        self.pending_tasks.push((task_id, prompt));
    }

    /// Assign a pending task to an available agent
    pub fn assign_pending_task(&mut self) -> Option<(AgentId, TaskId, String)> {
        if self.pending_tasks.is_empty() {
            return None;
        }

        // Find an available agent
        let available_agent = self
            .agents
            .values()
            .find(|a| !a.busy && a.agent_id != self.agent_id);

        if let Some(agent) = available_agent {
            let (task_id, prompt) = self.pending_tasks.remove(0);
            let agent_id = agent.agent_id.clone();

            self.tasks.insert(
                task_id.clone(),
                TaskAssignment {
                    task_id: task_id.clone(),
                    prompt: prompt.clone(),
                    status: TaskStatus::Assigned {
                        agent_id: agent_id.clone(),
                    },
                    assigned_at: Instant::now(),
                },
            );

            return Some((agent_id, task_id, prompt));
        }

        None
    }

    /// Update task status
    pub fn update_task(&mut self, task_id: &TaskId, status: TaskStatus) {
        if let Some(task) = self.tasks.get_mut(task_id) {
            debug!("Task {} status: {:?}", task_id, status);
            task.status = status;
        }
    }

    /// Get available agents count
    pub fn available_agents(&self) -> usize {
        self.agents.values().filter(|a| !a.busy).count()
    }

    /// Is this agent the coordinator?
    pub fn is_coordinator(&self) -> bool {
        self.state == ElectionState::Coordinator
    }

    /// Get coordinator ID if known
    pub fn get_coordinator(&self) -> Option<&AgentId> {
        match &self.state {
            ElectionState::Coordinator => Some(&self.agent_id),
            ElectionState::Follower { coordinator_id } => Some(coordinator_id),
            _ => None,
        }
    }
}
