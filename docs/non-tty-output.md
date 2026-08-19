# Non-TTY Output Rendering

## Motivation

`cy` always spawns the inner agent CLI (Claude, Codex, etc.) inside a PTY it owns,
so the inner CLI emits a full TUI byte stream: colors, cursor positioning, alt
screen switches, mouse tracking, partial-line spinner redraws, and so on. The
current behavior pipes those bytes verbatim to `cy`'s own stdout.

When `cy`'s stdout is itself a TTY, this is fine — the user's terminal renders
the stream as a normal interactive session. But when `cy`'s stdout is a pipe,
file, or non-interactive SSH channel, the same byte stream is unreadable: cursor
moves and screen clears layer on top of one another in a flat log, escape
sequences appear as literal text, and bounded-channel drops in the middle of a
CSI corrupt downstream rendering.

`cy`'s purpose is to be a wrapper that automates and _normalizes_ agent CLI
output. It should therefore emit **plain rendered text** when stdout is not a
TTY, and **raw passthrough** when stdout is a TTY.

## Goals

1. `cy` in a TTY behaves exactly as today: raw passthrough, full color, full TUI.
2. `cy` in a non-TTY (`cy ... | cat`, `cy ... > out.log`, `ssh host cy ...`)
   emits readable plain text: no ANSI escapes, no cursor positioning, no alt
   screen switches, no mouse tracking, no spinner thrash.
3. The detection is automatic. No new flag is required for the common case.
4. The rendered output preserves the _semantic_ content the user would have
   seen on a TTY: every committed line of agent output appears exactly once,
   in order.
5. The agent process itself is unaffected — it still runs in `cy`'s PTY and
   still believes it is talking to a real terminal.

## Non-Goals

- Faithful reproduction of TUI layout in plain text. Boxes, banners, and
  multi-column UI are best-effort: text content is preserved, decoration may
  collapse.
- Re-rendering an already-emitted line. Once a line is committed to non-TTY
  stdout, it is never rewritten.
- Configurable styling. Non-TTY output is plain UTF-8 text, no ANSI.

## Detection

At startup, `cy` checks `IsTerminal::is_terminal(&io::stdout())` once and stores
the result as `stdout_is_tty: bool` in `AgentContext`. The check is on **stdout
only**; stdin TTY status is independent (already handled separately for input).

The `--force-tty` and `--no-tty` flags override the detection (see
[Configuration](#configuration)).

## Output Modes

### TTY mode (`stdout_is_tty == true`)

Unchanged from current behavior:

- PTY output bytes are forwarded directly to `tokio::io::stdout()`
  (`rs/src/context.rs:158-168`).
- The `vterm` is still maintained in parallel for pattern matching.
- `raw.log` records the raw byte stream as today.

### Non-TTY mode (`stdout_is_tty == false`)

PTY output is **not** forwarded raw. Instead:

1. Every chunk is fed to `vterm` as today.
2. After each chunk, the renderer extracts any **newly-committed lines** from
   the vterm screen (see [Line Commitment](#line-commitment)) and writes them
   to stdout as plain UTF-8, one per line, terminated with `\n`.
3. On `cy` exit, a final flush emits any committed-but-unflushed lines and
   then the _final visible screen_, with trailing blank lines and the input
   prompt area trimmed.
4. `raw.log` still records the raw byte stream — the file log is unchanged so
   that low-level debugging stays possible.

## Line Commitment

A line is **committed** when it can no longer be modified by the agent:

- A line that has scrolled off the top of the vterm screen is committed.
- A line on the visible screen is **not** committed yet — it may still be
  redrawn (spinner, progress bar, partial output).
- On `cy` exit, every non-blank visible line is committed in order, except:
  - Lines belonging to the input prompt area (last 1-3 rows, see
    [Prompt Trimming](#prompt-trimming)).
  - Trailing blank rows.

### Implementation sketch

```rust
struct NonTtyRenderer {
    last_emitted_scrollback_len: usize,
}

impl NonTtyRenderer {
    fn flush_committed(&mut self, vterm: &VTermProxy, out: &mut impl Write) {
        let scrollback = vterm.scrollback_lines();
        for line in scrollback.iter().skip(self.last_emitted_scrollback_len) {
            writeln!(out, "{}", line.trim_end())?;
        }
        self.last_emitted_scrollback_len = scrollback.len();
    }

    fn flush_final(&mut self, vterm: &VTermProxy, out: &mut impl Write) {
        self.flush_committed(vterm, out);
        for line in trim_prompt_and_blank(vterm.visible_lines()) {
            writeln!(out, "{}", line.trim_end())?;
        }
    }
}
```

`vterm.scrollback_lines()` and `vterm.visible_lines()` are new APIs added to
`rs/src/vterm.rs` wrapping vt100-ctt's screen + scrollback access.

## Prompt Trimming

The agent CLI's input prompt area (typically the bottom 1-3 rows: prompt box,
status hint, spinner) is **suppressed** in non-TTY final flush. Detection
heuristics, in priority order:

1. If the cursor is on the visible screen, drop everything from `cursor_row`
   downward.
2. If the bottom row is entirely whitespace or matches a known prompt pattern
   (`> `, `? for shortcuts`, etc.), drop it.
3. Otherwise, keep all visible lines.

Heuristics are agent-CLI-agnostic where possible; per-CLI overrides live in
`agentRegistry`.

## Animation Suppression

Spinner-style animations (Claude's `✻ Boondoggling… ✻ Bo… ✻ Boo…`) write to a
fixed row repeatedly. Because no scrollback line is produced for these writes,
non-TTY mode naturally **omits** them — the row only ever surfaces if it
remains on the visible screen at exit, and prompt trimming usually removes it
anyway.

Progress bars that overwrite the same line behave identically: only the final
state (if it ever scrolls off, or if it is on the visible screen at exit and
not in the trimmed prompt area) is emitted.

## ANSI Stripping in Logs and `--logFile`

Independent of stdout mode:

- `raw.log`: unchanged, raw bytes (current behavior).
- `--logFile <path>`: emits the same plain text that non-TTY mode would emit,
  regardless of whether stdout is a TTY. This gives users a clean log even
  during interactive sessions.

## Configuration

### CLI flags

| Flag               | Effect                                                     |
| ------------------ | ---------------------------------------------------------- |
| `--force-tty`      | Treat stdout as TTY even if it is not (raw passthrough).   |
| `--no-tty`         | Treat stdout as non-TTY even if it is (plain text).        |
| `--logFile <path>` | Write rendered plain text to file (in addition to stdout). |

### Environment

| Var              | Effect                                                 |
| ---------------- | ------------------------------------------------------ |
| `CY_FORCE_TTY=1` | Same as `--force-tty`.                                 |
| `NO_COLOR=1`     | Forces non-TTY mode (follows `https://no-color.org/`). |
| `CI=true`        | Forces non-TTY mode unless `--force-tty`.              |

## Examples

### Interactive (TTY)

```
$ cy hello
[ full color Claude TUI as today ]
```

### Piped

```
$ cy hello | tee out.txt
Hello! How can I help you today?
$ cat out.txt
Hello! How can I help you today?
```

### Over non-PTY SSH

```
$ ssh host 'cy --idle-timeout=10s hello'
Hello! How can I help you today?
```

### Forced

```
$ cy hello --no-tty
Hello! How can I help you today?

$ cy hello --force-tty | cat
[ raw TUI bytes — escape hatch for debugging ]
```

## Compatibility

- TTY users see no change.
- Existing scripts that parsed `cy` raw output (if any) break, but the new
  output is strictly easier to parse. A one-time migration note should be
  added to the README and CHANGELOG.
- The `--rust` and `--no-rust` modes both implement this spec; the TS path
  uses the existing strip-ansi logic in `removeControlCharacters.ts` adapted
  to the same line-commitment model.

## Implementation Plan

1. Add `vterm.scrollback_lines()` and `vterm.visible_lines()` to
   `rs/src/vterm.rs`. Cover with unit tests (cursor scroll, line clear,
   alt screen exit).
2. Add `NonTtyRenderer` in new `rs/src/non_tty_renderer.rs`. Unit-test:
   plain text, line commit, prompt trim.
3. Wire detection in `rs/src/context.rs::run_with_options`. Replace the raw
   `stdout_tx` write with a renderer-aware path when `!stdout_is_tty`.
4. Add `--force-tty` / `--no-tty` to `rs/src/cli.rs` and propagate.
5. Mirror logic in `ts/index.ts` for the non-rust path.
6. Add an integration test: spawn `cy` with stdout piped, assert the
   captured output equals the expected plain transcript.
7. CHANGELOG + README update.

## Feasibility Findings

Investigated against `vt100-ctt = "0.17.1"` and the captured raw log of a
real Claude session.

### vt100-ctt scrollback access — feasible

There is no direct `iter_scrollback()` API, but the public surface is enough:

- `Screen::set_scrollback(rows: usize)` — shifts the visible window into the
  past. Clamps to the actual scrollback length.
- `Screen::scrollback() -> usize` — returns the current offset (after clamp).
- `Screen::rows(0, cols)` — when offset is set, iterates the rows visible at
  that offset, as plain text.

Pattern to read scrollback length and content:

```rust
// Probe length by clamping a huge offset.
parser.screen_mut().set_scrollback(usize::MAX);
let len = parser.screen().scrollback();

// For each new scrollback row, shift offset and read row 0.
for i in last_known..len {
    parser.screen_mut().set_scrollback(len - i);
    let line = parser.screen().rows(0, cols).next().unwrap_or_default();
    // emit line
}

// Restore.
parser.screen_mut().set_scrollback(0);
```

The mutation is purely a read-cursor offset, not a content change, but it
_does_ take `&mut self`. We must serialise this with `vterm.process()` calls.
That is already the case — both go through the single `VTermProxy` mutex.

### Alt-screen TUIs change the picture — Claude is alt-screen

The captured raw log of `cy hello` shows `\x1b[?1049h` (DECSET 1049, "save
cursor and switch to alt screen") almost immediately. Claude's entire
conversational UI runs on the alt screen.

**Implication**: while alt screen is active, _nothing scrolls into scrollback_.
The whole conversation lives in a fixed-size visible buffer, with cursor moves
and line clears constantly rewriting it. A pure scrollback-based renderer
would emit _zero_ lines for a Claude session.

This invalidates the simplest version of the line-commit model. The spec
above needs the following amendments.

### Capture points (revised)

Non-TTY mode emits lines on **four** triggers:

1. **Scroll-off** (normal screen): a row leaves the top of the visible buffer.
   Same as before. Useful for line-based agents (e.g., Codex stream output)
   that never enter alt screen.
2. **Alt-screen entry**: when `screen.alternate_screen()` flips false→true,
   flush any final content from the _normal_ screen (the real shell scrollback
   plus the visible normal-screen lines that won't survive into alt screen).
3. **Alt-screen exit**: when `screen.alternate_screen()` flips true→false,
   capture the _alt screen contents_ before they vanish. This is where
   Claude's last response lives at exit.
4. **Process exit**: final flush of whichever screen is current. Covers the
   case where the agent crashes without restoring the normal screen.

### Stable-region streaming (optional, per-CLI)

For interactive sessions where the user wants to _see_ the response as it
arrives (not only at exit), a per-CLI heuristic can emit a "stable region"
mid-session:

- Identify the row range that holds the assistant's response (for Claude:
  rows starting with `● `, until the row that holds the input prompt).
- Diff that region against the previous emission. When it has been stable
  for ≥ 300 ms, emit the new tail as plain text.
- Lives in `agentRegistry` as a per-CLI extractor; agents without an
  extractor fall back to "emit only on exit".

This is **out of scope for the first cut**. The first cut emits at exit only,
which is correct (if delayed) for every CLI we support.

### Mutation safety

`set_scrollback` and the alt-screen state read both require coordination with
the existing `vterm.process()` and `vterm.take_responses()` calls. All three
live behind the same `VTermProxy`, so the only requirement is that the new
APIs are added as methods on `VTermProxy` and don't introduce a second lock.
No interior mutability beyond the existing pattern is needed.

### Performance

- Scroll-off probe: one `set_scrollback(MAX)` + one `scrollback()` read per
  chunk. O(1).
- Reading scrollback rows: O(new_lines × cols). Bounded by chunk size
  (≤ 8 KB / chunk) and configured scrollback (default in vt100-ctt is 0;
  we will request a few thousand).
- Restoring offset: O(1).

No measurable perf risk. The renderer runs on the main loop after `process()`,
which already iterates the chunk byte-by-byte.

## Open Questions

- **Mid-session streaming**: does v1 ship exit-only, or do we include a Claude
  extractor that streams the response as soon as it stabilises? Recommend
  exit-only for v1 to keep the surface small.
- **Alt-screen entry flush**: is there ever meaningful content on the normal
  screen before Claude jumps to alt screen? (Captured log: only the
  `agent-yes vX.Y.Z` info line, which is fine to emit.)

### Per-CLI alt-screen survey

Confirmed empirically by running each agent through `cy` and grepping the
captured raw output for DECSET 1049 (`\x1b[?1049h` / `\x1b[?1049l`) and
related private mode toggles `?47` / `?1047` / `?1048`.

| CLI                                                | Alt screen? | Notes                                                                                                             |
| -------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------- |
| claude                                             | **Yes**     | DECSET 1049 fires immediately at startup; entire conversation runs on alt screen.                                 |
| codex                                              | **No**      | No `?1049` / `?47` / `?1047` / `?1048` in captured output. Uses cursor positioning + colors on the normal screen. |
| gemini                                             | unknown     | Not installed on test host; survey before v1 ship.                                                                |
| amp, auggie, qwen, grok, copilot, cursor, opencode | unknown     | Survey before v1 ship.                                                                                            |

**Implication**: the renderer must support **both** modes. Codex sessions
benefit from the simple scrollback model alone; Claude sessions need the
alt-screen capture hook. The four-trigger model in [Capture
points](#capture-points-revised) covers both with no per-CLI branching.

### Codex-specific consideration

Codex does not enter alt screen, so its output naturally produces scrollback
as the conversation grows. The spec applies as-is, but two pitfalls noted in
the captured log:

1. Codex emits its own cursor-move / color sequences inside the normal screen
   (e.g., `\x1b[3;1H` to print error help in a fixed position). The vterm
   renders these correctly; the line that ends up at row 3 is what gets
   committed when it later scrolls off.
2. Codex declines unknown flags noisily. Argument routing
   (`agent-yes <args> -- codex <args>`) must be solid before users hit
   "codex: unexpected argument '--idle-timeout'". This is a pre-existing
   issue, but it makes spec testing of codex sessions harder and should be
   fixed alongside.

- **Scrollback size**: vt100-ctt default is 0 rows of scrollback. We need to
  pass a non-zero value when constructing the parser. 10000 rows × 80 cols
  ≈ 800 KB per session — acceptable. Confirm vt100-ctt's `Parser::new` /
  `Screen::new` actually accepts a scrollback length.
