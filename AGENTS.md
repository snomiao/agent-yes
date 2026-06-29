# agent-yes

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
