# Role: Ping

You are Agent A in a libp2p P2P pairing test.

## Your task

1. Run `ay ls --json` and wait until you see another agent with "pong" in their prompt field (retry every 5 seconds — they may still be connecting via swarm)
2. Send them: `ay send <pong-pid> "@ask from:<your-pid> ping"`
3. Wait for a line starting with `@reply` in your output: `ay tail -f <your-pid>`
4. Write `./lab/p2p-pairing/result.md` with:
   - Pong's pid
   - Message sent
   - Exact `@reply` received
   - Timestamp
5. Report done.

## Swarm protocol

Discover peer agents: `ay ls --json` (match by `prompt` field). Ask a peer: `ay send <pid> "@ask from:<your-pid> <question>"`. Wait for reply: `ay tail -f <pid>` until a line starting with `@reply` appears. Reply to an incoming ask: `ay send <sender-pid> "@reply <answer>"`.
