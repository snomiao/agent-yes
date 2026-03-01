# Agent Swarm Mode (Experimental)

> **Status**: Experimental - APIs may change

Agent-yes supports peer-to-peer networking for multi-agent coordination using libp2p. Multiple agents can discover each other, broadcast tasks, and coordinate work without a central server.

## Quick Start

### 1. Build with Swarm Support

```bash
cd rs
cargo build --release --features swarm
```

### 2. Start a Swarm

```bash
# Simple: just specify a topic name
agent-yes --swarm my-project
```

This will:
- Start listening for connections
- Enable mDNS for LAN discovery
- Generate a shareable room code
- Print connection info for teammates

### 3. Join the Swarm

**Same network (LAN)** - peers auto-discover via mDNS:
```bash
agent-yes --swarm my-project
```

**Remote (Internet)** - use the ay:// URL:
```bash
agent-yes --swarm "ay://my-project?peer=/ip4/203.0.113.1/tcp/4001/p2p/12D3KooW..."
```

**Short code** - easy to share verbally:
```bash
agent-yes --swarm ABC-234
```

## Connection Formats

The `--swarm` flag intelligently parses different value formats:

| Format | Example | Use Case |
|--------|---------|----------|
| Topic name | `--swarm my-project` | LAN auto-discovery via mDNS |
| Room code | `--swarm ABC-234` | Easy verbal sharing (6-char) |
| Swarm URL | `--swarm "ay://topic?peer=..."` | Internet sharing (like magnet links) |
| Multiaddr | `--swarm "/ip4/.../p2p/..."` | Direct connection to a peer |
| No value | `--swarm` | Uses default topic `agent-yes-swarm` |

### Room Codes

Room codes are 6-character codes (format: `XXX-XXX`) that are:
- Generated fresh each session
- Case-insensitive
- No ambiguous characters (0/O, 1/I/L excluded)
- Published to DHT for resolution
- Easy to share verbally over a call

### Swarm URLs (ay://)

Similar to magnet links, swarm URLs encode topic and peer information:

```
ay://my-project
ay://my-project?peer=/ip4/203.0.113.1/tcp/4001/p2p/12D3KooW...
ay://team?peer=/ip4/1.2.3.4/tcp/4001/p2p/QmA&peer=/ip4/5.6.7.8/tcp/4001/p2p/QmB
```

## Startup Output

When the swarm starts, it prints shareable connection info:

```
================================================================================
SWARM STARTED
================================================================================
Topic:     my-project
Room Code: UMK-YD6
Peer ID:   12D3KooWLLwuYVrCRVnqa8ZNNzJBb9Wr3ceo6soer9qh8HJ2dNkD

Share with teammates:

  Same network (LAN):
    agent-yes --swarm my-project

  Remote (Internet):
    agent-yes --swarm "ay://my-project?peer=/ip4/10.146.0.10/tcp/38951/p2p/12D3KooW..."

  Short code:
    agent-yes --swarm UMK-YD6

================================================================================
```

## Demo Session

### Agent 1 (becomes coordinator)
```
$ agent-yes --swarm dev-team

[INFO] agent-yes v1.51.4
[INFO] Starting swarm mode
[INFO]   Topic: dev-team
[INFO]   Room Code: PRJ-482
[INFO] Creating swarm node: agent-abc12345
[INFO] PeerId: 12D3KooWJkDD9hXoFhV3pfHJS2KHyfC8W5bxeaeuM4zSMfk8AMaG

================================================================================
SWARM STARTED
================================================================================
Topic:     dev-team
Room Code: PRJ-482
...
================================================================================

[Swarm Mode Commands]
  /task <prompt>  - Broadcast a task to the swarm
  /chat <msg>     - Send a chat message
  /status         - Get swarm status
  /quit           - Exit swarm mode

> [+] Peer discovered: 12D3KooWQfPAymyVsieESfBb9PbXhiinBZrx7XLJq4j1qT1TweC4

> /status

[Status]
  Peers: 1
  Coordinator: You

> /task Refactor the authentication module to use JWT tokens

[Task] a1b2c3d4-e5f6-7890-abcd-ef1234567890: Refactor the authentication module...
```

### Agent 2 (worker, same LAN)
```
$ agent-yes --swarm dev-team

[INFO] agent-yes v1.51.4
[INFO] Starting swarm mode
[INFO]   Topic: dev-team
[INFO]   Room Code: XYZ-789
[INFO] Creating swarm node: agent-def67890

> [+] Peer discovered: 12D3KooWJkDD9hXoFhV3pfHJS2KHyfC8W5bxeaeuM4zSMfk8AMaG
[*] New coordinator: agent-abc12345

> /status

[Status]
  Peers: 1
  Coordinator: agent-abc12345

[Task] a1b2c3d4-e5f6-7890-abcd-ef1234567890: Refactor the authentication module...
```

### Agent 3 (worker, remote via room code)
```
$ agent-yes --swarm PRJ-482

[INFO] Looking up room code PRJ-482 in DHT...
[INFO] Resolved room code to peer: /ip4/192.168.1.100/tcp/4001/p2p/12D3KooWJkDD...
[INFO] Dialing bootstrap peer: /ip4/192.168.1.100/tcp/4001/p2p/12D3KooWJkDD...

> [+] Peer discovered: 12D3KooWJkDD9hXoFhV3pfHJS2KHyfC8W5bxeaeuM4zSMfk8AMaG
[*] New coordinator: agent-abc12345
```

## CLI Options

### New Simplified API

| Option | Description | Example |
|--------|-------------|---------|
| `--swarm [VALUE]` | Enable swarm mode with optional config | `--swarm my-project` |

VALUE can be:
- Topic name: `my-project`
- Room code: `ABC-234`
- Swarm URL: `ay://topic?peer=...`
- Multiaddr: `/ip4/.../tcp/.../p2p/...`
- Omitted: uses default topic `agent-yes-swarm`

### Deprecated Flags (still work for backwards compatibility)

| Option | Replacement |
|--------|-------------|
| `--experimental-swarm` | `--swarm` |
| `--swarm-topic <TOPIC>` | `--swarm <TOPIC>` |
| `--swarm-listen <ADDR>` | Use ay:// URL with listen param |
| `--swarm-bootstrap <ADDR>` | `--swarm "ay://topic?peer=<ADDR>"` |

## Network Topologies

### Local Network (mDNS)

On the same LAN, agents discover each other automatically via mDNS:

```
┌─────────────┐         ┌─────────────┐         ┌─────────────┐
│   Agent 1   │◄──mDNS──►│   Agent 2   │◄──mDNS──►│   Agent 3   │
│ 192.168.1.x │         │ 192.168.1.y │         │ 192.168.1.z │
└─────────────┘         └─────────────┘         └─────────────┘
```

Just use the same topic:
```bash
agent-yes --swarm my-project
```

### Internet (ay:// URLs or Room Codes)

For agents across the internet:

```bash
# Agent 1 starts and notes the ay:// URL
agent-yes --swarm my-project
# ... prints ay://my-project?peer=/ip4/203.0.113.1/tcp/4001/p2p/12D3KooW...

# Agent 2 connects using the URL
agent-yes --swarm "ay://my-project?peer=/ip4/203.0.113.1/tcp/4001/p2p/12D3KooW..."

# Or use the room code (if DHT reachable)
agent-yes --swarm PRJ-482
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
agent-yes --swarm dev-team-alpha

# Production swarm
agent-yes --swarm prod-agents

# Project-specific swarm
agent-yes --swarm project-foo-agents
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
        room_code: Some("ABC-234".to_string()),
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
4. **Use ay:// URL:** For cross-network, share the ay:// URL from startup output

### Room code not resolving

Room codes require DHT connectivity to other peers. For the first connection, use:
- Same topic on the same LAN (mDNS)
- Full ay:// URL with peer address

Once connected, room codes work via DHT.

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
