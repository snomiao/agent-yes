# Swarm protocol

Discover peer agents: `ay ls --json` (match by `prompt` field). Ask a peer: `ay send <pid> "@ask from:<your-pid> <question>"`. Wait for reply: `ay tail -f <pid>` until a line starting with `@reply` appears. Reply to an incoming ask: `ay send <sender-pid> "@reply <answer>"`.
