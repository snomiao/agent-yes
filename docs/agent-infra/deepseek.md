# DeepSeek: Harness (`dsh`) and DSec

> Status: **research notes**, 2026-10-07. Both projects are early previews; details
> come from press coverage and blog write-ups, not from running them. Overview:
> [README.md](./README.md).

DeepSeek released two unrelated things in 2026:

- **DeepSeek Harness**: an agent loop, in the same layer as Claude Code or Codex.
- **DSec**: a sandbox platform for RL training.

Neither is a k8s workspace provisioner. The useful parts are a design choice (where
the loop runs) and a security lesson (the CVE below).

## DeepSeek Harness (`dsh`)

- **Repo:** [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness),
  MIT. Public since 2026-08-13. Developer preview (v0.1): extension contracts and
  schemas may still break.
- **Run:** `npx @deepseek-ai/dsh web` (web UI on `localhost:3080`); headless and
  control-API modes also exist.
- **Architecture:** a micro-kernel on the **Cordis** plugin framework. "There is no
  privileged core to patch": every part is a plugin mounted beside the others:
  - the **agent loop** itself (step/turn engine);
  - **session storage** (an append-only event log);
  - the **LLM adapter** (DeepSeek built in; other providers through community
    plugins);
  - the **sandbox**: local subprocess, Docker, or remote/Kubernetes, plus third-party
    sandboxes over an MCP bridge;
  - **shell & filesystem**;
  - **UI**: web, headless, or control API.
- **Modes:** Standard (shell + web tools), Code (the model batches tool calls through
  an SDK), Minimal (persistent shell + editor), Creator (plugin testing).
- **Session model:** "model-visible means logged". Message history is _derived_ from
  the event log (`deriveMessages()`), which gives replay, resume and audit. This is
  the same idea as AX's event log ([google-ax.md](./google-ax.md)).

### Where the loop runs: remote everything, or remote tools only?

A runtime/sandbox plugin layer like dsh's lets you choose where the cut between local
and remote goes. There are two shapes:

```
 A. Remote the whole loop                    B. Local loop, remote tools
 ┌─ pod ─────────────────────────┐           ┌─ control plane (trusted) ─┐   ┌─ sandbox pod ─┐
 │ agent loop + model creds      │           │ agent loop + model creds  │──►│ shell / fs    │
 │ tools (shell, fs)             │           │ approval / policy         │◄──│ (no creds)    │
 │ workspace                     │           └───────────────────────────┘   │ workspace     │
 └──────────▲────────────────────┘                                           └───────────────┘
            │ UI / control only (ay serve)
```

|                                | A. Remote the whole loop (agent-yes today)                                               | B. Local loop, remote tools (dsh sandbox plugin, Agent Sandbox SDK)                |
| ------------------------------ | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Works with closed CLIs         | **Yes**: claude / codex / copilot run unmodified in the pod                              | **No**: needs a harness whose tool layer is pluggable (dsh, ADK, own loop)         |
| Model credentials              | In the pod (mitigate: Vertex/Bedrock identity, or a credential-injecting egress gateway) | **Never in the sandbox**                                                           |
| Control API reachable by agent | Yes, unless split UIDs / no listening port ([kubernetes.md](./kubernetes.md#security))   | No: the loop is on another host, so the CVE class below is structurally impossible |
| Survives client disconnect     | Yes (the loop lives with the workspace)                                                  | Loop host must stay up; the sandbox can be suspended between tool calls            |
| Idle cost                      | Pod idles while waiting on the model / human                                             | Sandbox can be released between tool calls; only the loop stays                    |
| Latency per tool call          | Local                                                                                    | A network round-trip per tool call                                                 |

**For agent-yes:**

- **Shape A is the main path.** agent-yes's value is wrapping _existing_ CLIs (PTY
  auto-yes, crash recovery, idle detection), and those CLIs don't expose a pluggable
  tool layer. So the whole wrapper + CLI goes into the pod
  ([kubernetes.md](./kubernetes.md)).
- **Borrow B's main benefit inside A: keep credentials out of the pod.**
  - Use keyless cloud identity (Vertex / Bedrock).
  - Or use an egress gateway that injects the model API key at the proxy, like AX's
    `Gateway` CRD. The pod then holds nothing worth stealing.
- **Shape B becomes possible for harnesses that support it.** If dsh is added as a
  supported CLI, agent-yes could run it in shape B:
  - `dsh` runs locally under `ay` (PTY, auto-yes and the fleet view all keep
    working);
  - its sandbox plugin targets a remote/k8s backend, e.g. an agent-sandbox
    `SandboxClaim`.
  - The open questions are whether dsh's remote plugin is stable enough, and whether
    a non-DeepSeek model adapter exists for the model we want.
- **Both shapes can share one provisioner.** The pod/claim creation in
  kubernetes.md is the same either way. Only _what runs in it_ differs: the whole
  `ay <cli>`, or a tool-execution endpoint.

### CVE-2026-82533: sandbox escape through the control API (CVSS 9.4)

- **Bug:** `isTrustedApiRequest` trusted a request when the client-supplied HTTP
  **`Host` header** looked local, instead of checking the real connection origin. A
  sandboxed agent could run one `curl` against the local control API and switch its
  session to unrestricted, no-approval execution. Default settings, no network
  exposure, no stolen credentials needed.
- **Affected:** ≤ 0.1.1-rc.2. **Fixed:** 0.1.2-alpha.1 (2026-08-27), which binds
  trust to a token + cookie issued at startup instead of a claimed origin.
- **CSA's broader point:** this was one of three 2026 incidents where "unchecked
  ambient authority" in a coding agent led to code execution.

**Lessons for agent-yes:**

1. **Never trust a claimed origin.** The `ay serve` code is already token-only:
   `ts/serve.ts` `checkAuth` / `authorizeRequest` ignore `Host` and the client
   address. Keep it that way, and don't let the optional "loopback without auth"
   desktop mode from [auth-and-permissions.md](../auth-and-permissions.md) reach any
   shared or containerised setup.
2. **The token is the next weak point.** It lives in
   `$AGENT_YES_HOME/.serve-token`, readable by the agent's own UID. In shape A the
   agent and `ay serve` must be split by UID, and the token must stay out of the
   agent's filesystem, env and argv ([kubernetes.md](./kubernetes.md#security)).
3. **Add a regression test**: a forged `Host: localhost` and no token must get 401
   on TS and Rust serve.
4. **Approval-mode changes are events.** Anything that relaxes approval (agent-yes's
   auto-yes, permission flags) should be logged and visible in the fleet view.

## DSec (DeepSeek Elastic Compute)

- **What:** the paper "DeepSeek Elastic Compute (DSec): A Sandbox Infrastructure for
  Effective Agentic Training at Scale" (Sept 2026, arXiv 2609.22978), plus an
  open-source release. It's the production sandbox platform behind DeepSeek's agentic
  **RL training**. It is not built to serve interactive workspaces.
- **Scale:** more than 5,000 new sandboxes per second. One cluster is about 160
  nodes, 30k cores and 250 TB RAM.
- **Isolation:** four levels behind one SDK (function call, container, microVM, full
  VM), **chosen per task** by its security requirements.
- **Scheduling:** gives out more CPU and memory than physically exists, with latency
  guarantees. Images load on demand from the **3FS** distributed filesystem.
- **Lifecycle:** sandbox state is bound to the training round (it persists across
  rollout steps) and idle resources are taken back.
- **Not found:** a repo URL, API docs and k8s integration in the write-ups surveyed.

**Lessons for agent-yes:** don't adopt it, because it's sized and shaped for training
farms. Two ideas are worth borrowing:

- **Isolation per spawn**: `isolation: container | gvisor | microvm` on
  `/api/spawn`, which becomes a k8s `runtimeClassName` (runc / gvisor / kata).
- **Bind lifetime to the work, reclaim idle**: the same idea as Agent Substrate.
  agent-yes's `idle` / `needs_input` detection is the trigger.

## Sources

- [InfoQ: The open-sourcing of DeepSeek Harness](https://www.infoq.com/news/2026/08/deep-seek-harness/)
- [The New Stack: DeepSeek open sources an agent harness where everything is a plugin](https://thenewstack.io/deepseek-harness-open-source-plugins/)
- [Sandbase: DeepSeek Harness setup, plugins & production limits](https://blog.sandbase.ai/deepseek-harness-developer-preview-2026/)
- [Digital Applied: DeepSeek open-sources Harness](https://www.digitalapplied.com/blog/deepseek-harness-open-source-agent-framework-2026)
- [CSA research note: DeepSeek Harness sandbox escape](https://labs.cloudsecurityalliance.org/research/csa-research-note-deepseek-harness-sandbox-escape-20260910-c/)
- [Lynxflow: DeepSeek open-sources DSec](https://blog.lynxflow.co/en/posts/deepseek-open-sources-dsec-elastic-compute-platform-generating-5-000-sandboxes/)
