# agent-yes

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

`build:rs` runs `cargo build --release` (writes `rs/target/release/agent-yes`). It does
**not** `cargo install` a system-wide `agent-yes` — only the TypeScript launcher is linked
onto PATH (`bun link`), and it spawns this Rust binary from `target/release` via
`findRustBinary()` when needed. A cargo-installed `agent-yes` would shadow that launcher on
PATH and break subcommands like `agent-yes serve` (the raw runner has no subcommands), so if
you have a stale `~/.cargo/bin/agent-yes`, remove it. Re-run `build:rs` whenever any `.rs`
file changes, otherwise the old binary stays in place.

`rs/default.config.yaml` is embedded into the Rust binary at compile time via
`include_str!` (see `rs/src/config.rs`), so editing the CLI ready/enter/etc. markers
also requires `build:rs` to take effect — a TS-only build won't update the Rust binary.

**Prerequisite: Rust toolchain.** `build:rs` needs `cargo`. If it's missing (`cargo: command
not found`), install rustup first, then re-source the env:

```bash
curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
. "$HOME/.cargo/env"
```
