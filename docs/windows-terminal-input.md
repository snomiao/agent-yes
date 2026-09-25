# Windows nested-PTY input

The Windows wrapper reads VT bytes and forwards them to an inner ConPTY.
ConPTY's startup `CSI ? 9001 h` is a negotiation with its immediate terminal,
not application output to blindly forward through another Windows console.

Forwarding that request enables win32-input-mode in the outer console. A
browser arrow (`ESC [ A`) then becomes three literal-character input records
in the inner console, instead of a Windows Up key. Mouse reports and bracketed
paste fail for the same reason. Keeping mode 9001 local restores the original
native events without rewriting or discarding user input.

## Ownership

- Rust: `conpty_mode_filter.rs` runs at the PTY reader boundary, before logs,
  virtual-terminal rendering, live output, and replay consumers.
- TypeScript: `conptyModeFilter.ts` runs before the PTY output fan-out, with
  independent state for each child lifetime.
- Both filters handle fragmented requests and combined private-mode lists.
  Only mode 9001 is consumed; other application protocols stay intact.
- Rust captures the original console mode **before** entering raw mode and
  restores it on exit. Previously the saved value already had line input,
  echo, and processed input disabled.
- The browser host owns reconnect replay. Webcode/WTx suppresses query replies
  until replay has finished parsing. It does not need to disable mouse input
  or reset Bash modes to compensate for this wrapper bug.

## Check the installed behavior

After `bun run build:rs`, `bun run build`, and `bun link`, on Windows:

```powershell
bun test tests/windows-conpty.bun.spec.ts
```

This runs the installed Rust binary and built TypeScript fallback against a
native `ReadConsoleInputW` recorder in isolated PTYs. It compares their real
input records with direct-PTY input and checks the outer console mode before
and after exit. Coverage includes normal/application arrows, Home/End,
Insert/Delete, Page Up/Down, F1–F12, Shift/Ctrl/Alt combinations, Tab/Enter,
Backspace/Ctrl+Backspace, Ctrl+C after readiness, Unicode and emoji,
bracketed multiline paste, focus, and mouse clicks/movement/drag/wheel.

To verify the negative control, point the same test at a pre-fix executable:

```powershell
$env:AGENT_YES_TEST_BINARY = 'C:/path/to/pre-fix/agent-yes.exe'
bun test tests/windows-conpty.bun.spec.ts --test-name-pattern Rust
Remove-Item Env:AGENT_YES_TEST_BINARY
```

The pre-fix executable fails; it returns literal escape characters and/or
leaves the outer console's input mode changed. No model/API calls are made.
The test skips when Windows or the installed Rust binary is unavailable.

Stream-boundary unit checks:

```powershell
bunx vitest run ts/conptyModeFilter.spec.ts --coverage.enabled=false
cargo test --manifest-path rs/Cargo.toml --bin agent-yes conpty_mode_filter
```

Existing wrapper processes keep the executable and console state with which
they started. Rebuilding installs the fix for the next launch; restarting the
browser alone does not replace a running wrapper.
