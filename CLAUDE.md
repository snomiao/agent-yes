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

`build:rs` runs `cargo install --path rs` (release build, installs to `~/.cargo/bin/agent-yes`).
Must be done whenever any `.rs` file changes, otherwise the old binary stays in place.
