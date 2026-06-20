//! Non-TTY output rendering.
//!
//! When `cy`'s stdout is not a TTY (piped, redirected to a file, or a
//! non-PTY SSH channel), forwarding the inner agent's raw PTY byte stream
//! produces unreadable output: cursor moves, screen clears, alt-screen
//! switches, and spinner redraws layer on top of one another and the escape
//! sequences appear as literal text.
//!
//! In that case we suppress the raw passthrough and instead emit **plain
//! rendered text** — the semantic content the user would have seen on a TTY.
//! See `docs/non-tty-output.md` for the full design.
//!
//! v1 is exit-only: we don't stream mid-session. The renderer observes the
//! vterm after every chunk so it can capture the alt-screen contents before
//! they vanish (alt-screen TUIs restore the normal screen on exit, which
//! would otherwise leave us with a blank screen at flush time), then emits
//! the final rendered screen once on process exit.

use crate::vterm::VTermProxy;

/// Decide whether stdout should receive plain rendered text instead of raw
/// PTY passthrough.
///
/// Priority (highest first):
///   1. `--force-tty` / `CY_FORCE_TTY=1`  → raw passthrough (returns false)
///   2. `--no-tty`                         → plain text (returns true)
///   3. `NO_COLOR` / `CI=true`             → plain text (returns true)
///   4. autodetect: stdout is not a TTY    → plain text (returns true)
pub fn should_render_plain(force_tty: bool, no_tty: bool, stdout_is_tty: bool) -> bool {
    if force_tty {
        return false;
    }
    if no_tty {
        return true;
    }
    let env_truthy = |k: &str| {
        std::env::var(k)
            .map(|v| !v.is_empty() && v != "0")
            .unwrap_or(false)
    };
    if env_truthy("CY_FORCE_TTY") {
        return false;
    }
    if std::env::var_os("NO_COLOR").is_some() || env_truthy("CI") {
        return true;
    }
    !stdout_is_tty
}

/// Tracks alt-screen state across chunks and produces the final plain-text
/// transcript on exit.
#[derive(Default)]
pub struct NonTtyRenderer {
    in_alt: bool,
    /// Last alt-screen contents seen while alt screen was active. Preserved
    /// after the agent leaves the alt screen (which clears the live screen),
    /// so a clean exit still surfaces the conversation.
    captured_alt: Option<String>,
}

impl NonTtyRenderer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Call after every `vterm.process(chunk)`. Snapshots the alt-screen
    /// contents while it is active so they survive the eventual restore.
    pub fn observe(&mut self, vterm: &VTermProxy) {
        let now_alt = vterm.alternate_screen();
        if now_alt {
            self.captured_alt = Some(vterm.contents());
        }
        self.in_alt = now_alt;
    }

    /// Produce the final plain-text transcript to write to stdout on exit.
    ///
    /// Prefers the current live screen when it has content (covers both
    /// normal-screen agents like Codex and alt-screen agents that exit while
    /// still on the alt screen). Falls back to the last captured alt-screen
    /// contents when the agent restored an empty normal screen before exiting.
    pub fn finalize(&self, vterm: &VTermProxy) -> String {
        let current = vterm.contents();
        if !current.trim().is_empty() {
            return trim_screen(&current);
        }
        match &self.captured_alt {
            Some(alt) => trim_screen(alt),
            None => trim_screen(&current),
        }
    }
}

/// Trim a rendered screen to readable plain text: right-trim every line,
/// drop leading and trailing blank lines, and drop a trailing input-prompt
/// row when one is obvious. Internal blank lines are preserved.
pub fn trim_screen(screen: &str) -> String {
    let mut lines: Vec<&str> = screen.lines().map(|l| l.trim_end()).collect();

    // Drop trailing prompt/blank rows. Conservative: only strip rows that are
    // blank or an unambiguous input-prompt marker, never real content.
    while let Some(last) = lines.last() {
        if last.is_empty() || is_prompt_line(last) {
            lines.pop();
        } else {
            break;
        }
    }
    // Drop leading blank rows (alt screens often start with the cursor parked
    // at the top, leaving empty rows above the first real line).
    while let Some(first) = lines.first() {
        if first.is_empty() {
            lines.remove(0);
        } else {
            break;
        }
    }

    let mut out = lines.join("\n");
    if !out.is_empty() {
        out.push('\n');
    }
    out
}

/// Heuristic: is this row input-box chrome rather than real content?
/// Covers the agent's prompt row, the hint line, and the horizontal divider
/// rows that frame the input box.
fn is_prompt_line(line: &str) -> bool {
    let t = line.trim();
    if t.is_empty() {
        return true;
    }
    // A lone prompt glyph, optionally with a placeholder hint.
    if matches!(t, ">" | "❯" | "│ >" | "> │")
        || t == "? for shortcuts"
        || t.starts_with("? for shortcuts")
    {
        return true;
    }
    // A horizontal divider row framing the input box: made up only of
    // box-drawing dashes (with optional trailing prompt glyph / borders /
    // spaces), and containing at least one dash. Real conversation lines are
    // never all-dashes, and mid-transcript dividers are left alone because
    // trim only pops from the bottom.
    let mut saw_dash = false;
    let only_chrome = t.chars().all(|c| match c {
        '─' | '━' | '┄' | '┅' | '┈' | '┉' | '╌' | '╍' => {
            saw_dash = true;
            true
        }
        ' ' | '>' | '❯' | '│' => true,
        _ => false,
    });
    only_chrome && saw_dash
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vt(seq: &[u8]) -> VTermProxy {
        let mut v = VTermProxy::new(24, 80);
        v.process(seq);
        v
    }

    #[test]
    fn test_should_render_plain_force_tty_wins() {
        // force_tty beats no_tty and a non-tty stdout
        assert!(!should_render_plain(true, true, false));
    }

    #[test]
    fn test_should_render_plain_no_tty_flag() {
        assert!(should_render_plain(false, true, true));
    }

    #[test]
    fn test_should_render_plain_autodetect() {
        // No flags/env: follow stdout tty-ness.
        // (CI is set in many test environments; only assert the not-a-tty case
        // when CI/NO_COLOR aren't forcing plain anyway — both force plain too.)
        assert!(should_render_plain(false, false, false));
    }

    #[test]
    fn test_trim_screen_strips_trailing_blanks() {
        let input = "hello\nworld\n\n\n";
        assert_eq!(trim_screen(input), "hello\nworld\n");
    }

    #[test]
    fn test_trim_screen_strips_leading_blanks() {
        let input = "\n\nhello\nworld";
        assert_eq!(trim_screen(input), "hello\nworld\n");
    }

    #[test]
    fn test_trim_screen_preserves_internal_blanks() {
        let input = "a\n\nb";
        assert_eq!(trim_screen(input), "a\n\nb\n");
    }

    #[test]
    fn test_trim_screen_drops_trailing_prompt() {
        let input = "● Done.\n\n>\n";
        assert_eq!(trim_screen(input), "● Done.\n");
    }

    #[test]
    fn test_trim_screen_empty() {
        assert_eq!(trim_screen("   \n\n"), "");
    }

    #[test]
    fn test_trim_screen_drops_trailing_divider_rows() {
        // Claude's input box: two horizontal divider rows (one ends in the
        // prompt glyph) framing the prompt. Both are chrome, not content.
        let bar = "─".repeat(40);
        let input = format!("● Done.\n\n{bar}\n{bar} ❯\n");
        assert_eq!(trim_screen(&input), "● Done.\n");
    }

    #[test]
    fn test_trim_screen_preserves_internal_divider() {
        // A divider in the middle of the transcript is real content (trim only
        // pops from the bottom, stopping at the first non-chrome row).
        let bar = "─".repeat(20);
        let input = format!("intro\n{bar}\nbody text");
        assert_eq!(trim_screen(&input), format!("intro\n{bar}\nbody text\n"));
    }

    #[test]
    fn test_is_prompt_line_divider_vs_content() {
        assert!(is_prompt_line(&"─".repeat(80)));
        assert!(is_prompt_line(&format!("{} ❯", "─".repeat(60))));
        // Real content with a dash in it must not be mistaken for a divider.
        assert!(!is_prompt_line("see rs/src/cli.rs — non_tty work"));
        assert!(!is_prompt_line("● Hello"));
    }

    #[test]
    fn test_finalize_normal_screen() {
        // Codex-style: plain content on the normal screen, no alt screen.
        let mut r = NonTtyRenderer::new();
        let v = vt(b"Hello from codex\r\nsecond line\r\n");
        r.observe(&v);
        assert!(!v.alternate_screen());
        let out = r.finalize(&v);
        assert!(out.contains("Hello from codex"));
        assert!(out.contains("second line"));
        assert!(!out.contains("\x1b"));
    }

    #[test]
    fn test_finalize_exits_in_alt_screen() {
        // Claude-style: enter alt screen, draw conversation, exit while still
        // on the alt screen → finalize emits the live (alt) screen.
        let mut r = NonTtyRenderer::new();
        let v = vt(b"\x1b[?1049h\x1b[2J\x1b[HHELLO FROM ALT\r\nresponse body\r\n");
        assert!(v.alternate_screen());
        r.observe(&v);
        let out = r.finalize(&v);
        assert!(out.contains("HELLO FROM ALT"), "got: {:?}", out);
        assert!(out.contains("response body"), "got: {:?}", out);
    }

    #[test]
    fn test_finalize_captures_alt_before_restore() {
        // Draw on alt screen, observe, then leave the alt screen (which
        // restores an empty normal screen). finalize must fall back to the
        // captured alt contents rather than emitting a blank screen.
        let mut r = NonTtyRenderer::new();

        let mut v = VTermProxy::new(24, 80);
        v.process(b"\x1b[?1049h\x1b[2J\x1b[HAGENT FINAL ANSWER\r\n");
        r.observe(&v); // capture while in alt screen
        assert!(v.alternate_screen());

        // Leave alt screen — vt100 restores the (blank) normal screen.
        v.process(b"\x1b[?1049l");
        r.observe(&v);
        assert!(!v.alternate_screen());

        let out = r.finalize(&v);
        assert!(out.contains("AGENT FINAL ANSWER"), "got: {:?}", out);
    }

    #[test]
    fn test_finalize_no_ansi_in_output() {
        let mut r = NonTtyRenderer::new();
        let v = vt(b"\x1b[31mred text\x1b[0m\r\n\x1b[1mbold\x1b[0m\r\n");
        r.observe(&v);
        let out = r.finalize(&v);
        assert!(out.contains("red text"));
        assert!(out.contains("bold"));
        assert!(!out.contains('\x1b'), "ANSI leaked: {:?}", out);
    }
}
