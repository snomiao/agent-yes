# Agent infrastructure: running agent-yes beyond one host

> Status: **research + design draft — nothing here is implemented.** Written
> 2026-10-07. The external projects surveyed are all pre-1.0 and moving fast;
> re-check versions before acting on any of it.

agent-yes today runs every agent on **one host**. Wrappers coordinate through files
(`pids.jsonl`, per-pid FIFOs, `<cwd>/.agent-yes/*.raw.log`; see
[architecture.md](../architecture.md#process-model--ipc)). `POST /api/spawn` prepares
the workspace through `codehost/provision` (see [provisioning.md](../provisioning.md)).
This folder looks at how to turn "spawn an agent" into "provision a new isolated
workspace + resources on a cluster". It also surveys the agent-infra projects
released in 2026 that overlap with that goal.

## Files

| File                             | What it covers                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [kubernetes.md](./kubernetes.md) | **The design**: agent-yes on k8s (GKE / EKS / any cluster), built on `kubernetes-sigs/agent-sandbox`          |
| [google-ax.md](./google-ax.md)   | Google **AX** (Agent Executor) + **Agent Substrate**: what they are, how they map onto agent-yes, why not yet |
| [deepseek.md](./deepseek.md)     | DeepSeek **Harness** (+ CVE-2026-82533) and **DSec**: what they are, the lessons for agent-yes                |

## Landscape at a glance

| Project                         | Layer                                            | Maturity (Oct 2026)                          | Use for agent-yes                                       |
| ------------------------------- | ------------------------------------------------ | -------------------------------------------- | ------------------------------------------------------- |
| `kubernetes-sigs/agent-sandbox` | Pod lifecycle, warm pools, gVisor/Kata isolation | SIG Apps subproject; managed on GKE          | **Build on it now** ([kubernetes.md](./kubernetes.md))  |
| Google AX                       | Durable task runtime (event log, resume, fork)   | v0.1.x, breaking changes, outside PRs paused | Match its names now, add a backend later                |
| Google Agent Substrate          | Suspend/resume idle agents, many actors per pod  | GKE 1.36+, evaluation/non-prod only          | Later: agent-yes idle detection is the suspend trigger  |
| DeepSeek Harness (`dsh`)        | An agent loop (peer of claude / codex)           | Developer preview                            | Maybe a `SUPPORTED_CLIS` entry; **take the CVE lesson** |
| DeepSeek DSec                   | Sandbox farm for RL training                     | Paper + release, needs a ~160-node cluster   | Borrow the per-spawn isolation idea only                |

## Recommendation

1. **Treat one pod as one agent-yes host.** Keep the file-based coordination
   unchanged _inside_ the pod and add a thin layer _between_ pods:
   - a `k8s` target behind `/api/spawn`;
   - a hub `ay serve` that discovers pods by label and proxies `ls` / `send` / `tail`
     to them.
2. **Use agent-sandbox** for isolation and fast spawn (`SandboxWarmPool`). On GKE it
   is managed; on EKS / kind you install the open-source controller.
3. **Don't build on AX yet.** It can't run our harness, because "Bring Your Own
   Harness" is still on its roadmap, and the API will break. Do shape the spawn
   request like AX's `Workspace` + `Gateway`, so an `ax` backend later is just a
   translation.
4. **Fix the token trust boundary first.** This is the DeepSeek lesson, and it
   matters on the desktop too:
   - **Today:** the serve token lives in `~/.agent-yes/.serve-token`, owned by the
     agent's own user.
   - **In a pod:** the agent must not be able to read the token or reach the control
     port.

## Where the agent loop runs

Two shapes are possible ([deepseek.md](./deepseek.md#where-the-loop-runs-remote-everything-or-remote-tools-only)):

- **A. Remote the whole loop.** `ay <cli>` and the workspace both live in the pod;
  only UI/control crosses the network. This is the only shape that works with
  closed CLIs (claude, codex, …), so it's the main path.
- **B. Keep the loop local, run only the tools remotely.** This is the dsh
  sandbox-plugin / Agent Sandbox SDK shape. Credentials never enter the sandbox, but
  it needs a harness with a pluggable tool layer: dsh, ADK, or our own loop.

Take B's main benefit into A by keeping credentials out of the pod:

- keyless Vertex / Bedrock identity, or
- an egress gateway that injects the model key (AX `Gateway`).

## Shared ideas worth adopting, whatever the backend

- **Resume by offset.** Tailing `.raw.log` already acts as an event log. Exposing a
  byte or sequence offset on `ay serve` streams gives AX-style "reconnect from seq N"
  almost for free.
- **Idle detection as a signal.** `idle` / `needs_input` is exactly what
  Substrate-style suspend (and plain scale-to-zero) needs. Idle means no model request
  is in flight, so suspending loses nothing.
- **Isolation per spawn.** The DSec idea: `isolation: container | gvisor | microvm`
  on `/api/spawn`, which becomes a k8s `runtimeClassName`. Trusted repos get a cheap
  container and unknown repos get a microVM.
