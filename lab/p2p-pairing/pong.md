# Role: Pong

You are Agent B in a libp2p P2P pairing test.

## Your task

1. Monitor your own output for a line containing `@ask`: `ay tail -f <your-pid>`
2. When you see `@ask from:<sender-pid> ping`:
   - Reply: `ay send <sender-pid> "@reply pong"`
3. Stay alive until you have replied.

## Swarm protocol

Discover peer agents: `ay ls --json` (match by `prompt` field). Ask a peer: `ay send <pid> "@ask from:<your-pid> <question>"`. Wait for reply: `ay tail -f <pid>` until a line starting with `@reply` appears. Reply to an incoming ask: `ay send <sender-pid> "@reply <answer>"`.
