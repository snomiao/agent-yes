# Provisioning & Spawn-From (design draft)

> Status: **design only — not implemented.** Captures the thinking from a design
> discussion so we can resume later. Open decisions are marked **DEFERRED**.

## Problem

Creating a new agent fails or is useless when the target working directory is
missing or empty.

Today, `POST /api/spawn` (`ts/serve.ts`) does:

```ts
const cwd = body.cwd || process.cwd();
Bun.spawn([...ayCmd, cli, ...], { cwd, ... });
```

- **cwd does not exist** → `Bun.spawn` throws `ENOENT` → HTTP 500.
- **cwd exists but is empty** → the agent spawns but has nothing to work on (no
  repo, no files).

We want a way to _prepare_ the working directory before the agent launches —
clone a repo, add a git worktree, create the dir, fetch context from a chat
message, install deps, or just `mkdir -p` — configurable **per machine**.

## Why per-peer (`~/.agent-yes/`)

Provisioning runs on **the machine where the agent spawns**. The console
aggregates many peers/rooms, but each peer's `ay serve` prepares its own cwd
locally. So provisioning is inherently host-local: each host keeps its own
config under `~/.agent-yes/`. Peers should **not** sync provisioning scripts to
each other (that would be both pointless and dangerous).

## North star: "source → ready cwd" resolver chain

The key reframing from the discussion: **do not center the design on GitHub.**
Many users never touch GitHub — they spin up a random directory, or start from a
Slack channel/message, or something else entirely. GitHub is just _one_ plugin.

The core only understands: **a `source` string → (a resolver) → a ready `cwd`**
(optionally also a `cli` and a `prompt`). The dumbest resolver (a plain
directory) needs **zero configuration**.

A spawn request carries `{ from?, cwd?, cli?, prompt? }`. Producing the cwd:

### Layer 0 — built-in, zero config (the non-technical default)

If `from` looks like a path (or is empty), `mkdir -p` it and use it.

- Empty `from` → the host's default workspace root.
- A bare folder name / path → created if missing.

This covers "just spin up a random dir" with no setup at all.

### Layer 1 — resolver chain (optional plugins)

If `from` is not a path, try the user's resolvers in order; the first one that
**claims** the source returns `{ cwd, prompt?, cli? }` after doing whatever
preparation it needs (clone / worktree / fetch). All shipped resolvers are
**samples, none mandatory**:

- `github` (the technical default): a GitHub URL or `owner/repo@branch` →
  `git worktree add` / clone under `~/ws/...`.
- `slack`: a Slack message/channel URL → fetch via the user's `slack` CLI,
  extract the task, prepare a cwd, optionally prefill the `prompt`.
- user-authored: Chatwork, Notion, Jira, internal tooling — anything.

### Layer 2 — nothing matched

Return a helpful error: the source is neither a path nor claimed by any
resolver.

### Orthogonal: lifecycle hooks

Independent of _how_ the cwd was resolved, lifecycle hooks live in the same
`~/.agent-yes/hooks/` tree and fire on agent events:

- `on-spawn` — last-mile provisioning (e.g. `bun install`), runs every spawn
  regardless of source.
- `on-idle` — agent went idle.
- `on-load` — `ay serve` started / agent registered.
- `on-exit` — agent exited.

### How this serves all three user types

| User                      | Action                        | Setup required                    |
| ------------------------- | ----------------------------- | --------------------------------- |
| Non-technical, random dir | type a folder name / pick one | **none** (Layer 0)                |
| GitHub user               | paste a tree URL              | drop in `github` (shipped sample) |
| Slack user                | paste a message URL           | drop in `slack` (shipped sample)  |

The principle: **GitHub is a plugin; the core is just `source → cwd`, and the
plain-dir path works out of the box.**

## Hooks system

Location: `~/.agent-yes/hooks/`.

### Cross-platform runner — **DECIDED**

Pick the runner by file extension so hooks are cross-platform:

- `.ts` / `.js` → run with `bun` (the runtime is already bundled; works on
  Windows/macOS/Linux). **This is the recommended/default template.**
- `.sh` → `bun sh` (bun's portable shell).
- `.ps1` → PowerShell (Windows).

### Timing — **DECIDED**

If a hook file exists, **run it every time**. Idempotency is the hook's
responsibility (early-exit if already provisioned).

### Hook I/O contract (proposed)

- **Input:** JSON on stdin — `{ event, cli, cwd, prompt, from, pid }` — and the
  same values mirrored into env vars (`AGENT_YES_CWD`, `AGENT_YES_CLI`,
  `AGENT_YES_PROMPT`, `AGENT_YES_FROM`, …) for shell-style hooks.
- **Output:**
  - Resolver hooks (`spawn-from` / `resolve/*`): print JSON on stdout —
    `{ cwd, prompt?, cli?, branch? }`. A resolver that does not claim the source
    exits non-zero (or prints nothing) so the chain continues.
  - Side-effect hooks (`on-spawn` / `on-idle` / …): exit 0 = OK; stderr is
    surfaced to the console.
- Run with a timeout; stream output to the console.

### Security

Running a hook is effectively RCE — but `/api/spawn` already launches arbitrary
agents (also RCE), gated by the same token. So hooks add **no new trust
boundary**; they live inside the existing gate.

## "Spawn from" flow

The console gains a **"Spawn from"** input. Paste a GitHub URL, a Slack/Chatwork
message URL, a repo shorthand, or a plain path:

```
[Spawn from]  https://github.com/snomiao/agent-yes/tree/some-branch
      |  POST /api/spawn { from: "<source>", cli, prompt }
      v
serve:  resolve(from)
          Layer 0: path?  -> mkdir -p, use it
          Layer 1: resolver chain (hooks/resolve/*) -> { cwd, prompt?, cli? }
          Layer 2: error
      ->  on-spawn hook (last-mile provisioning)
      ->  Bun.spawn(cli, { cwd })
```

### `/api/spawn` changes (sketch)

Add `from?` to the request body. Resolution order: `from` present → run the
resolver chain to get `cwd` (and maybe `cli`/`prompt`); else fall back to the
current `cwd`. Then run `on-spawn`, then spawn. On resolver/hook failure, return
the hook's stderr with a non-200 status.

## Decisions

- **Decided:** per-peer config under `~/.agent-yes/`; hooks under
  `~/.agent-yes/hooks/`; runner chosen by extension (`.ts`/`.js` via bun,
  `.sh` via `bun sh`, `.ps1` via PowerShell); hooks run every time if present;
  Layer 0 plain-dir provisioning is built-in and config-free; GitHub/Slack are
  shipped-but-optional sample resolvers.
- **DEFERRED:** how resolvers are organized — an ordered `hooks/resolve/*.ts`
  chain (one file per resolver, first-match) vs a single `hooks/spawn-from.ts`
  router vs a `from-pattern → command` map in `.agent-yes.config.json`. Pick this
  when implementation starts.

## Related code

- `ts/serve.ts` — `POST /api/spawn` handler (the spawn path to extend).
- `ts/workspaceConfig.ts` — `resolveSpawnCwd()` (current path resolution).
- `lab/ui/index.html` — the "+ New agent" form (where "Spawn from" would live).
- `ts/configLoader.ts` / `ts/configShared.ts` — existing cascading config (the
  `from-pattern → command` map option would slot in here).
