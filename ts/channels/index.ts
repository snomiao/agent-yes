// Public surface of the channels core — imported by the CLI (ts/channels.ts),
// the serve daemon (Phase 2), and re-exported as the npm `agent-yes/channels`
// subpath + browser lib (Phase 3). Only isomorphic, dependency-free modules are
// re-exported here; the Node-only jsonl backend (store.node.ts) is imported
// directly by Node callers so a browser bundle never pulls in `fs`.

export * from "./hlc.ts";
export * from "./op.ts";
export * from "./store.ts";
export * from "./link.ts";
