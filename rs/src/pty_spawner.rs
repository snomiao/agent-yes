//! PTY process spawner module

use crate::config::CliConfig;
use anyhow::{anyhow, Result};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize, SlavePty};
use std::io::{BufRead, BufReader, Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use tokio::sync::mpsc;
use tracing::{debug, error, info};

/// PTY process context
pub struct PtyContext {
    pub master: Box<dyn MasterPty + Send>,
    pub child: Box<dyn portable_pty::Child + Send + Sync>,
    output_rx: mpsc::Receiver<String>,
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
    verbose: bool,
) -> Result<PtyContext> {
    let pty_system = native_pty_system();

    // Create PTY with reasonable size
    let pair = pty_system.openpty(PtySize {
        rows: 24,
        cols: 80,
        pixel_width: 0,
        pixel_height: 0,
    })?;

    // Determine the binary to run
    let binary = config.binary.as_ref().map(|s| s.as_str()).unwrap_or(cli);

    // Build command
    let mut cmd = CommandBuilder::new(binary);
    for arg in args {
        cmd.arg(arg);
    }

    // Set environment
    cmd.env("TERM", "xterm-256color");
    cmd.env("FORCE_COLOR", "1");
    cmd.env("COLORTERM", "truecolor");

    if verbose {
        debug!("Spawning {} with args: {:?}", binary, args);
    }

    info!("Starting {} agent...", cli);

    // Spawn the child
    let child = pair.slave.spawn_command(cmd)?;

    // Get reader and writer
    let mut reader = pair.master.try_clone_reader()?;
    let writer = pair.master.take_writer()?;

    // Create channel for PTY output
    let (output_tx, output_rx) = mpsc::channel::<String>(1000);

    // Spawn reader thread
    thread::spawn(move || {
        let mut buf = [0u8; 8192];  // 8KB buffer like bun-pty
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    if output_tx.blocking_send(data).is_err() {
                        break; // Channel closed
                    }
                }
                Err(e) => {
                    debug!("PTY read error: {}", e);
                    break;
                }
            }
        }
    });

    Ok(PtyContext {
        master: pair.master,
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
}
