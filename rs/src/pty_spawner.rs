//! PTY process spawner module

use crate::config::CliConfig;
use anyhow::{anyhow, Result};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use tokio::sync::mpsc;
use tracing::{debug, info};

/// Get terminal dimensions from parent TTY, with fallback defaults
fn get_terminal_size() -> (u16, u16) {
    // Try to get from environment first (for pipes/non-TTY)
    if let (Ok(cols), Ok(rows)) = (std::env::var("COLUMNS"), std::env::var("LINES")) {
        if let (Ok(cols), Ok(rows)) = (cols.parse::<u16>(), rows.parse::<u16>()) {
            return (cols.max(20), rows);
        }
    }

    // Try to get from TTY
    #[cfg(unix)]
    {
        use std::os::unix::io::AsRawFd;
        let fd = std::io::stdout().as_raw_fd();
        let mut size: libc::winsize = unsafe { std::mem::zeroed() };
        if unsafe { libc::ioctl(fd, libc::TIOCGWINSZ, &mut size) } == 0 {
            if size.ws_col > 0 && size.ws_row > 0 {
                return (size.ws_col.max(20), size.ws_row);
            }
        }
    }

    // Default fallback
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
}
