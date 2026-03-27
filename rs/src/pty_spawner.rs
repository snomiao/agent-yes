//! PTY process spawner module

use crate::config::CliConfig;
use anyhow::{anyhow, Result};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use tokio::sync::mpsc;
use tracing::{debug, info};

/// Read terminal size via ioctl(TIOCGWINSZ). Returns None if stdout is not a TTY.
#[cfg(unix)]
fn ioctl_terminal_size() -> Option<(u16, u16)> {
    use std::os::unix::io::AsRawFd;
    let mut size: libc::winsize = unsafe { std::mem::zeroed() };
    if unsafe { libc::ioctl(std::io::stdout().as_raw_fd(), libc::TIOCGWINSZ, &mut size) } == 0
        && size.ws_col > 0
        && size.ws_row > 0
    {
        Some((size.ws_col.max(20), size.ws_row))
    } else {
        None
    }
}

/// Terminal size from ioctl only — use in SIGWINCH handler where COLUMNS/LINES are stale.
pub fn get_terminal_size_from_tty() -> (u16, u16) {
    #[cfg(unix)]
    if let Some(size) = ioctl_terminal_size() {
        return size;
    }
    (80, 24)
}

/// Terminal size for initial PTY spawn: COLUMNS/LINES env vars first (useful in
/// non-TTY/pipe/CI contexts), then ioctl, then (80, 24).
pub fn get_terminal_size() -> (u16, u16) {
    if let (Ok(cols), Ok(rows)) = (std::env::var("COLUMNS"), std::env::var("LINES")) {
        if let (Ok(cols), Ok(rows)) = (cols.parse::<u16>(), rows.parse::<u16>()) {
            return (cols.max(20), rows);
        }
    }
    #[cfg(unix)]
    if let Some(size) = ioctl_terminal_size() {
        return size;
    }
    (80, 24)
}

/// PTY process context
pub struct PtyContext {
    pub master: Box<dyn MasterPty + Send>,
    pub child: Box<dyn portable_pty::Child + Send + Sync>,
    output_rx: mpsc::UnboundedReceiver<String>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
}

impl PtyContext {
    /// Write data to the PTY
    pub fn write(&self, data: &str) -> Result<()> {
        let mut writer = self.writer.lock().map_err(|e| anyhow!("Lock error: {}", e))?;
        writer.write_all(data.as_bytes())?;
        writer.flush()?;
        Ok(())
    }

    /// Read available data from the PTY (non-blocking via channel)
    pub fn try_recv(&mut self) -> Option<String> {
        self.output_rx.try_recv().ok()
    }

    /// Get a cloned writer for async writing
    pub fn get_writer(&self) -> Arc<Mutex<Box<dyn Write + Send>>> {
        self.writer.clone()
    }

    /// Check if child process has exited
    pub fn try_wait(&mut self) -> Result<Option<portable_pty::ExitStatus>> {
        Ok(self.child.try_wait()?)
    }

    /// Wait for child process to exit
    pub fn wait(&mut self) -> Result<portable_pty::ExitStatus> {
        Ok(self.child.wait()?)
    }

    /// Kill the child process
    pub fn kill(&mut self) -> Result<()> {
        self.child.kill()?;
        Ok(())
    }

    /// Resize the PTY
    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        // Guard against zero dimensions, which can corrupt PTY state on some platforms
        let cols = cols.max(1);
        let rows = rows.max(1);
        self.master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }
}

/// Spawn an agent process in a PTY
pub async fn spawn_agent(
    cli: &str,
    args: &[String],
    config: &CliConfig,
    cwd: &str,
    verbose: bool,
) -> Result<PtyContext> {
    let pty_system = native_pty_system();

    // Get terminal size from parent or use defaults
    let (cols, rows) = get_terminal_size();
    debug!("Using terminal size: {}x{}", cols, rows);

    // Create PTY with actual terminal size
    let pair = pty_system.openpty(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })?;

    // Destructure to get separate ownership of master and slave
    let master = pair.master;
    let slave = pair.slave;

    // Determine the binary to run
    let binary = config.binary.as_ref().map(|s| s.as_str()).unwrap_or(cli);

    // Build command - inherits parent environment by default
    // On Windows, use cmd.exe /c to resolve .cmd/.bat files via PATHEXT
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = CommandBuilder::new("cmd.exe");
        c.arg("/c");
        c.arg(binary);
        c
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = CommandBuilder::new(binary);
    for arg in args {
        cmd.arg(arg);
    }

    // Set working directory (passed from main to ensure consistency)
    cmd.cwd(cwd);

    if verbose {
        debug!("Spawning {} with args: {:?} in directory: {}", binary, args, cwd);
    }

    info!("Starting {} agent in {}...", cli, cwd);

    // Spawn the child
    let child = slave.spawn_command(cmd)?;

    // CRITICAL: Drop the slave after spawning!
    // On Unix, keeping the slave open in the parent can cause writes to fail
    // in the child because the parent still holds references to the slave PTY.
    // This is the classic PTY programming pattern: fork, then close slave in parent.
    drop(slave);

    // Get reader and writer from master
    let mut reader = master.try_clone_reader()?;
    let writer = master.take_writer()?;

    // Create unbounded channel for PTY output.
    // IMPORTANT: Must be unbounded so the reader thread never blocks —
    // if stdout isn't being read, backpressure must NOT propagate to the
    // agent CLI. The agent must keep running regardless.
    // Memory is bounded by the 100KB output_buffer cap in context.rs.
    let (output_tx, output_rx) = mpsc::unbounded_channel::<String>();

    // Spawn reader thread
    thread::spawn(move || {
        let mut buf = [0u8; 8192];  // 8KB buffer like bun-pty
        let mut partial = Vec::new(); // Buffer for incomplete UTF-8 sequences
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF
                Ok(n) => {
                    // Prepend any leftover partial bytes from previous read
                    let combined;
                    let bytes: &[u8] = if partial.is_empty() {
                        &buf[..n]
                    } else {
                        partial.extend_from_slice(&buf[..n]);
                        combined = std::mem::take(&mut partial);
                        &combined
                    };

                    let (valid, leftover) = extract_valid_utf8(bytes);

                    if !valid.is_empty() {
                        if output_tx.send(valid.to_string()).is_err() {
                            break; // Channel closed
                        }
                    }

                    // Save any trailing incomplete bytes for next read
                    partial = leftover.to_vec();
                }
                Err(e) => {
                    debug!("PTY read error: {}", e);
                    break;
                }
            }
        }
    });

    Ok(PtyContext {
        master,
        child,
        output_rx,
        writer: Arc::new(Mutex::new(writer)),
    })
}

/// Check if error is "command not found"
pub fn is_command_not_found_error(error: &str) -> bool {
    error.contains("command not found")
        || error.contains("not recognized")
        || error.contains("No such file")
        || error.contains("not found")
}

/// Extract valid UTF-8 from a byte slice, returning (valid_string, leftover_bytes).
/// Incomplete multi-byte sequences at the end are returned as leftover.
/// Invalid bytes in the middle are skipped.
pub fn extract_valid_utf8(bytes: &[u8]) -> (&str, &[u8]) {
    match std::str::from_utf8(bytes) {
        Ok(s) => (s, &[]),
        Err(e) => {
            let valid_up_to = e.valid_up_to();
            let valid_str = unsafe { std::str::from_utf8_unchecked(&bytes[..valid_up_to]) };
            match e.error_len() {
                // Incomplete sequence at end — return as leftover for next read
                None => (valid_str, &bytes[valid_up_to..]),
                // Invalid byte in the middle — skip it, no leftover
                Some(len) => {
                    // We return just the valid prefix; the caller will discard the bad byte
                    // on next iteration via the partial buffer logic
                    (valid_str, &bytes[valid_up_to + len..])
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // Serialize tests that mutate env vars — std::env::set_var is not thread-safe
    static ENV_MUTEX: Mutex<()> = Mutex::new(());

    #[test]
    fn test_is_command_not_found() {
        assert!(is_command_not_found_error("bash: foo: command not found"));
        assert!(is_command_not_found_error("'foo' is not recognized"));
        assert!(is_command_not_found_error("No such file or directory"));
        assert!(!is_command_not_found_error("Some other error"));
    }

    #[test]
    fn test_extract_valid_utf8_ascii() {
        let bytes = b"hello world";
        let (valid, leftover) = extract_valid_utf8(bytes);
        assert_eq!(valid, "hello world");
        assert!(leftover.is_empty());
    }

    #[test]
    fn test_extract_valid_utf8_complete_multibyte() {
        // 门 = E9 97 A8 (3 bytes)
        let bytes = "hello门world".as_bytes();
        let (valid, leftover) = extract_valid_utf8(bytes);
        assert_eq!(valid, "hello门world");
        assert!(leftover.is_empty());
    }

    #[test]
    fn test_extract_valid_utf8_split_at_first_byte() {
        // 门 = E9 97 A8 — only first byte present
        let bytes = &[b'h', b'i', 0xE9];
        let (valid, leftover) = extract_valid_utf8(bytes);
        assert_eq!(valid, "hi");
        assert_eq!(leftover, &[0xE9]);
    }

    #[test]
    fn test_extract_valid_utf8_split_at_second_byte() {
        // 门 = E9 97 A8 — first two bytes present
        let bytes = &[b'h', b'i', 0xE9, 0x97];
        let (valid, leftover) = extract_valid_utf8(bytes);
        assert_eq!(valid, "hi");
        assert_eq!(leftover, &[0xE9, 0x97]);
    }

    #[test]
    fn test_extract_valid_utf8_reassemble() {
        // Simulate split read: first chunk has partial 门, second has the rest
        let full = "hi门bye";
        let full_bytes = full.as_bytes();

        // Split at byte 3 (middle of 门: bytes 2,3,4 = E9,97,A8)
        let chunk1 = &full_bytes[..3]; // b"hi" + 0xE9
        let chunk2 = &full_bytes[3..]; // 0x97, 0xA8, b"bye"

        // First read
        let (valid1, leftover1) = extract_valid_utf8(chunk1);
        assert_eq!(valid1, "hi");
        assert_eq!(leftover1, &[0xE9]);

        // Second read: prepend leftover
        let mut combined = leftover1.to_vec();
        combined.extend_from_slice(chunk2);
        let (valid2, leftover2) = extract_valid_utf8(&combined);
        assert_eq!(valid2, "门bye");
        assert!(leftover2.is_empty());
    }

    #[test]
    fn test_extract_valid_utf8_emoji_split() {
        // 🦀 = F0 9F A6 80 (4 bytes)
        let full = "a🦀b";
        let full_bytes = full.as_bytes();

        // Split after 2 bytes of the emoji
        let chunk1 = &full_bytes[..3]; // b"a" + F0 9F
        let chunk2 = &full_bytes[3..]; // A6 80 b"b"

        let (valid1, leftover1) = extract_valid_utf8(chunk1);
        assert_eq!(valid1, "a");
        assert_eq!(leftover1, &[0xF0, 0x9F]);

        let mut combined = leftover1.to_vec();
        combined.extend_from_slice(chunk2);
        let (valid2, leftover2) = extract_valid_utf8(&combined);
        assert_eq!(valid2, "🦀b");
        assert!(leftover2.is_empty());
    }

    #[test]
    fn test_extract_valid_utf8_multiple_chinese_chars() {
        // Simulate the album 门 scenario with mixed CJK
        let text = "The album 门 loaded with 1 photo";
        let bytes = text.as_bytes();
        let (valid, leftover) = extract_valid_utf8(bytes);
        assert_eq!(valid, text);
        assert!(leftover.is_empty());
    }

    #[test]
    fn test_extract_valid_utf8_empty() {
        let (valid, leftover) = extract_valid_utf8(&[]);
        assert_eq!(valid, "");
        assert!(leftover.is_empty());
    }

    /// Verify that the unbounded channel never blocks the sender,
    /// even when the receiver isn't consuming messages.
    /// This simulates the scenario where stdout isn't being read
    /// but the agent CLI must keep running.
    #[test]
    fn test_unbounded_channel_no_backpressure() {
        let (tx, _rx) = mpsc::unbounded_channel::<String>();

        // Send many messages without reading — should never block
        for i in 0..5000 {
            tx.send(format!("output line {}\n", i))
                .expect("unbounded send should never fail while receiver exists");
        }

        // Sender completes instantly — no blocking occurred
        // (a bounded channel with blocking_send would stall here)
    }

    /// Spawn a real PTY, resize it, then verify the child shell sees the new dimensions via `stty size`.
    #[cfg(unix)]
    #[test]
    #[cfg_attr(tarpaulin, ignore)] // PTY child signals crash tarpaulin's ptrace
    fn test_pty_resize_reflected_in_child() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        use std::io::Read;
        use std::time::{Duration, Instant};

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .expect("openpty failed");

        let mut cmd = CommandBuilder::new("sh");
        cmd.args(["-c", "stty size"]);
        let _child = pair.slave.spawn_command(cmd).expect("spawn failed");
        drop(pair.slave);

        // Resize before the child reads its terminal attributes
        pair.master
            .resize(PtySize { rows: 40, cols: 120, pixel_width: 0, pixel_height: 0 })
            .expect("resize failed");

        // Read all output with a 2-second deadline
        let mut reader = pair.master.try_clone_reader().expect("clone reader failed");
        let mut output = String::new();
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut buf = [0u8; 256];
        loop {
            // Use a short timeout by setting the read to non-blocking after deadline
            if Instant::now() >= deadline {
                break;
            }
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => output.push_str(&String::from_utf8_lossy(&buf[..n])),
            }
            if output.contains('\n') {
                break;
            }
        }

        // `stty size` prints "rows cols\n"
        let trimmed = output.trim();
        assert!(
            trimmed.contains("40 120") || trimmed.ends_with("40 120"),
            "expected '40 120' in stty output, got: {:?}",
            trimmed
        );
    }

    #[test]
    #[cfg_attr(tarpaulin, ignore)] // PTY child signals crash tarpaulin's ptrace
    fn test_pty_resize_zero_guard() {
        use portable_pty::{native_pty_system, PtySize};

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .expect("openpty failed");

        // Build a PtyContext directly to test the zero-guard in resize()
        let (_, output_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let writer = pair.master.take_writer().expect("take_writer");
        let ctx = PtyContext {
            master: pair.master,
            child: pair.slave.spawn_command(CommandBuilder::new("true")).expect("spawn"),
            output_rx,
            writer: std::sync::Arc::new(std::sync::Mutex::new(writer)),
        };
        drop(pair.slave);

        // resize(0, 0) must not panic or return an error — guard clamps to 1x1
        ctx.resize(0, 0).expect("resize(0,0) should succeed via clamp");
        ctx.resize(0, 24).expect("resize(0,24) should succeed via clamp");
        ctx.resize(80, 0).expect("resize(80,0) should succeed via clamp");
    }

    #[test]
    fn test_get_terminal_size_returns_valid_dimensions() {
        let (cols, rows) = get_terminal_size();
        // Must always return at least 1x1 to be a valid terminal size
        assert!(cols >= 1, "cols must be >= 1, got {}", cols);
        assert!(rows >= 1, "rows must be >= 1, got {}", rows);
        // Should return at least the enforced minimum cols
        assert!(cols >= 20, "cols must be >= 20 (enforced minimum), got {}", cols);
    }

    #[test]
    fn test_get_terminal_size_env_override() {
        // COLUMNS/LINES env vars should take precedence
        // Hold ENV_MUTEX for the entire test to prevent races with other env-var tests
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("COLUMNS", "132");
        std::env::set_var("LINES", "50");
        let (cols, rows) = get_terminal_size();
        std::env::remove_var("COLUMNS");
        std::env::remove_var("LINES");
        assert_eq!(cols, 132);
        assert_eq!(rows, 50);
    }

    #[test]
    fn test_get_terminal_size_env_override_enforces_min_cols() {
        // COLUMNS below 20 should be clamped to 20
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("COLUMNS", "5");
        std::env::set_var("LINES", "24");
        let (cols, _rows) = get_terminal_size();
        std::env::remove_var("COLUMNS");
        std::env::remove_var("LINES");
        assert_eq!(cols, 20, "cols below minimum should be clamped to 20");
    }
}
