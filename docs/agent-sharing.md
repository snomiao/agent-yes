# Single-Agent Sharing (design draft)

> Status: **design only — not implemented.** Captures a brainstorm (with codex
> gpt-5.5) on sharing ONE agent to others — from the web UI and via
> `ay read`/`ay tail` against a shared URL. Open decisions are marked **DEFERRED**.

## Goal

1. Share a **single agent** (not the whole fleet) to someone else, from the web
   console.
2. Let other people `ay read` / `ay tail` against a **shared URL** (CLI access to
   someone else's shared agent), with **view-only vs steer** permission.

## Current state

- **Fleet-wide share** (`ay serve --share`): mints a room + 64-char token →
  `agent-yes.com/w/#room:token`. Whoever holds the link sees the **whole fleet**
  in the web console, end-to-end-encrypted (AES-GCM browser↔host over a WebRTC
  DataChannel; the secret never reaches the signaling Cloudflare Worker). **One
  token = read + steer for ALL agents** on that machine.
- **CLI remote read** (`ay read`/`ay tail`): HTTP `/api/read|tail/:keyword` gated
  by the whole-machine `.serve-token`, reached via `token@host:port:keyword`.
  Needs **direct HTTP reachability** (LAN / public port) — no NAT traversal.
- **Scoping today**: only a client-side `cwd` filter. The token is
  **all-or-nothing per machine**. There is no "share a single agent" capability.

## Principles (agreed)

1. **Host-enforced capability, not client-side hiding.** A scoped share must be
   enforced by the host on every `/api` call (reject other agents). A client-side
   filter is UX, not a security boundary.
2. **Never put the fleet master room token in a scoped link** — it is effectively
   the master key. A scoped share carries its own `grantSecret`.
3. **A scoped viewer must not receive the master room AES key.** Per-grant crypto
   (or room isolation, see Option X) keeps a scoped viewer off the fleet channel.
4. **Default to view-only.** Steer is a separate, explicit upgrade.

## Scope key: a stable `agentId` (prerequisite — step 0)

`pid` is ephemeral (restarts change it); `cwd` is unsafe (a different agent in
the same directory, or a post-restart process, would be exposed). The right scope
key is a **minted, stable `agentId`** (the agent slot / conversation binding),
plus a `sessionId` for the current running process:

- `agentId` — stable across restarts; the grant scopes to this.
- `sessionId` — the current process instance.
- At request time the host resolves `agentId → current pid/session`.
- `cwd` / name are **display only**, never the security scope.

**This does not exist yet.** The registry (`~/.agent-yes/pids.jsonl`, written by
both the TS and Rust runtimes) currently keys on `pid`. Minting and persisting an
`agentId` (mirrored across both runtimes) is the **foundation** this whole
feature sits on — without it, "share the same agent across a restart" cannot
hold.

## Architecture: two options

### Option X — one share = one mini-room (recommended MVP)

`ay share <agent> [--steer]` stands up a room that exposes **only that agent**.
The host joins the room and filters every `/api` call to the shared `agentId`.

- **Isolation** = the existing e2ee room boundary, reused as-is.
- **No new crypto** — each room already has its own key/token.
- **Revoke** = close the room.
- **List** = the set of active share-rooms.
- **Permission** = mint the room as view-only or steer.
- **Cost** = more rooms ⇒ more signaling Durable Object usage (heartbeats /
  alarms / ICE bill as DO requests — see `docs/` DO cost notes). Fine for a few
  shares.

### Option Y — shared room + per-peer ACL + grants table (scale-up)

One room; the host authenticates each peer's `grantSecret`, attaches a
`{ perm, agentId }` capability to that peer, and enforces it per request. Needs a
persisted grants table (`grantId → { agentId, perm, exp, revoked, label }`) and a
**per-grant key** in the handshake so a scoped viewer never gets the master room
key.

- More efficient at many shares (one room), with first-class manage/revoke/audit.
- More implementation: multi-capability handshake + per-peer ACL.

**Recommendation:** ship **Option X** first (massive reuse, room isolation = the
security boundary), and escalate to **Option Y** when shares grow enough that
per-room overhead and fine-grained management matter.

> **Why not stateless signed tokens?** A signed `{agentId,perm,exp}` token needs
> no table, but revocation, audit, a "what have I shared?" list, and permission
> changes are all weak. A local single-user host will always want "revoke that
> link I sent." Prefer **persisted random grants**.

## Link format

`agent-yes.com/w/#room:grantSecret` — the `pid` is **not** in the URL (not even
the fragment); the scope lives in the grant. The **same URL works for both** the
browser and the CLI; the web UI shows the agent's name/cwd resolved from the
grant.

## CLI access for outsiders (`ay read` / `ay tail <share-url>`)

Make the CLI a **headless console client**: `ay tail <share-url>` reuses the
host's `node-datachannel` WebRTC stack **in reverse** — join the room as a viewer
peer, derive the channel key from the grant, open the DataChannel, and speak the
**same `/api/*` request envelope the browser already uses** over it
(`/api/tail/:agent?raw=1`, etc.). This preserves e2ee and NAT traversal and
avoids a public HTTP port. Reusing the existing `/api` protocol over the channel
avoids a second implementation.

Keep the **HTTP scoped-token path as a LAN / direct fast path** — not the public
route. (Scoped tokens over HTTP alone leave a half-measure: handy on a LAN, but
"use the web UI" the moment you're behind NAT.)

**Traps:** `node-datachannel` is a heavy native dep under Bun; the CLI must join
signaling as a non-host peer; tail streaming needs backpressure / reconnect / ICE
handling; the secret fragment reaches the CLI and can linger in shell history /
process list / logs.

## Security must-haves

Terminal output routinely contains API keys, env, file paths, prompts, git diffs,
private URLs — so the biggest risk of opening `read`/`tail` to strangers is
**secret leakage**. Minimum bar:

- **view-only by default**; steer is a separate link / explicit upgrade.
- **short expiration**.
- a **visible active-shares list** + **one-click revoke**.
- **per-grant audit**: connected peer count, last read/tail/send.
- treat `send` (steer) as **command-injection-equivalent**.
- a redact option is desirable but must not be over-trusted.

## Staging

1. **Design doc** (this file).
2. **Web-UI single-agent view-only share (Option X):** mint `agentId`; `ay share`
   → a "Share" action on each agent row → a shares-management panel with revoke.
3. **`ay read`/`ay tail <share-url>` (CLI over WebRTC):** the larger lift.

## Decisions

- **Agreed:** host-enforced scoped capability; stable `agentId` as the scope key
  (not pid/cwd); separate `grantSecret` (never the master room token); scoped
  viewers kept off the master key; `#room:grantSecret` link shared by browser +
  CLI; view-only default with steer as an explicit upgrade; CLI-over-WebRTC as the
  long-term outsider path with HTTP scoped tokens as a LAN fast path.
- **DEFERRED:** Option X (per-agent room) vs Option Y (grants table) at
  implementation time — start X, escalate to Y on demand; exact `agentId` minting
  scheme and how it's mirrored across the TS/Rust registry; expiry defaults;
  whether the CLI client and browser share one room-client module.

## Related code

- `ts/share.ts` — host-side WebRTC share (`ay serve --share`); the stack to drive
  in reverse for a CLI client.
- `ts/serve.ts` — `/api/*` handlers (`read`/`tail`/`send`/`spawn`) to scope per
  grant; `.serve-token` auth.
- `ts/remotes.ts` — `token@host:port:keyword` remote spec / `runRemoteRead` (the
  CLI remote path to extend toward share URLs).
- `ts/subcommands.ts` — `cmdRead` / the `ay read|tail` client.
- `ts/globalPidIndex.ts` / `rs/src/pid_store.rs` — the cross-runtime registry that
  must mint and persist `agentId`.
- `lab/ui/index.html` — the console; where the per-agent "Share" action and the
  shares-management panel live.
