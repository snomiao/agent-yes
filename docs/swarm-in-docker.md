# Running Agent Swarm in Docker

This guide shows how to run multiple agent-yes instances in Docker containers and have them discover each other via the swarm network.

## Quick Start

### 1. Build the Binary with Swarm Support

```bash
cd rs
cargo build --release --features swarm
```

### 2. Create a Docker Network

```bash
docker network create agent-swarm
```

### 3. Run Multiple Agents

**Agent 1:**
```bash
docker run -d --rm \
  --name agent-1 \
  --network agent-swarm \
  -v $(pwd)/target/release/agent-yes:/agent-yes:ro \
  debian:bookworm-slim \
  /agent-yes --swarm my-project
```

**Agent 2:**
```bash
docker run -d --rm \
  --name agent-2 \
  --network agent-swarm \
  -v $(pwd)/target/release/agent-yes:/agent-yes:ro \
  debian:bookworm-slim \
  /agent-yes --swarm my-project
```

### 4. Check Discovery

```bash
docker logs agent-1
docker logs agent-2
```

You should see peer discovery messages:
```
[+] Peer discovered: 12D3KooW...
```

## How It Works

When agents run on the same Docker network, they discover each other via **mDNS** (multicast DNS). This happens automatically when using the same `--swarm` topic.

```
┌─────────────────────────────────────────────────────────────┐
│                   Docker Network: agent-swarm               │
│                                                             │
│   ┌─────────────┐    mDNS     ┌─────────────┐              │
│   │   Agent 1   │◄──────────►│   Agent 2   │              │
│   │ 172.19.0.2  │             │ 172.19.0.3  │              │
│   │             │             │             │              │
│   └─────────────┘             └─────────────┘              │
│          ▲                           ▲                      │
│          │        mDNS               │                      │
│          └───────────┬───────────────┘                      │
│                      │                                      │
│              ┌───────▼───────┐                             │
│              │   Agent 3    │                              │
│              │ 172.19.0.4   │                              │
│              └──────────────┘                              │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Real Example Output

### Agent 1 Startup
```
$ docker logs agent-1

[INFO] agent-yes v1.51.4
[INFO] Starting swarm mode
[INFO]   Topic: docker-test
[INFO]   Room Code: PZM-VBB
[INFO] Creating swarm node: agent-fc45ef42
[INFO]   PeerId: 12D3KooWL2C1r9WfBQPmhoG2XwYQXpgoV2kdoPR22mtrtChysfpr

================================================================================
SWARM STARTED
================================================================================
Topic:     docker-test
Room Code: PZM-VBB
Peer ID:   12D3KooWL2C1r9WfBQPmhoG2XwYQXpgoV2kdoPR22mtrtChysfpr

Share with teammates:

  Same network (LAN):
    agent-yes --swarm docker-test

  Remote (Internet):
    agent-yes --swarm "ay://docker-test?peer=/ip4/172.19.0.2/tcp/46273/p2p/12D3KooW..."

  Short code:
    agent-yes --swarm PZM-VBB

================================================================================

[INFO] Listening on /ip4/172.19.0.2/tcp/46273/p2p/12D3KooWL2C1r9WfBQPmhoG2XwYQXpgoV2kdoPR22mtrtChysfpr
[WARN] Failed to trigger bootstrap: No known peers.

# After Agent 2 starts:
[INFO] Discovered peer via mDNS: 12D3KooWPUnxPU78aurC9ZQsTdSxVxKNhZVSoVFFkMx16X9FCTYV at /ip4/172.19.0.3/tcp/44533/p2p/...
[+] Peer discovered: 12D3KooWPUnxPU78aurC9ZQsTdSxVxKNhZVSoVFFkMx16X9FCTYV
```

### Agent 2 Startup (discovers Agent 1 instantly)
```
$ docker logs agent-2

[INFO] agent-yes v1.51.4
[INFO] Starting swarm mode
[INFO]   Topic: docker-test
[INFO]   Room Code: DD4-NCE
[INFO] Creating swarm node: agent-8ada9c3a
[INFO]   PeerId: 12D3KooWPUnxPU78aurC9ZQsTdSxVxKNhZVSoVFFkMx16X9FCTYV

================================================================================
SWARM STARTED
================================================================================
...

[INFO] Discovered peer via mDNS: 12D3KooWL2C1r9WfBQPmhoG2XwYQXpgoV2kdoPR22mtrtChysfpr at /ip4/172.19.0.2/tcp/46273/p2p/...
[+] Peer discovered: 12D3KooWL2C1r9WfBQPmhoG2XwYQXpgoV2kdoPR22mtrtChysfpr
```

## Connecting via ay:// URL

When mDNS isn't available (different networks), use the `ay://` URL:

```bash
# Agent 3 connects using Agent 1's address
docker run -d --rm \
  --name agent-3 \
  --network agent-swarm \
  -v $(pwd)/target/release/agent-yes:/agent-yes:ro \
  debian:bookworm-slim \
  /agent-yes --swarm "ay://docker-test?peer=/ip4/172.19.0.2/tcp/46273/p2p/12D3KooWL2C1r9WfBQPmhoG2XwYQXpgoV2kdoPR22mtrtChysfpr"
```

Output:
```
[INFO] Starting swarm mode
[INFO]   Topic: docker-test
[INFO]   Room Code: 4E3-E8H
[INFO]   Bootstrap peers: ["/ip4/172.19.0.2/tcp/46273/p2p/12D3KooW..."]
[INFO] Dialing bootstrap peer: /ip4/172.19.0.2/tcp/46273/p2p/12D3KooW...

================================================================================
SWARM STARTED
================================================================================
...

[+] Peer discovered: 12D3KooWPUnxPU78aurC9ZQsTdSxVxKNhZVSoVFFkMx16X9FCTYV
[+] Peer discovered: 12D3KooWL2C1r9WfBQPmhoG2XwYQXpgoV2kdoPR22mtrtChysfpr
```

## Docker Compose Example

```yaml
# docker-compose.swarm.yml
version: '3.8'

networks:
  swarm:
    driver: bridge

services:
  agent-1:
    image: debian:bookworm-slim
    networks:
      - swarm
    volumes:
      - ./rs/target/release/agent-yes:/agent-yes:ro
    command: /agent-yes --swarm my-project
    tty: true
    stdin_open: true

  agent-2:
    image: debian:bookworm-slim
    networks:
      - swarm
    volumes:
      - ./rs/target/release/agent-yes:/agent-yes:ro
    command: /agent-yes --swarm my-project
    tty: true
    stdin_open: true

  agent-3:
    image: debian:bookworm-slim
    networks:
      - swarm
    volumes:
      - ./rs/target/release/agent-yes:/agent-yes:ro
    command: /agent-yes --swarm my-project
    tty: true
    stdin_open: true
```

Run with:
```bash
docker-compose -f docker-compose.swarm.yml up
```

## Network Modes

### Bridge Network (Default)

Works out of the box with mDNS:
```bash
docker network create agent-swarm
docker run --network agent-swarm ...
```

### Host Network

Shares the host's network stack (mDNS works like bare metal):
```bash
docker run --network host ...
```

### Cross-Host (Docker Swarm / Kubernetes)

Use explicit peer addresses since mDNS won't work across hosts:
```bash
# On host A
docker run ... /agent-yes --swarm my-project
# Note the ay:// URL from output

# On host B
docker run ... /agent-yes --swarm "ay://my-project?peer=/ip4/<host-a-ip>/tcp/<port>/p2p/<peer-id>"
```

## Troubleshooting

### Peers not discovering each other

1. **Same Docker network?**
   ```bash
   docker network inspect agent-swarm
   ```
   Both containers should be listed.

2. **mDNS working?**
   mDNS requires multicast support. Bridge networks support this by default.

3. **Use explicit peer:**
   ```bash
   # Get peer address from agent-1 logs
   docker logs agent-1 | grep "Listening on"

   # Connect agent-2 using that address
   docker run ... /agent-yes --swarm "ay://topic?peer=/ip4/..."
   ```

### "No known peers" warning

This is normal for the first agent. It will discover peers once others join.

### Container exits immediately

Add `-it` for interactive mode or ensure the swarm keeps running:
```bash
docker run -it --rm ... /agent-yes --swarm my-project
```

## Cleanup

```bash
docker stop agent-1 agent-2 agent-3
docker network rm agent-swarm
```

## Production Considerations

1. **Persistent container names**: Use fixed names for predictable peer addresses
2. **Health checks**: Monitor `/status` command output
3. **Resource limits**: Set memory/CPU limits for containers
4. **Logging**: Configure log drivers for centralized logging
5. **Security**: Consider network policies to restrict swarm access
