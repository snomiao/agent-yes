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

| Feature                                             | Status | Notes                                                 |
| --------------------------------------------------- | ------ | ----------------------------------------------------- |
| PTY spawning                                        | ✅     | Both use native PTY                                   |
| Pattern matching (ready/enter/fatal/typing_respond) | ✅     |                                                       |
| Auto-yes toggle (Ctrl+Y)                            | ✅     |                                                       |
| Auto-yes toggle (`/auto` command)                   | ✅     | Fixed: stdin line buffer + Ctrl+U to clear shell line |
| Device Attributes response (`ESC[c`)                | ✅     |                                                       |
| Cursor position response (`ESC[6n`)                 | ✅     |                                                       |
| Heartbeat for no-EOL CLIs                           | ✅     |                                                       |
| Idle timeout + idle action                          | ✅     |                                                       |
| Restart on crash (`--robust`)                       | ✅     |                                                       |
| TTY resize / SIGWINCH propagation                   | ✅     | Fixed 2025-03-23                                      |
| Raw mode + stdin passthrough                        | ✅     |                                                       |

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

| Feature                               | Status | TS file                            | Notes                                              |
| ------------------------------------- | ------ | ---------------------------------- | -------------------------------------------------- |
| PID store / process registry (JSONL)  | ✅     | `ts/pidStore.ts`                   | `rs/src/pid_store.rs`                              |
| Webhook notifications                 | ✅     | `ts/webhookNotifier.ts`            | `rs/src/webhook.rs` (uses curl)                    |
| Auto-update on startup                | 🚫     | `ts/versionChecker.ts`             | Not planned                                        |
| File-based logging (raw logs)         | ✅     | `ts/core/logging.ts`               | `rs/src/log_files.rs` → `.agent-yes/<pid>.raw.log` |
| Global agent registry (in-memory)     | 🚫     | `ts/agentRegistry.ts`              | Not planned                                        |
| Queue / run lock                      | ✅     | `ts/runningLock.ts`                | `rs/src/running_lock.rs`                           |
| SKILL.md header injection             | 🚫     | `ts/index.ts` ~170-245             | Not planned                                        |
| FIFO / IPC named pipe                 | 🚫     | `ts/beta/fifo.ts`                  | Not planned                                        |
| Codex session ID extraction + storage | ✅     | `ts/resume/codexSessionManager.ts` | `rs/src/codex_sessions.rs`                         |

---

## Rust-only Strengths

| Feature                          | Notes                                            |
| -------------------------------- | ------------------------------------------------ |
| 🦀 Full libp2p swarm mode        | P2P coordinator, relay, DHT, QUIC/TCP transports |
| 🦀 Single binary distribution    | No Node.js/Bun runtime required                  |
| 🦀 Native PTY via `portable-pty` | Cross-platform (Linux/macOS/Windows)             |

---

## Rust Parity Status

| #   | Feature                                      | Status                                     |
| --- | -------------------------------------------- | ------------------------------------------ |
| 1   | File logging — `.agent-yes/<pid>.raw.log`    | ✅ Done (`rs/src/log_files.rs`)            |
| 2   | PID store — JSONL process registry           | ✅ Done (`rs/src/pid_store.rs`)            |
| 3   | Webhook notifications — HTTP on RUNNING/EXIT | ✅ Done (`rs/src/webhook.rs`, uses `curl`) |
| 4   | `/auto` Ctrl+U fix — clear line after toggle | ✅ Done (`context.rs` stdin line buffer)   |
| 5   | Queue / run lock — `--queue` flag            | ✅ Done (`rs/src/running_lock.rs`)         |
| 6   | Auto-update                                  | 🚫 Not planned                             |
| 7   | SKILL.md injection — `--use-skills`          | 🚫 Not planned                             |
| 8   | Codex session resume — persist session IDs   | ✅ Done (`rs/src/codex_sessions.rs`)       |
| 9   | `--install` flag — auto-install CLI tool     | 🚫 Not planned                             |
| 10  | FIFO IPC — `--use-stdin-append`              | 🚫 Not planned                             |
