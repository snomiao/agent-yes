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

## Verifying that a fix is in the running build

`dist/` is gitignored and this machine runs ONE checkout, so a fix can vanish
when anyone rebuilds or rebases — with no signal. Don't claim "fixed"; leave a
check anyone can run in one command.

**Take the check from the fix's own output. Do not add detection-only code.**
Detection code you add can survive while the fix it reports on is gone; output
the fix itself produces cannot.

For the `ay send` guards, the check is:

```bash
ay send 99999 --body-file /tmp/x   # pid 99999 does not exist — nothing is sent
```

- guards present → `ay send: Unknown arguments: body-file, bodyFile`
- guards absent → `ay send: no agent matched "99999"` (the unknown flag was
  swallowed and the send proceeded — which is the bug)

Confirm with BOTH controls. A new message appearing does not prove it is new;
run the pre-fix source directly (`bun ts/cli.ts ...` from a worktree without the
change) and check the output actually differs.
