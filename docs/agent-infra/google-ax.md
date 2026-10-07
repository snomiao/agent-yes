# Google AX (Agent Executor) and Agent Substrate

> Status: **research notes**, 2026-10-07. Sources are the upstream README/docs and
> press coverage; neither project has been run here. Overview:
> [README.md](./README.md).

## AX

- **What:** an Apache-2.0 "agentic orchestrator" / distributed agent runtime,
  [github.com/google/ax](https://github.com/google/ax) (site: agentexecutor.io).
  Announced 2026-05-20 (v0.1.0); featured at I/O on 2026-09-18.
- **Status:**
  - "in heavy development", with breaking changes expected before v1;
  - outside PRs temporarily paused (issues welcome);
  - the resumption protocol and runtime spec are still being refined.
- **Positioning:** a _serving layer around harnesses_. It is not a model, not an
  agent framework (LangGraph / CrewAI), and not a managed service. It handles failure
  recovery, approvals, audit, cost attribution and state consistency.

### Execution model

- **Event log + snapshots, one writer per session.** Every interaction is logged.
  Actors continue after a failure from the last snapshot.
- **Resume by sequence number.** A client reconnects at the last sequence it saw and
  only catches up on what it missed (`ax exec --conversation ID --last-seq 12
--resume`).
- **Fork.** Branch a new execution from any checkpoint.
- **Policy in the runtime.** Built-in planners can restrict tools (e.g. `bash`
  requires an approval flow) rather than relying on the prompt.
- **Protocols:** MCP, A2A, ADK, and a native AgentService. There are examples for
  native remote agents, ADK (Python) and Colab.

### Declarative API (`ax.io/v1alpha1`)

| CRD         | Purpose                                                                  | agent-yes equivalent today                              |
| ----------- | ------------------------------------------------------------------------ | ------------------------------------------------------- |
| `Task`      | One run: lifecycle + sandbox resource limits                             | an `ay <cli>` spawn                                     |
| `Workspace` | Environment assembly: git repos, MCP servers, skill bundles, setup steps | `/api/spawn` `from` / `fork` via `codehost/provision`   |
| `Gateway`   | Outbound allowlist (host/port) + **credential injection**                | none (`provisionAllowlist` only gates _what_ is cloned) |
| `Model`     | LLM provider params, runtime config, k8s secrets                         | per-CLI config + env API keys                           |

```yaml
apiVersion: ax.io/v1alpha1
kind: Workspace
metadata: { name: golang }
spec:
  git:
    - repo: https://github.com/golang/go.git
      branch: "my-fix"
---
apiVersion: ax.io/v1alpha1
kind: Task
metadata: { name: test }
spec:
  workspaces: [{ name: golang }]
  debug: true
```

- **CLI** (Go): `ax apply | get | describe | watch | delete | suspend | resume | ssh`.
- **Deploy:**
  - `go install github.com/google/ax/cmd/ax@latest`, then
    `make deploy AX_IMAGE_REPO=<registry>`;
  - built with `ko`; Redis runs in the `ax-system` namespace;
  - multi-cluster through kube contexts.
- **Requirements:** works on any k8s and even bare metal, but Google recommends
  running it on Agent Substrate, which must be installed first (`ate-system`; Control
  API at `api.ate-system.svc.cluster.local:443`).
- **Reported early issues:** dropped connections in the egress proxy, and
  "rudimentary" secrets handling.

## Agent Substrate

- **What:** the execution layer under AX: "dense actor multiplexing" for agents on
  k8s. Repo: [github.com/enj/substrate](https://github.com/enj/substrate) ("not an
  officially supported Google product"). Also offered on GKE.
- **Concepts:**
  - **Actor**: one running agent instance;
  - **ActorTemplate**: image, env and resources (one VM type per template);
  - **Worker**: a ready sandbox an Actor runs on;
  - **WorkerPool**: a pool of pre-started idle Workers.
- **How it works:**
  1. When an Actor goes idle, the system snapshots its **memory and files** to Cloud
     Storage and returns the Worker to the pool.
  2. A request addressed to that Actor restores it onto any warm Worker in under a
     second.
  3. Isolation is gVisor or Cloud Hypervisor.
  4. The demo runs ~250 stateful sessions on 8 pods (30× oversubscription).
- **Limits (GKE docs):**
  - GKE 1.36+ with beta flags, or 1.37+;
  - Workload Identity Federation required;
  - no mixed CPU architectures, no E2 machine types, no GPU passthrough;
  - **no egress policy support**;
  - **open network connections are not preserved across suspend**;
  - evaluation / non-production only; production by allowlist.

## How this maps onto agent-yes

**Why not build on AX now:**

- AX runs _harnesses_ it has connectors for. "Bring Your Own Harness" is roadmap,
  not product, and a coding-harness integration (Antigravity) is also roadmap.
- Claude Code / Codex wrapped by agent-yes's PTY layer have no supported way in yet.
- v0.1 APIs and the resume protocol are explicitly unstable.

**What to do now:**

1. **Match AX's names.** Shape the k8s spawn request
   ([kubernetes.md](./kubernetes.md#spawn-targets)) like `Workspace` + `Gateway`:
   - `git: [{repo, branch}]`
   - `mcp: [...]`
   - `egress: {allow: [...]}`
   - `resources`

   Then a future `target: "ax"` is a mechanical translation into `Workspace` +
   `Task`.

2. **Resume by offset.** `.raw.log` is already an append-only event stream. Let
   `ay serve` `tail` / SSE take a byte (or sequence) offset, so clients reconnect
   where they left off, which is AX's `--last-seq` idea. This also helps the k8s hub
   when a pod connection drops.
3. **Credential injection at egress.** AX's `Gateway` keeps the model key out of the
   sandbox. Same pattern as in [deepseek.md](./deepseek.md#where-the-loop-runs-remote-everything-or-remote-tools-only).

**Agent Substrate as a later GKE backend:**

- agent-yes already classifies agents as `active` / `idle` / `needs_input`. **Idle
  and needs-input are safe suspend points**: no model request is in flight, so the
  "open connections are dropped" limit costs nothing.
- An agent-yes ActorTemplate would be the same image as the agent-sandbox template.
  The wrapper's PTY and the agent's in-memory state are snapshotted together, and
  that is better than `--continue`, which re-reads the transcript.
- **Blocker:** Substrate has no egress policy, and our agents run auto-approved.
  Pair it with an egress proxy, or wait.

## Sources

- [github.com/google/ax](https://github.com/google/ax)
- [InfoQ: Google open-sources AX, a Kubernetes-style orchestrator for autonomous AI agents](https://www.infoq.com/news/2026/09/google-ax-orchestrator/)
- [Devlery: Google AX preview turns interrupted agents into resumable runtime work](https://devlery.com/en/blog/google-agent-executor-ax-runtime)
- [fratepietro: Google AX, a distributed agent runtime with durable execution](https://www.fratepietro.com/2026/google-ax-distributed-agent-runtime/)
- [Techzine: Google launches open-source runtime for AI agents](https://www.techzine.eu/news/devops/141577/google-launches-open-source-runtime-for-ai-agents/)
- [Forkast on AX](https://forkast.news/googles-open-agentic-orchestrator-hit-1-on-hacker-news-the-real-story-is-whats-running-underneath/)
- [GKE: About Agent Substrate](https://docs.cloud.google.com/kubernetes-engine/ai-ml/about-agent-substrate)
- [github.com/enj/substrate](https://github.com/enj/substrate)
- [Solo.io: How Google Agent Substrate works](https://www.solo.io/topics/ai-infrastructure/how-google-agent-substrate-works)
- [GKE: Isolate AI code execution with Agent Sandbox](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/agent-sandbox)
