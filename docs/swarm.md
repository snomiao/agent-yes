# Agent Swarm Mode (Experimental)

> **Status**: Experimental - APIs may change

Agent-yes supports peer-to-peer networking for multi-agent coordination using libp2p. Multiple agents can discover each other, broadcast tasks, and coordinate work without a central server.

## Quick Start

### 1. Build with Swarm Support

```bash
cd rs
cargo build --release --features swarm
```

### 2. Start Multiple Agents

**Terminal 1 - First Agent:**
```bash
./target/release/agent-yes --experimental-swarm --verbose
```

**Terminal 2 - Second Agent:**
```bash
./target/release/agent-yes --experimental-swarm --verbose
```

You should see peer discovery messages:
```
[INFO] Discovered peer via mDNS: 12D3KooW... at /ip4/192.168.1.x/tcp/xxxxx
```

### 3. Interactive Commands

Once running, you can use these commands:

```
/task <prompt>  - Broadcast a task to all agents
/chat <message> - Send a chat message to the swarm
/status         - Show swarm status (peers, coordinator)
/quit           - Exit swarm mode
```

## Demo Session

### Agent 1 (becomes coordinator)
```
$ agent-yes --experimental-swarm

[INFO] agent-yes v1.49.0
[INFO] Starting in experimental swarm mode
[INFO] Creating swarm node: agent-abc12345
[INFO] PeerId: 12D3KooWJkDD9hXoFhV3pfHJS2KHyfC8W5bxeaeuM4zSMfk8AMaG
[INFO] Listening on /ip4/192.168.1.100/tcp/45678/p2p/12D3KooWJkDD...

[Swarm Mode Commands]
  /task <prompt>  - Broadcast a task to the swarm
  /chat <msg>     - Send a chat message
  /status         - Get swarm status
  /quit           - Exit swarm mode

> [INFO] Discovered peer via mDNS: 12D3KooWQfP... at /ip4/192.168.1.101/tcp/34567
[+] Peer discovered: 12D3KooWQfPAymyVsieESfBb9PbXhiinBZrx7XLJq4j1qT1TweC4

> /status

[Status]
  Peers: 1
  Coordinator: You

> /task Refactor the authentication module to use JWT tokens

[Task] a1b2c3d4-e5f6-7890-abcd-ef1234567890: Refactor the authentication module...

> /chat Anyone available to help with the API tests?

[agent-abc12345] Anyone available to help with the API tests?
```

### Agent 2 (worker)
```
$ agent-yes --experimental-swarm

[INFO] agent-yes v1.49.0
[INFO] Starting in experimental swarm mode
[INFO] Creating swarm node: agent-def67890
[INFO] PeerId: 12D3KooWQfPAymyVsieESfBb9PbXhiinBZrx7XLJq4j1qT1TweC4

> [INFO] Discovered peer via mDNS: 12D3KooWJkD... at /ip4/192.168.1.100/tcp/45678
[+] Peer discovered: 12D3KooWJkDD9hXoFhV3pfHJS2KHyfC8W5bxeaeuM4zSMfk8AMaG
[*] New coordinator: agent-abc12345

> /status

[Status]
  Peers: 1
  Coordinator: agent-abc12345

[Task] a1b2c3d4-e5f6-7890-abcd-ef1234567890: Refactor the authentication module...

[agent-abc12345] Anyone available to help with the API tests?

> /chat I can help! Starting on the API tests now.
```

## CLI Options

| Option | Description | Default |
|--------|-------------|---------|
| `--experimental-swarm` | Enable swarm mode | `false` |
| `--swarm-topic <TOPIC>` | Gossipsub topic for communication | `agent-yes-swarm` |
| `--swarm-listen <ADDR>` | Listen address (multiaddr format) | `/ip4/0.0.0.0/tcp/0` |
| `--swarm-bootstrap <ADDR>` | Bootstrap peer address (repeatable) | none |
| `--verbose` | Enable debug logging | `false` |

## Network Topologies

### Local Network (mDNS)

On the same LAN, agents discover each other automatically via mDNS:

```
┌─────────────┐         ┌─────────────┐         ┌─────────────┐
│   Agent 1   │◄──mDNS──►│   Agent 2   │◄──mDNS──►│   Agent 3   │
│ 192.168.1.x │         │ 192.168.1.y │         │ 192.168.1.z │
└─────────────┘         └─────────────┘         └─────────────┘
```

### Internet (Bootstrap Peers)

For agents across the internet, use bootstrap peers:

```bash
# Agent 1 (public server with known address)
agent-yes --experimental-swarm \
  --swarm-listen /ip4/0.0.0.0/tcp/4001

# Agent 2 (connects via bootstrap)
agent-yes --experimental-swarm \
  --swarm-bootstrap /ip4/203.0.113.1/tcp/4001/p2p/12D3KooW...

# Agent 3 (also connects via bootstrap)
agent-yes --experimental-swarm \
  --swarm-bootstrap /ip4/203.0.113.1/tcp/4001/p2p/12D3KooW...
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Agent Swarm                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   ┌─────────────────┐                    ┌─────────────────┐   │
│   │   Coordinator   │                    │     Workers     │   │
│   │  agent-abc123   │                    │  agent-def456   │   │
│   │                 │    Task Broadcast  │  agent-ghi789   │   │
│   │  - Election     │◄──────────────────►│  agent-jkl012   │   │
│   │  - Task Queue   │                    │                 │   │
│   │  - Assignment   │    Status Updates  │  - Task Claim   │   │
│   │                 │◄──────────────────►│  - Execution    │   │
│   └─────────────────┘                    └─────────────────┘   │
│            │                                      │             │
│            └──────────────────┬───────────────────┘             │
│                               │                                 │
│                    ┌──────────▼──────────┐                     │
│                    │    libp2p Stack     │                     │
│                    ├─────────────────────┤                     │
│                    │  Gossipsub (pub/sub)│                     │
│                    │  Request-Response   │                     │
│                    │  Kademlia DHT       │                     │
│                    │  mDNS Discovery     │                     │
│                    │  TCP + Noise        │                     │
│                    └─────────────────────┘                     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Message Types

### Broadcast Messages (Gossipsub)

| Message | Description |
|---------|-------------|
| `Announce` | Agent advertises capabilities (CLI, cwd, skills) |
| `Leave` | Agent is leaving the swarm |
| `TaskBroadcast` | New task for agents to pick up |
| `TaskClaim` | Agent claims a task |
| `TaskUpdate` | Task status change (in_progress, completed, failed) |
| `CoordinatorElection` | Election participation message |
| `CoordinatorHeartbeat` | Coordinator liveness signal |
| `Chat` | General chat message |

### Direct Messages (Request-Response)

| Request | Response |
|---------|----------|
| `GetStatus` | Agent capabilities |
| `ExecuteTask` | Task accepted/rejected |
| `CancelTask` | Task cancelled |
| `Ping` | Pong |
| `GetTasks` | List of tasks |
| `JoinSwarm` | Join accepted/rejected |

## Coordinator Election

The swarm uses a simple priority-based election:

1. When no coordinator is known, agents broadcast `CoordinatorElection` messages
2. Each agent has a priority (based on startup timestamp)
3. After 3 seconds, the agent with highest priority becomes coordinator
4. Coordinator sends `CoordinatorHeartbeat` every 3 seconds
5. If heartbeat times out (10s), a new election starts

## Isolation with Topics

Use different topics to create isolated swarms:

```bash
# Development swarm
agent-yes --experimental-swarm --swarm-topic dev-team-alpha

# Production swarm
agent-yes --experimental-swarm --swarm-topic prod-agents

# Project-specific swarm
agent-yes --experimental-swarm --swarm-topic project-foo-agents
```

## Programmatic Usage (Future)

```rust
use agent_yes::swarm::{SwarmConfig, SwarmNode, SwarmCommand};
use tokio::sync::mpsc;

#[tokio::main]
async fn main() -> Result<()> {
    let config = SwarmConfig {
        topic: "my-agent-swarm".to_string(),
        cli: "claude".to_string(),
        ..Default::default()
    };

    let node = SwarmNode::new(config).await?;
    let (cmd_tx, cmd_rx) = mpsc::channel(100);
    let (event_tx, mut event_rx) = mpsc::channel(100);

    // Spawn node
    tokio::spawn(node.run(cmd_rx, event_tx));

    // Broadcast a task
    cmd_tx.send(SwarmCommand::BroadcastTask {
        prompt: "Fix all TODO comments in the codebase".to_string(),
    }).await?;

    // Handle events
    while let Some(event) = event_rx.recv().await {
        match event {
            SwarmEvent2::TaskReceived { task_id, prompt } => {
                println!("Received task {}: {}", task_id, prompt);
            }
            SwarmEvent2::PeerDiscovered { peer_id } => {
                println!("New peer: {}", peer_id);
            }
            _ => {}
        }
    }

    Ok(())
}
```

## Troubleshooting

### Peers not discovering each other

1. **Same network?** mDNS only works on the same LAN
2. **Firewall?** Ensure UDP 5353 (mDNS) and your TCP port are open
3. **Docker/VM?** May need `--network host` or bridge networking
4. **Use bootstrap:** For cross-network, use `--swarm-bootstrap`

### "InsufficientPeers" warning

This is normal when starting alone. The warning clears once peers connect.

### Connection refused

Check that the peer address includes the full multiaddr with peer ID:
```
/ip4/192.168.1.100/tcp/4001/p2p/12D3KooWJkDD9hXoFhV3pfHJS2KHyfC8W5bxeaeuM4zSMfk8AMaG
                                 └─────────────────────────────────────────────────────┘
                                                    PeerId is required!
```

## Limitations

- **Experimental**: APIs and behavior may change
- **No persistence**: Tasks and state are in-memory only
- **No authentication**: Any peer can join the swarm
- **No encryption at rest**: Messages are encrypted in transit only
- **Task execution**: Currently broadcasts only; execution integration is WIP

## Future Roadmap

- [ ] Task execution integration with agent CLI
- [ ] Persistent task queue (SQLite/Redis)
- [ ] Peer authentication (signed identities)
- [ ] Web dashboard for swarm monitoring
- [ ] QUIC transport for better NAT traversal
- [ ] Task result aggregation
- [ ] Load balancing strategies
