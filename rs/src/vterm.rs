//! Virtual terminal emulator proxy wrapping vt100-ctt crate.
//!
//! Replaces naive strip-ansi approach with a real terminal emulator that
//! correctly handles cursor movement, line clearing, scrolling, etc.
//! Also auto-responds to terminal queries (DSR, DA) so the child process
//! never blocks waiting for a terminal reply.

use std::sync::{Arc, Mutex};
use tracing::debug;

/// Collects terminal query responses (DSR, DA, etc.) via vt100 callbacks.
#[derive(Clone, Default)]
struct ResponseCollector {
    responses: Arc<Mutex<Vec<Vec<u8>>>>,
}

impl ResponseCollector {
    fn take_responses(&self) -> Vec<Vec<u8>> {
        let mut responses = self.responses.lock().unwrap_or_else(|e| e.into_inner());
        std::mem::take(&mut *responses)
    }

    fn push_response(&self, data: Vec<u8>) {
        let mut responses = self.responses.lock().unwrap_or_else(|e| e.into_inner());
        responses.push(data);
    }
}

impl vt100_ctt::Callbacks for ResponseCollector {
    fn unhandled_csi(
        &mut self,
        screen: &mut vt100_ctt::Screen,
        intermediates: Option<u8>,
        _ignored_excess_intermediates: Option<u8>,
        params: &[&[u16]],
        c: char,
    ) {
        // Only respond to plain (no private/intermediate marker) primary
        // DA/DSR queries. CSI '?' n / CSI '>' c etc. are private or
        // secondary forms that expect different (or no) replies.
        if intermediates.is_some() {
            return;
        }
        let param = params.first().and_then(|p| p.first()).copied().unwrap_or(0);
        match c {
            // DSR - Device Status Report
            'n' => match param {
                // ESC[5n → terminal status: respond OK (ESC[0n)
                5 => {
                    let response = b"\x1b[0n".to_vec();
                    debug!(
                        "vterm|DSR status response: {:?}",
                        String::from_utf8_lossy(&response)
                    );
                    self.push_response(response);
                }
                // ESC[6n → cursor position: respond ESC[<row>;<col>R
                6 => {
                    let (row, col) = screen.cursor_position();
                    // Terminal uses 1-based coordinates
                    let response = format!("\x1b[{};{}R", row + 1, col + 1);
                    debug!("vterm|DSR cursor response: {:?}", response);
                    self.push_response(response.into_bytes());
                }
                _ => {}
            },
            // DA - Device Attributes: ESC[c or ESC[0c → respond as VT100 with AVO
            'c' if param == 0 => {
                let response = b"\x1b[?1;2c".to_vec();
                debug!(
                    "vterm|DA response: {:?}",
                    String::from_utf8_lossy(&response)
                );
                self.push_response(response);
            }
            _ => {}
        }
    }
}

/// Virtual terminal proxy — wraps vt100-ctt::Parser to provide a rendered
/// terminal screen buffer and auto-respond to terminal queries.
pub struct VTermProxy {
    parser: vt100_ctt::Parser<ResponseCollector>,
    collector: ResponseCollector,
}

impl VTermProxy {
    /// Create a new virtual terminal with the given dimensions.
    /// Dimensions are clamped to at least 1×1 to avoid panics in the
    /// underlying vt100 parser when upstream size detection yields 0.
    pub fn new(rows: u16, cols: u16) -> Self {
        let rows = rows.max(1);
        let cols = cols.max(1);
        let collector = ResponseCollector::default();
        let parser = vt100_ctt::Parser::new_with_callbacks(rows, cols, 1000, collector.clone());
        Self { parser, collector }
    }

    /// Feed raw PTY output bytes into the terminal emulator.
    /// After calling this, check `take_responses()` for any terminal query
    /// responses that need to be written back to the PTY stdin.
    pub fn process(&mut self, data: &[u8]) {
        self.parser.process(data);
    }

    /// Take any pending terminal query responses (DSR, DA, etc.).
    /// These bytes should be written back to the child process PTY stdin.
    pub fn take_responses(&self) -> Vec<Vec<u8>> {
        self.collector.take_responses()
    }

    /// Get the full rendered terminal contents as plain text.
    /// This correctly reflects cursor movement, line clearing, overwriting, etc.
    pub fn contents(&self) -> String {
        self.parser.screen().contents()
    }

    /// Get the last N lines of the rendered terminal.
    pub fn tail(&self, n: usize) -> String {
        let screen = self.parser.screen();
        let (rows, _cols) = screen.size();
        let total = rows as usize;
        let start = total.saturating_sub(n);
        let mut lines: Vec<String> = Vec::with_capacity(n);
        for row in start..total {
            lines.push(screen.contents_between(row as u16, 0, row as u16, screen.size().1));
        }
        // Trim trailing empty lines
        while lines.len() > 1 && lines.last().map_or(false, |l| l.is_empty()) {
            lines.pop();
        }
        lines.join("\n")
    }

    /// Get the current cursor position (0-based row, col).
    pub fn cursor_position(&self) -> (u16, u16) {
        self.parser.screen().cursor_position()
    }

    /// Resize the virtual terminal. Dimensions are clamped to at least 1×1
    /// to match the same guard in `new()`.
    pub fn resize(&mut self, rows: u16, cols: u16) {
        let rows = rows.max(1);
        let cols = cols.max(1);
        self.parser.screen_mut().set_size(rows, cols);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_basic_output() {
        let mut vt = VTermProxy::new(24, 80);
        vt.process(b"Hello, World!\r\n");
        let contents = vt.contents();
        assert!(contents.contains("Hello, World!"));
    }

    #[test]
    fn test_cursor_overwrite() {
        let mut vt = VTermProxy::new(24, 80);
        // Write "AAAA", move cursor back, overwrite with "BB"
        vt.process(b"AAAA\x1b[4DBB");
        let contents = vt.contents();
        assert!(
            contents.contains("BBAA"),
            "expected 'BBAA' but got: {}",
            contents
        );
    }

    #[test]
    fn test_line_clear() {
        let mut vt = VTermProxy::new(24, 80);
        // Write text, then clear the line with ESC[2K
        vt.process(b"old text\r\x1b[2Knew text");
        let contents = vt.contents();
        assert!(
            !contents.contains("old text"),
            "old text should be cleared: {}",
            contents
        );
        assert!(contents.contains("new text"));
    }

    #[test]
    fn test_progress_bar_overwrite() {
        let mut vt = VTermProxy::new(24, 80);
        // Simulate progress bar: write, carriage return, overwrite
        vt.process(b"[##--------] 20%\r[#####-----] 50%\r[##########] 100%");
        let contents = vt.contents();
        assert!(
            contents.contains("100%"),
            "should show final state: {}",
            contents
        );
        assert!(
            !contents.contains("20%"),
            "should not show old progress: {}",
            contents
        );
    }

    #[test]
    fn test_dsr_response() {
        let mut vt = VTermProxy::new(24, 80);
        // Move cursor to row 5, col 10, then send DSR query
        vt.process(b"\x1b[5;10H\x1b[6n");
        let responses = vt.take_responses();
        assert_eq!(responses.len(), 1);
        assert_eq!(responses[0], b"\x1b[5;10R");
    }

    #[test]
    fn test_da_response() {
        let mut vt = VTermProxy::new(24, 80);
        vt.process(b"\x1b[c");
        let responses = vt.take_responses();
        assert_eq!(responses.len(), 1);
        assert_eq!(responses[0], b"\x1b[?1;2c");
    }

    #[test]
    fn test_dsr_status_response() {
        // ESC[5n → terminal OK status
        let mut vt = VTermProxy::new(24, 80);
        vt.process(b"\x1b[5n");
        let responses = vt.take_responses();
        assert_eq!(responses.len(), 1);
        assert_eq!(responses[0], b"\x1b[0n");
    }

    #[test]
    fn test_secondary_da_not_answered() {
        // ESC[>c → secondary DA, must NOT respond as primary DA
        let mut vt = VTermProxy::new(24, 80);
        vt.process(b"\x1b[>c");
        assert!(vt.take_responses().is_empty());
    }

    #[test]
    fn test_private_dsr_not_answered() {
        // ESC[?6n → DEC private DSR, must NOT respond as plain CPR
        let mut vt = VTermProxy::new(24, 80);
        vt.process(b"\x1b[?6n");
        assert!(vt.take_responses().is_empty());
    }

    #[test]
    fn test_resize() {
        let mut vt = VTermProxy::new(24, 80);
        vt.resize(30, 120);
        let (row, col) = vt.parser.screen().size();
        assert_eq!(row, 30);
        assert_eq!(col, 120);
    }

    #[test]
    fn test_zero_dimensions_clamped() {
        // Both new() and resize() must clamp 0 → 1 to avoid vt100 panics
        let mut vt = VTermProxy::new(0, 0);
        let (row, col) = vt.parser.screen().size();
        assert!(row >= 1);
        assert!(col >= 1);
        vt.resize(0, 0);
        let (row, col) = vt.parser.screen().size();
        assert!(row >= 1);
        assert!(col >= 1);
    }

    #[test]
    fn test_ansi_colors_stripped_in_contents() {
        let mut vt = VTermProxy::new(24, 80);
        vt.process(b"\x1b[31mRed\x1b[0m Normal");
        let contents = vt.contents();
        assert_eq!(contents.trim(), "Red Normal");
        assert!(!contents.contains("\x1b"));
    }

    #[test]
    fn test_screen_clear() {
        let mut vt = VTermProxy::new(24, 80);
        vt.process(b"line 1\r\nline 2\r\n\x1b[2J\x1b[1;1Hfresh start");
        let contents = vt.contents();
        assert!(contents.contains("fresh start"));
        assert!(
            !contents.contains("line 1"),
            "screen should be cleared: {}",
            contents
        );
    }
}
