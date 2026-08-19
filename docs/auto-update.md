# Auto-Update Approaches

Comparison matrix for checking and applying updates to `agent-yes` on every run.

## Approach Matrix

| Approach                                   | Startup delay | Auto-installs | TTL cache | Network-safe | Shows notice | Timing     | Complexity |
| ------------------------------------------ | ------------- | ------------- | --------- | ------------ | ------------ | ---------- | ---------- |
| **A. Notify-only** (current `--version`)   | none          | ❌            | ❌        | ✅           | ✅           | on demand  | low        |
| **B. Blocking check + notify**             | ~3s           | ❌            | ❌        | ✅           | ✅           | before run | low        |
| **C. Blocking check + auto-install**       | ~3s + install | ✅            | ❌        | ✅           | ✅           | before run | medium     |
| **D. Background check + notify after run** | none          | ❌            | ❌        | ✅           | ✅           | after run  | low        |
| **E. TTL-cached check + notify**           | none          | ❌            | ✅        | ✅           | ✅           | after run  | medium     |
| **F. TTL-cached check + auto-install** ✅  | none          | ✅            | ✅        | ✅           | ✅           | after run  | medium     |
| **G. update-notifier package**             | none          | ❌            | ✅        | ✅           | ✅           | after run  | low (dep)  |

## Decision: Approach F — TTL-cached background check + auto-install after run

### Rationale

Modern tools (Claude Code, Bun, Rust/cargo) auto-update transparently. Agent-yes does the same:

1. **No startup delay** — the npm registry fetch starts in the background while the agent runs.
2. **Auto-installs** — transparent update applied after the agent session ends.
3. **TTL cache (1 hour)** — avoids hammering npm registry; checks at most once per hour per user.
4. **Network-safe** — all errors are silently swallowed; missing network never breaks the tool.
5. **Transparent** — prints update message to stderr so user knows what happened.

### Flow

```
agent-yes start
  │
  ├─ [background] fetch registry.npmjs.org/agent-yes/latest   ← no delay
  │
  ├─ [main] run agent (claude / gemini / codex / …)
  │
  └─ [after run] if newer version found:
        - print "Updating agent-yes x.y.z → x.y.z+1 …"
        - run `npm install -g agent-yes@latest` (or bun/yarn/pnpm if detected)
        - print "Updated. Next run will use x.y.z+1."
```

### Cache file

Stored at `~/.cache/agent-yes/update-check.json`:

```json
{ "checkedAt": 1700000000000, "latestVersion": "1.68.0" }
```

TTL: 1 hour (`3_600_000` ms). Cleared automatically when a new version is installed.

### Package manager detection order

1. `bun` — if `BUN_INSTALL` env or `bun` binary found → `bun add -g agent-yes`
2. `pnpm` — if installed globally → `pnpm add -g agent-yes`
3. `npm` — fallback → `npm install -g agent-yes`

### Opt-out

Set `AGENT_YES_NO_UPDATE=1` to skip the auto-update check entirely.
