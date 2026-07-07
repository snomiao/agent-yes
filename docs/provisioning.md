# Provisioning & spawn-from

> Status: **shipped.** Provisioning lives in the **`codehost/provision`** standard
> (published `codehost`); agent-yes consumes it to spawn agents into prepared
> working directories. (The earlier "resolver chain + lifecycle hooks" design
> draft was superseded by this — see git history.)

## The model

`POST /api/spawn` prepares a working directory, then spawns the agent in it.
Three ways to produce the `cwd`, in precedence order:

| Request body                | What happens                                                                                      | Backed by                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `fork: { fromCwd, branch }` | Fork an existing worktree to a **new branch (clean — committed work only)**, then spawn there      | `codehost/provision` `forkWorktree`       |
| `from: "<source>"`          | Provision a GitHub source (clone / worktree / ff-pull) into `<root>/<owner>/<repo>/tree/<branch>` | `codehost/provision` `provision`          |
| `cwd: "<dir>"` (or omitted) | Resolve against the workspace root and `mkdir -p` (a missing dir no longer ENOENTs into a 500)    | `ts/workspaceConfig.ts` `resolveSpawnCwd` |

`from` accepts a GitHub URL, `owner/repo@branch`, or `owner/repo/tree/branch`.
For `fork`, `fromCwd` is the anchor agent's worktree and `branch` is the new
branch name.

## codehost/provision (the standard)

Provisioning — the `<wsRoot>/<owner>/<repo>/tree/<branch>` layout, the
clone/fetch/ff-pull state machine, `forkWorktree`, and the security rules — is
**owned by codehost** and imported from the package:

```ts
import { provision, parseSource, forkWorktree } from "codehost/provision";
```

It is an **optional dependency** of agent-yes: install `codehost`
(`npm i -g codehost`) — or `bun link` it for local dev — to enable `from`/`fork`.
Without it, `/api/spawn` with `from`/`fork` returns **501**; plain `cwd` always
works. `codehost/*` is externalized in `tsdown.config.ts`, so a missing package
degrades gracefully instead of breaking the build.

See codehost's `docs/provisioning.md` for the full API + state machine. The ops
agent-yes uses:

- `provision(spec, { wsRoot? })` — clone/fetch/ff-pull a GitHub source.
- `forkWorktree({ fromCwd, branch, wsRoot? })` — `git worktree add` off the
  source's HEAD (shared object store, **no clone**) carrying its **uncommitted
  work** (tracked changes via `git stash create`→`apply`; untracked files copied;
  the source worktree is never touched). `action: "forked"`. Distinct from
  `createBranch` (new branch off the remote **default**).
- `parseSource` / `parseSpec` — normalize a source string to a `RepoSpec`.

## Configuration (`~/.agent-yes/config.json`)

Provisioning is **host-local** — it runs on the machine where the agent spawns,
so config lives per host, never synced between peers.

- **`provisionRoot`** — where `from`/`fork` worktrees land
  (`<root>/<owner>/<repo>/tree/<branch>`). Resolved by `getProvisionRoot()`:
  env `CODEHOST_WS_ROOT` wins, then `provisionRoot`, else codehost's `~/ws`
  default. (This machine uses `/code`.) Kept **separate** from `workspace` (the
  plain-`cwd` default, which may be a specific project dir rather than a root).
- **`provisionAllowlist`** — owners/repos permitted for `from`/`fork`. **Empty =
  deny all** (a secure default; see Security). Entries match `<owner>`,
  `<owner>/<repo>`, or `*` (allow everything). Env
  `CODEHOST_PROVISION_ALLOWLIST` (comma-separated) overrides. See
  `isProvisionAllowed()`.
- **`provisionHook`** — a host-local shell hook run **before** the `from`/`fork`
  git op ("koho-style" provisioning), so it can **prepare the host** — most
  usefully **select the git identity** for this repo before the clone/worktree +
  `setup-repo.sh`. When set it is ALSO the **gate**: its exit code decides
  admission (**0 = allow, non-zero = deny**), which **overrides
  `provisionAllowlist`** (define one _or_ the other). The hook receives the
  provisioning context as env: `KOHO_ACTION` (`fork`|`from`), `KOHO_OWNER`,
  `KOHO_REPO`, `KOHO_BRANCH`, `KOHO_FROM_CWD` (fork only), `KOHO_SOURCE` (from
  only), `KOHO_WS_ROOT`. Env `AGENT_YES_PROVISION_HOOK` overrides the config
  form; `AGENT_YES_PROVISION_HOOK_TIMEOUT_MS` bounds it (default 60s). See
  `getProvisionHook()`.

```jsonc
{
  "provisionRoot": "/code",
  "provisionAllowlist": ["snomiao"],
  // koho-style: pick the account per owner, then allow (exit 0). This REPLACES
  // provisionAllowlist as the gate — a non-zero exit denies the provision.
  "provisionHook": "case \"$KOHO_OWNER\" in symval) gh auth switch --user snomiao;; snomiao) gh auth switch --user snomiao;; *) echo \"unknown owner $KOHO_OWNER\"; exit 1;; esac",
}
```

## Security

- **Allowlist-gated.** `from` and `fork` clone a repo and run its `setup-repo.sh`
  (dependency installs + package lifecycle hooks = **code execution** on the
  host), so a non-allowlisted owner/repo → **403**, and an empty allowlist denies
  everything. The `/api/spawn` token is still the trust boundary (it already
  grants agent-RCE); the allowlist narrows the _new_ "clone an arbitrary repo and
  run its setup" surface.
- **Or hook-gated (`provisionHook`).** When a `provisionHook` is configured it
  runs first and **its exit code is the gate** (overriding the allowlist), so a
  host can express dynamic policy — e.g. allow only owners it can `gh auth switch`
  to, denying the rest with `exit 1`. Like `spawnHook` it is arbitrary local code
  and is therefore **never network-writable**: the config-file form is ignored
  unless `config.json` is a real file, owned by us, and not group/world-writable;
  only the env form (`AGENT_YES_PROVISION_HOOK`, from the daemon's own env) skips
  that guard.
- **No injection.** The clone URL is hard-pinned to `https://github.com/<o>/<r>`,
  git runs via `execFile` (no shell), and every path segment is validated
  (`isSafeSegment`: non-empty, not `.`/`..`, no leading `-`, no separators or
  control chars).
- **Clean status codes.** Malformed input → **400** (not 500); a
  provision/fork failure → **502**; a missing `codehost` package → **501**.

## Console UI

- **"+ New agent" form** (`lab/ui/index.html`): a **"Spawn from"** field
  (GitHub URL / `owner/repo@branch`).
- **Cmd+K omnibox** — type a prompt, then:
  - `⌘⏎` **Spawn here** — the anchor agent's cwd (the fast default).
  - **⑂ Fork current branch & run** — forks the anchor's worktree to a new branch
    (auto-slugged from the prompt, editable at launch) carrying its uncommitted
    work.
  - **⊕ Spawn in a directory…** — an arbitrary working dir.

## Consumers

`codehost/provision` is the shared standard, also consumed by **fbi-proxy
`lab/web-code`** (the github.com→fbi.com browser-VS-Code gateway, where the
implementation originated before being promoted into codehost).

## Related code

- `ts/serve.ts` — `POST /api/spawn` (`from` / `fork` / `cwd` handling);
  `runProvisionHook` (the koho-style gate) + `originOwnerRepo`.
- `ts/workspaceConfig.ts` — `getProvisionRoot`, `getProvisionAllowlist`,
  `isProvisionAllowed`, `getProvisionHook` / `hasProvisionHook`, `resolveSpawnCwd`.
- `tsdown.config.ts` — externalizes `codehost/*`.
- `lab/ui/index.html` — the "Spawn from" field + the Cmd+K fork / spawn-in-dir rows.
- codehost `src/provision/` + its `docs/provisioning.md` — the standard.
- [`docs/auth-and-permissions.md`](./auth-and-permissions.md) — the `agent:spawn`
  capability whose `cwdRoots` scoping must re-validate the _resolved_ cwd.
