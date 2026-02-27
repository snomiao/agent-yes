//! Agent context and main orchestrator

use crate::config::CliConfig;
use crate::idle_waiter::IdleWaiter;
use crate::messaging::{send_ctrl_c, send_enter, send_text, MessageContext};
use crate::pty_spawner::PtyContext;
use crate::ready_manager::ReadyManager;
use crate::utils::{remove_control_characters, sleep_ms};
use anyhow::Result;
use crossterm::terminal;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

const HEARTBEAT_INTERVAL_MS: u64 = 800;
const FORCE_READY_TIMEOUT_MS: u64 = 10000;

/// Agent context - centralized session state
pub struct AgentContext {
    pub cli: String,
    pub cli_config: CliConfig,
    pub verbose: bool,
    pub robust: bool,
    pub auto_yes_enabled: bool,
    pub is_fatal: bool,
    pub is_user_abort: bool,
    pub should_restart_without_continue: bool,

    // State managers
    pub stdin_ready: ReadyManager,
    pub stdin_first_ready: ReadyManager,
    pub next_stdout: ReadyManager,
    pub idle_waiter: IdleWaiter,

    // Buffer for pattern matching
    output_buffer: String,
    rendered_output: String,
    start_time: Instant,
}

impl AgentContext {
    pub fn new(
        cli: String,
        cli_config: CliConfig,
        verbose: bool,
        robust: bool,
        auto_yes_enabled: bool,
    ) -> Self {
        Self {
            cli,
            cli_config,
            verbose,
            robust,
            auto_yes_enabled,
            is_fatal: false,
            is_user_abort: false,
            should_restart_without_continue: false,
            stdin_ready: ReadyManager::new(),
            stdin_first_ready: ReadyManager::new(),
            next_stdout: ReadyManager::new(),
            idle_waiter: IdleWaiter::new(),
            output_buffer: String::new(),
            rendered_output: String::new(),
            start_time: Instant::now(),
        }
    }

    /// Run the main agent loop
    pub async fn run(&mut self, pty: &mut PtyContext, timeout_ms: Option<u64>) -> Result<i32> {
        let writer = pty.get_writer();
        let reader = pty.get_reader();

        // Create message context
        let mut msg_ctx = MessageContext::new(
            writer.clone(),
            self.idle_waiter.clone(),
            self.stdin_ready.clone(),
            self.next_stdout.clone(),
        );

        // Channel for stdin data
        let (stdin_tx, mut stdin_rx) = mpsc::channel::<Vec<u8>>(100);

        // Spawn stdin reader task
        let stdin_handle = tokio::spawn(async move {
            let mut stdin = tokio::io::stdin();
            let mut buf = [0u8; 1024];
            loop {
                match stdin.read(&mut buf).await {
                    Ok(0) => break,
                    Ok(n) => {
                        if stdin_tx.send(buf[..n].to_vec()).await.is_err() {
                            break;
                        }
                    }
                    Err(e) => {
                        error!("stdin read error: {}", e);
                        break;
                    }
                }
            }
        });

        // Main loop
        let mut heartbeat = tokio::time::interval(Duration::from_millis(HEARTBEAT_INTERVAL_MS));
        let mut force_ready_sent = false;
        let exit_code: i32;

        // Set terminal to raw mode for proper signal handling
        let _raw_mode = terminal::enable_raw_mode();

        loop {
            tokio::select! {
                // Heartbeat for pattern detection
                _ = heartbeat.tick() => {
                    self.heartbeat_check(&mut msg_ctx).await?;

                    // Force ready after timeout
                    if !force_ready_sent && self.start_time.elapsed().as_millis() > FORCE_READY_TIMEOUT_MS as u128 {
                        if !self.stdin_ready.is_ready().await {
                            debug!("Force ready after timeout");
                            self.stdin_ready.ready().await;
                            self.stdin_first_ready.ready().await;
                            force_ready_sent = true;
                        }
                    }
                }

                // Stdin data
                Some(data) = stdin_rx.recv() => {
                    // Check for Ctrl+C
                    if data.contains(&0x03) {
                        // Only abort if stdin not ready (still loading)
                        if !self.stdin_ready.is_ready().await {
                            info!("User aborted: SIGINT");
                            self.is_user_abort = true;
                            send_ctrl_c(&writer)?;
                            exit_code = 130;
                            break;
                        } else {
                            // Forward Ctrl+C to agent
                            send_ctrl_c(&writer)?;
                        }
                    }
                    // Check for Ctrl+Y (toggle auto-yes)
                    else if data.contains(&0x19) {
                        self.auto_yes_enabled = !self.auto_yes_enabled;
                        if self.auto_yes_enabled {
                            eprintln!("\r\n[auto-yes: ON]\r");
                        } else {
                            eprintln!("\r\n[auto-yes: OFF]\r");
                            self.stdin_ready.ready().await;
                        }
                    }
                    // Check for /auto command
                    else if let Ok(text) = String::from_utf8(data.clone()) {
                        if text.trim() == "/auto" {
                            self.auto_yes_enabled = !self.auto_yes_enabled;
                            if self.auto_yes_enabled {
                                eprintln!("\r\n[auto-yes: ON]\r");
                            } else {
                                eprintln!("\r\n[auto-yes: OFF]\r");
                            }
                            continue;
                        }
                        // Forward to PTY if ready
                        if self.stdin_ready.is_ready().await || !self.auto_yes_enabled {
                            let mut w = writer.lock().map_err(|e| anyhow::anyhow!("Lock: {}", e))?;
                            w.write_all(&data)?;
                            w.flush()?;
                            self.idle_waiter.ping();
                        }
                    }
                }

                // Check for process exit
                _ = sleep_ms(100) => {
                    // Try to read output
                    if let Ok(Some(output)) = self.read_pty_output(&reader) {
                        self.handle_output(&output, &mut msg_ctx).await?;
                    }

                    // Check if process has exited
                    if let Ok(Some(status)) = pty.try_wait() {
                        let code = status.exit_code() as i32;
                        if self.is_user_abort {
                            exit_code = 130;
                        } else {
                            exit_code = code;
                        }
                        break;
                    }

                    // Check for idle timeout
                    if let Some(timeout) = timeout_ms {
                        if self.idle_waiter.idle_time_ms() > timeout {
                            // Check if still working
                            let is_working = self.cli_config.working.iter()
                                .any(|p| p.is_match(&self.output_buffer));

                            if !is_working {
                                info!("Idle timeout reached, exiting");
                                // Send exit command
                                for cmd in &self.cli_config.exit_command {
                                    send_text(&msg_ctx, cmd).await?;
                                    send_text(&msg_ctx, "\n").await?;
                                }
                                exit_code = 0;
                                break;
                            }
                        }
                    }
                }
            }
        }

        // Restore terminal mode
        let _ = terminal::disable_raw_mode();

        // Cancel stdin reader
        stdin_handle.abort();

        // Print final newline
        if self.is_user_abort {
            eprintln!("\r\nUser aborted: SIGINT\r");
        }

        Ok(exit_code)
    }

    /// Read PTY output
    fn read_pty_output(&self, reader: &Arc<Mutex<Box<dyn Read + Send>>>) -> Result<Option<String>> {
        let mut reader = reader.lock().map_err(|e| anyhow::anyhow!("Lock: {}", e))?;
        let mut buf = vec![0u8; 4096];
        match reader.read(&mut buf) {
            Ok(0) => Ok(None),
            Ok(n) => Ok(Some(String::from_utf8_lossy(&buf[..n]).to_string())),
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Handle PTY output
    async fn handle_output(&mut self, output: &str, msg_ctx: &mut MessageContext) -> Result<()> {
        // Write to stdout
        let mut stdout = tokio::io::stdout();
        stdout.write_all(output.as_bytes()).await?;
        stdout.flush().await?;

        // Update buffers
        self.output_buffer.push_str(output);
        self.rendered_output.push_str(&remove_control_characters(output));

        // Keep buffer size reasonable
        if self.output_buffer.len() > 100000 {
            self.output_buffer = self.output_buffer.split_off(50000);
        }

        // Mark stdout received
        self.next_stdout.ready().await;

        // Ping activity
        self.idle_waiter.ping();

        // Check patterns
        self.check_patterns(msg_ctx).await?;

        Ok(())
    }

    /// Heartbeat pattern check (for cursor-based rendering)
    async fn heartbeat_check(&mut self, msg_ctx: &mut MessageContext) -> Result<()> {
        // Handle Device Attributes request
        if self.output_buffer.contains("\x1b[c") || self.output_buffer.contains("\x1b[0c") {
            debug!("Responding to DA request");
            let mut w = msg_ctx.writer.lock().map_err(|e| anyhow::anyhow!("Lock: {}", e))?;
            w.write_all(b"\x1b[?1;2c")?; // VT100 with AVO
            w.flush()?;
        }

        // Handle cursor position request
        if self.output_buffer.contains("\x1b[6n") {
            debug!("Responding to cursor position request");
            let mut w = msg_ctx.writer.lock().map_err(|e| anyhow::anyhow!("Lock: {}", e))?;
            w.write_all(b"\x1b[1;1R")?; // Position 1,1
            w.flush()?;
        }

        // Check patterns on heartbeat (for no-EOL CLIs)
        if self.cli_config.no_eol {
            self.check_patterns(msg_ctx).await?;
        }

        Ok(())
    }

    /// Check patterns and respond accordingly
    async fn check_patterns(&mut self, msg_ctx: &mut MessageContext) -> Result<()> {
        let buffer = &self.output_buffer;

        // Check fatal patterns first
        for pattern in &self.cli_config.fatal {
            if pattern.is_match(buffer) {
                error!("Fatal pattern matched: {}", pattern);
                self.is_fatal = true;
                return Ok(());
            }
        }

        // Check restart-without-continue patterns
        for pattern in &self.cli_config.restart_without_continue {
            if pattern.is_match(buffer) {
                warn!("Restart without continue pattern matched");
                self.should_restart_without_continue = true;
            }
        }

        // Check ready patterns
        for pattern in &self.cli_config.ready {
            if pattern.is_match(buffer) {
                if !self.stdin_ready.is_ready().await {
                    debug!("Ready pattern matched");
                    self.stdin_ready.ready().await;
                    self.stdin_first_ready.ready().await;
                }
                break;
            }
        }

        // If auto-yes is disabled, don't auto-respond
        if !self.auto_yes_enabled {
            return Ok(());
        }

        // Check typing response patterns
        for (response, patterns) in &self.cli_config.typing_respond {
            for pattern in patterns {
                if pattern.is_match(buffer) {
                    debug!("Typing response pattern matched, sending: {:?}", response);
                    send_text(msg_ctx, response).await?;
                    // Clear buffer to prevent re-triggering
                    self.output_buffer.clear();
                    return Ok(());
                }
            }
        }

        // Check enter patterns
        for pattern in &self.cli_config.enter {
            if pattern.is_match(buffer) {
                debug!("Enter pattern matched");
                send_enter(msg_ctx, 1000).await?;
                // Clear buffer to prevent re-triggering
                self.output_buffer.clear();
                return Ok(());
            }
        }

        Ok(())
    }
}
