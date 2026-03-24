# PTY Resize / SIGWINCH Propagation

## Overview

When a user resizes their terminal window, `agent-yes` must propagate that resize
to the inner CLI (e.g. `claude`, `codex`) running inside its PTY. Without this,
the inner CLI renders wrapped/truncated output because it still thinks the terminal
is the old size.

## How It Works

```
User resizes terminal window
        │
        ▼
Kernel sends SIGWINCH to foreground process group
        │
        ▼
agent-yes SIGWINCH handler fires (tokio signal)
        │
        ▼
ioctl(TIOCGWINSZ) on stdout → gets actual new terminal size
        │
        ▼
pty.resize(cols, rows) → TIOCSWINSZ on inner PTY master
        │
        ▼
Kernel sends SIGWINCH to inner CLI's process group
        │
        ▼
Inner CLI (claude/codex) redraws at new dimensions
```

## Implementation (Rust)

**`rs/src/pty_spawner.rs`** — two distinct size-reading functions:

```rust
/// For SIGWINCH handler: always reads live kernel size via ioctl.
/// Never reads COLUMNS/LINES env vars (they're stale after a resize).
pub fn get_terminal_size_from_tty() -> (u16, u16)

/// For initial PTY spawn: checks COLUMNS/LINES env vars first (useful in
/// non-TTY/pipe contexts like CI), then falls back to ioctl, then (80, 24).
pub fn get_terminal_size() -> (u16, u16)
```

**`rs/src/context.rs`** — SIGWINCH handler in the main run loop:

```rust
// Initial sync: set PTY to current terminal size right away.
// watch::changed() never fires for the initial value, so without this
// any resize between spawn_agent() and run() would be missed.
let initial_size = get_terminal_size();
let (resize_tx, mut resize_rx) = watch::channel(initial_size);
pty.resize(initial_size.0, initial_size.1)?;

// Background task: listen for SIGWINCH, forward to watch channel.
tokio::spawn(async move {
    let mut sig = signal(SignalKind::window_change()).unwrap();
    loop {
        sig.recv().await;
        let size = get_terminal_size_from_tty(); // ← ioctl only, no env vars
        resize_tx.send(size);
    }
});

// In select! loop: apply resize when watch fires.
Ok(()) = resize_rx.changed() => {
    let (cols, rows) = *resize_rx.borrow_and_update();
    pty.resize(cols, rows);
}
```

`watch::channel` semantics are intentional: if two resizes arrive faster than the
select loop processes them, only the latest size is applied — which is correct
(only the current size matters).

## The Stale Env Var Bug (Fixed)

**Symptom**: resizing the terminal had no effect on the inner CLI's line width.

**Root cause**: `COLUMNS` and `LINES` are env vars set by the user's shell at
startup. They are **never updated** when the terminal is resized — only the
kernel's `winsize` struct (queried via `TIOCGWINSZ`) tracks the live size.

The original SIGWINCH handler called `get_terminal_size()` which checks
`COLUMNS`/`LINES` first. So after a resize:

```
Terminal resized: 200 → 100 cols
SIGWINCH fires on agent-yes
get_terminal_size() → reads COLUMNS=200 (stale!) → pty.resize(200, rows) ✗
Inner CLI still wraps at col 200
```

**Fix**: SIGWINCH handler now calls `get_terminal_size_from_tty()` which skips
env vars entirely and calls `ioctl(TIOCGWINSZ)` directly:

```
Terminal resized: 200 → 100 cols
SIGWINCH fires on agent-yes
get_terminal_size_from_tty() → ioctl(TIOCGWINSZ) → 100 cols → pty.resize(100, rows) ✓
Inner CLI redraws at 100 cols
```

## Zero-Dimension Guard

`pty.resize()` clamps `cols` and `rows` to a minimum of 1 before calling
`TIOCSWINSZ`. Some platforms corrupt PTY state if given a 0-dimension resize.

```rust
pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
    let cols = cols.max(1);
    let rows = rows.max(1);
    self.master.resize(PtySize { rows, cols, .. })?;
    Ok(())
}
```

## Regression Tests

### Unit tests (`rs/src/pty_spawner.rs`)

| Test                                 | What it covers                                                                                                               |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `test_pty_resize_reflected_in_child` | Spawns a real PTY with `sh -c 'stty size'`, resizes to 120×40 before the child reads its size, verifies output is `"40 120"` |
| `test_pty_resize_zero_guard`         | Calls `resize(0, 0)`, `resize(0, 24)`, `resize(80, 0)` — all must succeed without panic                                      |

### Integration tests (`rs/tests/integration_tests.rs`)

| Test                                                  | What it covers                                                                                                                                                                                                    |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test_sigwinch_propagated_through_agent_yes_to_child` | Bash orchestrator spawns agent-yes with COLUMNS=80/LINES=24, mock CLI resizes PTY to 132×50, orchestrator sends `kill -WINCH` to agent-yes, verifies mock CLI sees `"24 80"` (PTY reverted by agent-yes's resize) |

### End-to-end tests (`ts/tests/shared-e2e.spec.ts`)

| Test                                                        | Impls   | What it covers                                                                                                                                            |
| ----------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `child sees valid PTY size on startup`                      | TS, RS  | Initial PTY size is correctly set from env/ioctl before the child runs                                                                                    |
| `PTY resize propagated when mock CLI sends SIGWINCH`        | TS, RS  | Mock CLI calls `stty cols 132 rows 50` + `kill -WINCH -$$`; child reports `"50 132"`                                                                      |
| `SIGWINCH sent to agent-yes propagates resize to child PTY` | RS only | Mock CLI calls `kill -WINCH $PPID` (to agent-yes); agent-yes reads ioctl size (80×24 default in pipe context), resizes inner PTY; child reports `"24 80"` |
