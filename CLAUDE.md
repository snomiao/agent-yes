# agent-yes

## No real fleet data in committed artifacts

This repo is public. Tests, fixtures, code comments, help examples, docs, and
PR bodies must use **synthetic data only** — never copy real values from the
operator's live fleet or terminals. That includes: real pids and agent ids,
real cwd/worktree paths, org/repo/product names of private downstream
projects, people's names, prompts, and terminal transcripts. Use neutral
stand-ins instead (`pid 1111`, `/repo/alpha`, `/x/acme/acme/tree/...`,
`"alice"`). When a regression came from a live incident, describe the
_mechanism_ generically; keep the concrete details out of the commit.

## Scratch / debug / temp scripts → `./tmp/`

Put throwaway debug, probe, capture, and scratch scripts (and their output —
screenshots, logs) under `./tmp/` at the repo root. It's already gitignored
(see `.gitignore`). Do **not** scatter them in `scripts/` (that dir ships in the
npm package), in `$HOME` / `%USERPROFILE%`, or in the system `%TEMP%` / msys
`/tmp`. Clean them up when the task is done.

## After making changes, always rebuild and relink

**TypeScript changes:**

```bash
bun run build && bun link
```

This compiles `ts/` → `dist/` via tsdown and registers the binaries globally.

**Rust changes (`rs/` directory):**

```bash
bun run build:rs && bun run build && bun link
```

`build:rs` runs `cargo install --path rs` (release build, installs to `~/.cargo/bin/agent-yes`).
Must be done whenever any `.rs` file changes, otherwise the old binary stays in place.

`rs/default.config.yaml` is embedded into the Rust binary at compile time via
`include_str!` (see `rs/src/config.rs`), so editing the CLI ready/enter/etc. markers
also requires `build:rs` to take effect — a TS-only build won't update the Rust binary.

**Prerequisite: Rust toolchain.** `build:rs` needs `cargo`. If it's missing (`cargo: command
not found`), install rustup first, then re-source the env:

```bash
curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
. "$HOME/.cargo/env"
```

## Reading a child process's stdout with a timeout: never join the reader

When you kill a timed-out child whose stdout you are draining on another
thread, do NOT `join` that reader thread (Rust) / `await` that read promise
(TS) on the timeout path. Killing the child does not close the pipe: any
**grandchild** it spawned (an rc file's `sleep`, a spinner, a forked helper)
inherits the pipe's write end and keeps it open, so `read_to_end` only returns
when the grandchild eventually exits — a test hung 60 s on exactly this in
`rs/src/serve/shell_env.rs`. Abandon the reader instead; it exits by itself
once the last writer closes. This applies to every "spawn a child, read its
output, enforce a deadline" site, not just shell_env.
