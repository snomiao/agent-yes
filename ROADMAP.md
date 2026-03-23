# Roadmap: Rust ↔ TypeScript Feature Parity

The Rust binary is the primary distribution target (faster startup, single binary).
TypeScript is the reference implementation and fallback.

This document tracks what TypeScript has that Rust still needs.

---

## Status Legend

- ✅ Done (both impls)
- 🟡 Partial (Rust incomplete)
- ❌ Missing in Rust
- 🦀 Rust-only (no TS equivalent)

---

## Core Agent Loop

| Feature                                             | Status | Notes                                                        |
| --------------------------------------------------- | ------ | ------------------------------------------------------------ |
| PTY spawning                                        | ✅     | Both use native PTY                                          |
| Pattern matching (ready/enter/fatal/typing_respond) | ✅     |                                                              |
| Auto-yes toggle (Ctrl+Y)                            | ✅     |                                                              |
| Auto-yes toggle (`/auto` command)                   | 🟡     | RS detects `/auto` but doesn't send Ctrl+U to clear the line |
| Device Attributes response (`ESC[c`)                | ✅     |                                                              |
| Cursor position response (`ESC[6n`)                 | ✅     |                                                              |
| Heartbeat for no-EOL CLIs                           | ✅     |                                                              |
| Idle timeout + idle action                          | ✅     |                                                              |
| Restart on crash (`--robust`)                       | ✅     |                                                              |
| TTY resize / SIGWINCH propagation                   | ✅     | Fixed 2025-03-23                                             |
| Raw mode + stdin passthrough                        | ✅     |                                                              |

---

## CLI Flags

| Flag                    | TS  | RS  | Notes                                      |
| ----------------------- | --- | --- | ------------------------------------------ |
| `--cli`                 | ✅  | ✅  |                                            |
| `--prompt` / `-p`       | ✅  | ✅  |                                            |
| `--timeout` / `-t`      | ✅  | ✅  |                                            |
| `--idle-action` / `-ia` | ✅  | ✅  |                                            |
| `--robust` / `-r`       | ✅  | ✅  |                                            |
| `--continue` / `-c`     | ✅  | ✅  |                                            |
| `--auto` / `-y`         | ✅  | ✅  |                                            |
| `--verbose`             | ✅  | 🟡  | RS logs to stderr only, no file output     |
| `--install`             | ✅  | ❌  | Auto-install missing CLI tool              |
| `--queue`               | ✅  | ❌  | Prevent concurrent agents in same repo     |
| `--use-skills`          | ✅  | ❌  | SKILL.md header injection into prompt      |
| `--use-stdin-append`    | ✅  | ❌  | FIFO IPC for appending prompts mid-session |
| `--swarm`               | ✅  | 🦀  | RS has full libp2p P2P swarm; TS is stub   |

---

## Infrastructure

| Feature                               | Status | TS file                            | Notes                                          |
| ------------------------------------- | ------ | ---------------------------------- | ---------------------------------------------- |
| PID store / process registry (SQLite) | ❌     | `ts/pidStore.ts`                   | Track all running agents, states, metadata     |
| Webhook notifications                 | ❌     | `ts/webhookNotifier.ts`            | HTTP call on RUNNING/EXIT/IDLE                 |
| Auto-update on startup                | ❌     | `ts/versionChecker.ts`             | Background version check, auto-installs latest |
| File-based logging (raw + debug logs) | ❌     | `ts/core/logging.ts`               | Per-session log files in `.agent-yes/`         |
| Global agent registry (in-memory)     | ❌     | `ts/agentRegistry.ts`              | Cross-process stdout inspection                |
| Queue / run lock                      | ❌     | `ts/runningLock.ts`                | File-based lock per git root                   |
| SKILL.md header injection             | ❌     | `ts/index.ts` ~170-245             | Walk dirs to git root, inject into prompt      |
| FIFO / IPC named pipe                 | ❌     | `ts/beta/fifo.ts`                  | Append prompts to running session              |
| Codex session ID extraction + storage | ❌     | `ts/resume/codexSessionManager.ts` | SQLite session store for crash resume          |

---

## Rust-only Strengths

| Feature                          | Notes                                            |
| -------------------------------- | ------------------------------------------------ |
| 🦀 Full libp2p swarm mode        | P2P coordinator, relay, DHT, QUIC/TCP transports |
| 🦀 Single binary distribution    | No Node.js/Bun runtime required                  |
| 🦀 Native PTY via `portable-pty` | Cross-platform (Linux/macOS/Windows)             |

---

## Priority Order for Rust Parity

1. **File logging** — debug `.agent-yes/<pid>.raw.log` files (medium effort, high value for debugging)
2. **PID store** — SQLite registry of running agents (enables webhooks, queue, registry)
3. **Webhook notifications** — HTTP calls on state change (depends on PID store)
4. **`/auto` Ctrl+U fix** — Clear `/auto` from shell input after toggle (small fix)
5. **Queue / run lock** — `--queue` flag, file lock per git root
6. **Auto-update** — Background update check on startup
7. **SKILL.md injection** — `--use-skills` flag
8. **Codex session resume** — Extract + persist session IDs for crash recovery
9. **`--install` flag** — Auto-install missing CLI tool
10. **FIFO IPC** — `--use-stdin-append` named pipe (Linux only, beta)
