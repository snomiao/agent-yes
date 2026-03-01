//! Message types for agent-to-agent communication

use serde::{Deserialize, Serialize};
use std::time::SystemTime;

/// Unique identifier for an agent in the swarm
pub type AgentId = String;

/// Unique identifier for a task
pub type TaskId = String;

/// Status of a task
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum TaskStatus {
    /// Task is pending assignment
    Pending,
    /// Task is assigned to an agent
    Assigned { agent_id: AgentId },
    /// Task is currently being executed
    InProgress { agent_id: AgentId, progress: u8 },
    /// Task completed successfully
    Completed { agent_id: AgentId, result: String },
    /// Task failed
    Failed { agent_id: AgentId, error: String },
    /// Task was cancelled
    Cancelled,
}

/// Agent capability advertisement
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentCapabilities {
    /// Agent's unique identifier
    pub agent_id: AgentId,
    /// Name of the underlying CLI (claude, codex, gemini, etc.)
    pub cli: String,
    /// Current working directory
    pub cwd: String,
    /// Whether the agent is currently busy
    pub busy: bool,
    /// List of skills/capabilities
    pub skills: Vec<String>,
    /// Timestamp of last heartbeat
    pub last_seen: u64,
}

impl AgentCapabilities {
    pub fn new(agent_id: AgentId, cli: String, cwd: String) -> Self {
        Self {
            agent_id,
            cli,
            cwd,
            busy: false,
            skills: vec![],
            last_seen: SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
        }
    }
}

/// Messages broadcast to all agents via gossipsub
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AgentMessage {
    /// Agent announces its presence and capabilities
    Announce(AgentCapabilities),

    /// Agent is leaving the swarm
    Leave { agent_id: AgentId },

    /// Broadcast a new task for any agent to pick up
    TaskBroadcast {
        task_id: TaskId,
        prompt: String,
        requirements: Option<TaskRequirements>,
    },

    /// Agent claims a task
    TaskClaim {
        task_id: TaskId,
        agent_id: AgentId,
    },

    /// Task status update
    TaskUpdate {
        task_id: TaskId,
        status: TaskStatus,
    },

    /// Coordinator election message
    CoordinatorElection {
        agent_id: AgentId,
        /// Higher priority wins (based on uptime, capabilities, etc.)
        priority: u64,
    },

    /// Coordinator heartbeat
    CoordinatorHeartbeat {
        coordinator_id: AgentId,
        timestamp: u64,
    },

    /// General chat/log message
    Chat {
        agent_id: AgentId,
        message: String,
    },
}

/// Requirements for a task
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskRequirements {
    /// Required CLI (e.g., "claude", "codex")
    pub cli: Option<String>,
    /// Required skills
    pub skills: Vec<String>,
    /// Required working directory pattern
    pub cwd_pattern: Option<String>,
}

/// Direct request to a specific agent
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AgentRequest {
    /// Request agent status
    GetStatus,

    /// Request agent to execute a task
    ExecuteTask {
        task_id: TaskId,
        prompt: String,
    },

    /// Request agent to cancel current task
    CancelTask { task_id: TaskId },

    /// Ping for health check
    Ping,

    /// Request current task list
    GetTasks,

    /// Request to join as a worker under this coordinator
    JoinSwarm { capabilities: AgentCapabilities },
}

/// Response from an agent
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AgentResponse {
    /// Agent status
    Status(AgentCapabilities),

    /// Task accepted
    TaskAccepted { task_id: TaskId },

    /// Task rejected (agent busy or incapable)
    TaskRejected { task_id: TaskId, reason: String },

    /// Task cancelled
    TaskCancelled { task_id: TaskId },

    /// Pong response
    Pong { agent_id: AgentId },

    /// List of tasks
    Tasks { tasks: Vec<(TaskId, TaskStatus)> },

    /// Join accepted
    JoinAccepted { coordinator_id: AgentId },

    /// Join rejected
    JoinRejected { reason: String },

    /// Error response
    Error { message: String },
}

/// Codec for request-response protocol
#[derive(Debug, Clone)]
pub struct AgentCodec;

impl AgentCodec {
    pub fn new() -> Self {
        Self
    }
}

impl Default for AgentCodec {
    fn default() -> Self {
        Self::new()
    }
}
