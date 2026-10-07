# agent-yes on Kubernetes (GKE / EKS / any cluster)

> Status: **design draft — not implemented.** YAML below is a sketch: field names
> follow the upstream docs as of Oct 2026 and have not been applied to a cluster.
> Overview and alternatives: [README.md](./README.md).

## Goal

`POST /api/spawn {from: "owner/repo@branch", cli, prompt}` should be able to start
the agent in a **new isolated pod**, with its own:

- workspace volume;
- credentials;
- CPU/memory limits;
- outbound network policy.

`ls` / `send` / `tail` / the web UI should keep working across all those pods as if
they were local.

## What carries over, what breaks

agent-yes has no central daemon. Wrappers coordinate through **files on one host**
([architecture.md](../architecture.md#process-model--ipc)):

| Mechanism                          | Inside one pod | Across pods                                      |
| ---------------------------------- | -------------- | ------------------------------------------------ |
| `$AGENT_YES_HOME/pids.jsonl` index | works          | not visible → hub must aggregate                 |
| FIFO `fifo/<pid>.stdin` for `send` | works          | not reachable → `send` goes over HTTP to the pod |
| `<cwd>/.agent-yes/<pid>.raw.log`   | works          | not visible → `tail` goes over HTTP to the pod   |
| Reaper (`reaper.jsonl`, pgid kill) | works          | n/a: pod deletion is the reaper                  |
| `ay serve` stateless observer      | works          | becomes the per-pod API; a hub fans out to many  |

So the model is: **one pod = one agent-yes host.** Nothing changes inside the pod.
The only new pieces are a spawn target that creates pods and a hub that talks to them.

## Architecture

```
            ┌──────────── hub: ay serve (fleet view, holds the k8s client) ────────────┐
 POST /api/spawn {from, cli, prompt, target: "k8s"}                                    │
            │ 1. allowlist / provisionHook gate (unchanged, runs on the hub)            │
            │ 2. create SandboxClaim (or Pod) labelled agent-yes/*                      │
            ▼                                                                           │
 ┌─ workspace pod ── runtimeClassName: gvisor | kata ─────────────────────────┐        │
 │ init  provision:   codehost provision → /ws/<owner>/<repo>/tree/<branch>    │        │
 │ main  agent:       ay <cli> -- <prompt>        (uid 1000, no token)         │◄───────┘
 │ side  ay-serve:    ay serve --token $TOKEN     (uid 1001, token Secret)     │ ls/send/tail
 │ vols  /ws (PVC), /agent-yes-home (PVC, group-shared), token (sidecar only) │  over HTTP
 └────────────────────────────────────────────────────────────────────────────┘
```

### Spawn targets

Add a `target` to `/api/spawn`, with `local` as the default (today's path):

- **`local`**: unchanged.
- **`k8s`**: the hub runs the existing gate (allowlist / `provisionHook`), then turns
  the request into a `SandboxClaim` from a template, or a bare Pod on clusters without
  agent-sandbox. Request fields map as follows:
  - `from` / `fork` → init-container args;
  - `cli` + `prompt` → main-container args;
  - owner / repo / branch / requesting agent → labels (`agent-yes/repo`,
    `agent-yes/branch`, `agent-yes/parent`).
- **Later, `ax`**: translate the same request into AX `Workspace` + `Task`
  ([google-ax.md](./google-ax.md)).

Shape the request so the mapping to AX stays trivial:

- `git: [{repo, branch}]`
- `mcp: [...]`
- `egress: {allow: [host:port]}`
- `resources: {cpu, memory}`
- `isolation: container | gvisor | microvm`

### Hub aggregation

- **`ay ls` / web UI:** merge the local `pids.jsonl` with `GET /api/agents` from each
  pod. Pods are found with a label selector (`agent-yes/managed=true`).
- **`ay send <kw>` / `tail`:** resolve the keyword to `(pod, pid)`, then use the pod's
  `ay serve` HTTP API instead of a FIFO.
- **Connection to pods:** start with in-cluster Service DNS per pod. agent-sandbox
  already gives each Sandbox a stable hostname and a router. A pod-initiated reverse
  tunnel to the hub is the stricter option (see Security).

## Isolation, per provider

| Concern                  | GKE                                                        | EKS                                                                                                                         | kind / other                   |
| ------------------------ | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Sandbox runtime          | GKE Sandbox (gVisor) node pool, `runtimeClassName: gvisor` | Install gVisor or Kata yourself (Kata needs bare-metal / nested-virt nodes); or **Fargate** (one microVM per pod, EFS only) | gVisor / Kata installed by you |
| agent-sandbox controller | **Managed** GKE feature                                    | Open-source controller                                                                                                      | Open-source controller         |
| Model auth without keys  | Claude on **Vertex AI** + Workload Identity                | Claude on **Bedrock** + EKS Pod Identity                                                                                    | API-key Secret                 |
| Egress allowlist         | FQDN network policy (Dataplane V2)                         | Cilium FQDN policy, or an egress proxy                                                                                      | Cilium / egress proxy          |
| Workspace volume         | PD / Filestore                                             | EBS / EFS (Fargate: EFS)                                                                                                    | local-path                     |
| Idle suspend             | Agent Substrate (preview, see google-ax.md)                | not available → scale-to-zero by deleting idle pods                                                                         | same as EKS                    |

### Credentials

- Claude subscription OAuth credentials are tied to a machine and don't belong in a
  pod. `examples/gcp.sh` already requires an API key for Cloud Run for this reason.
- Prefer **cloud-provider identity** (Vertex / Bedrock), so no long-lived model key
  exists in the pod at all.
- Or use a **credential-injecting egress gateway**: the pod sends requests to the
  model API without a key, and the proxy adds it. This is AX's `Gateway` pattern,
  and it gives the "loop local, tools remote" security benefit while keeping
  closed CLIs in the pod ([deepseek.md](./deepseek.md#where-the-loop-runs-remote-everything-or-remote-tools-only)).
- Otherwise use one k8s Secret per tenant, mounted **only** into the agent container.
- Git push credentials: per-repo deploy keys or a short-lived GitHub App token minted
  by the hub at spawn time. This takes the role `provisionHook` plays on the desktop
  ("pick the identity per owner").

## Sketch manifests (agent-sandbox)

```yaml
apiVersion: extensions.agents.x-k8s.io/v1beta1
kind: SandboxTemplate
metadata:
  name: agent-yes-claude
spec:
  podTemplate:
    metadata:
      labels: { agent-yes/managed: "true" }
    spec:
      runtimeClassName: gvisor
      automountServiceAccountToken: false
      shareProcessNamespace: false # sidecar argv/env must stay invisible to the agent
      securityContext: { fsGroup: 2000 } # shared group for /agent-yes-home
      initContainers:
        - name: provision
          image: ghcr.io/snomiao/agent-yes:latest
          command: ["codehost", "provision"] # args filled per claim: owner/repo@branch
          volumeMounts: [{ name: ws, mountPath: /ws }]
      containers:
        - name: agent
          image: ghcr.io/snomiao/agent-yes:latest
          securityContext: { runAsUser: 1000, runAsNonRoot: true }
          env:
            - { name: AGENT_YES_HOME, value: /agent-yes-home }
            - { name: CLAUDE_CODE_USE_VERTEX, value: "1" } # or Bedrock / API-key Secret
          resources: { limits: { cpu: "2", memory: 4Gi } }
          volumeMounts:
            - { name: ws, mountPath: /ws }
            - { name: home, mountPath: /agent-yes-home }
        - name: ay-serve
          image: ghcr.io/snomiao/agent-yes:latest
          securityContext: { runAsUser: 1001, runAsNonRoot: true }
          args: ["serve", "--no-rust", "--token-file", "/run/ay/token"] # see open question 1
          env: [{ name: AGENT_YES_HOME, value: /agent-yes-home }]
          volumeMounts:
            - { name: home, mountPath: /agent-yes-home }
            - { name: ws, mountPath: /ws, readOnly: true }
            - { name: token, mountPath: /run/ay, readOnly: true } # NOT mounted in `agent`
      volumes:
        - { name: token, secret: { secretName: ay-serve-token, defaultMode: 0400 } }
        # ws / home: PVCs via volumeClaimTemplates on the Sandbox
---
apiVersion: extensions.agents.x-k8s.io/v1beta1
kind: SandboxWarmPool
metadata: { name: agent-yes-claude }
spec:
  replicas: 3
  sandboxTemplateRef: { name: agent-yes-claude }
```

With a warm pool, a spawn only has to claim a pod and clone the repo. Image pull and
agent-yes startup are already done.

## Security

The trust boundary moves. On the desktop, the agent already runs as the same user as
`ay serve`. In a pod we can, and should, do better.

**What the code does today** (checked 2026-10-07):

- `ts/serve.ts` `checkAuth` / `authorizeRequest` accept **only** the token, as a
  bearer header or `?token=`. They never trust the `Host` header or the client
  address. So the DeepSeek Harness bug class (trusting a `Host: localhost` claim, see
  [deepseek.md](./deepseek.md)) does not apply as written.
- The token is persisted at `$AGENT_YES_HOME/.serve-token` (mode 0600), by
  `ts/serve.ts` `loadOrCreateToken` and `rs/src/serve/api.rs`
  `load_or_create_token`.
- In a pod where the agent and `ay serve` share `AGENT_YES_HOME` **and a UID**, the
  agent can read the token. It could then call the sidecar's `/api/spawn` or
  `/api/send` over the pod's shared localhost.

**Rules for the k8s target:**

1. **Separate UIDs.** The agent runs as 1000 and `ay serve` as 1001. The token comes
   from a Secret mounted only into the sidecar. It is never written under
   `AGENT_YES_HOME`, and never passed on argv or env visible to the agent
   (`shareProcessNamespace: false`).
2. **Shared state through a group, not a user.** `pids.jsonl`, the FIFOs and the logs
   need group read/write via `fsGroup`. The `.serve-token` path must not exist in the
   shared home.
3. **No loopback-without-auth** (the optional desktop mode in
   [auth-and-permissions.md](../auth-and-permissions.md)) on this target, ever.
4. **Stricter option: no listening port.** The sidecar dials _out_ to the hub
   (WebSocket or the existing WebRTC transport). The agent then has nothing to
   connect to.
5. **Egress allowlist.** Allow only the model endpoint, GitHub and package registries.
   Agents run auto-approved, so this is the main thing that limits prompt injection.
6. **Gate on the hub.** The `provisionAllowlist` / `provisionHook` check runs on the
   hub before any pod exists. The pod's own `ay serve` should refuse `/api/spawn`
   (`target: k8s` only from the hub).
7. **Regression test:** a request with `Host: localhost` and no token, or a wrong
   token, gets 401 from both TS and Rust serve.

## Lifecycle

- **Pod restart:** PVCs keep `/ws` and `AGENT_YES_HOME`, so logs and session ids
  survive. The agent restarts with `--continue`. The crash-recovery path already
  exists for this.
- **Done / idle:** with `--exit-on-idle`, the wrapper exits and the hub deletes the
  claim; the PVC is kept for N days for inspection. Without it, `idle` /
  `needs_input` stays visible in the hub and a human decides.
- **Scale-to-zero without Substrate:** delete idle pods but keep their PVCs, then
  respawn with `--continue` on the next `send`. This costs a cold start of a few
  seconds with a warm pool. Substrate (GKE) would make it sub-second and keep the
  in-memory state.

## Phased plan

1. **kind + bare Pod.** Add `target: k8s` to `/api/spawn`, an init-container
   provision step and labels. The hub `ls` merges pods. `send` / `tail` go over HTTP.
2. **Token hardening.** Add `--token-file` (or env) to TS and Rust serve, separate
   UIDs, and the 401 regression test. Worth landing for `--share` / Docker even
   without k8s.
3. **agent-sandbox.** Template + warm pool + claim. Test on kind, then GKE (managed)
   and EKS (open-source controller).
4. **Keyless model auth + egress policy** on GKE (Vertex) and EKS (Bedrock).
5. **Optional:** `isolation` per spawn (runtimeClass), Substrate suspend on GKE, an
   `ax` target.

## Open questions

1. **Token from a file.** TS `ay serve` has `--token TOKEN`, but a token on argv is
   visible in `ps` inside the container. Rust serve always uses `.serve-token`. Both
   need a `--token-file` (or `AGENT_YES_SERVE_TOKEN_FILE`) that reads but never
   writes. Until then the sidecar has to run `--no-rust`.
2. **One pod per agent, or per workspace?** Several agents in one pod share the
   workspace and the FIFO setup for free. Separate pods give each agent its own
   limits. Suggested default: one pod per spawned _workspace_; sub-agents a pod agent
   spawns stay local to that pod unless they ask for `target: k8s`.
3. **Where the hub runs.** In-cluster (simple RBAC, Service DNS), or on the desktop
   with a kubeconfig (one fleet view across laptop + cluster). `remotes.ts` /
   `webrtcRemote.ts` may already cover the desktop-to-pod transport.
