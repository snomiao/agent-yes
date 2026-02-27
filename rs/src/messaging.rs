//! Message sending and keyboard simulation module

use crate::idle_waiter::IdleWaiter;
use crate::pty_spawner::PtyContext;
use crate::ready_manager::ReadyManager;
use crate::utils::sleep_ms;
use anyhow::Result;
use std::io::Write;
use std::sync::{Arc, Mutex};
use tracing::debug;

/// Context for sending messages
pub struct MessageContext {
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pub idle_waiter: IdleWaiter,
    pub stdin_ready: ReadyManager,
    pub next_stdout: ReadyManager,
}

impl MessageContext {
    pub fn new(
        writer: Arc<Mutex<Box<dyn Write + Send>>>,
        idle_waiter: IdleWaiter,
        stdin_ready: ReadyManager,
        next_stdout: ReadyManager,
    ) -> Self {
        Self {
            writer,
            idle_waiter,
            stdin_ready,
            next_stdout,
        }
    }
}

/// Send a message to the agent (types text and presses Enter)
pub async fn send_message(ctx: &mut MessageContext, message: &str, wait_for_ready: bool) -> Result<()> {
    if wait_for_ready {
        ctx.stdin_ready.wait().await;
    }

    debug!("Sending message: {}", message);

    // Write the message
    {
        let mut writer = ctx.writer.lock().map_err(|e| anyhow::anyhow!("Lock error: {}", e))?;
        writer.write_all(message.as_bytes())?;
        writer.write_all(b"\n")?;
        writer.flush()?;
    }

    // Mark stdin as not ready (waiting for response)
    ctx.stdin_ready.unready().await;

    // Ping activity
    ctx.idle_waiter.ping();

    // Wait for next stdout
    ctx.next_stdout.unready().await;
    ctx.next_stdout.wait().await;

    Ok(())
}

/// Send Enter key to the agent
pub async fn send_enter(ctx: &mut MessageContext, wait_ms: u64) -> Result<()> {
    debug!("Sending Enter");

    // Write Enter
    {
        let mut writer = ctx.writer.lock().map_err(|e| anyhow::anyhow!("Lock error: {}", e))?;
        writer.write_all(b"\n")?;
        writer.flush()?;
    }

    // Ping activity
    ctx.idle_waiter.ping();

    // Wait for idle
    ctx.idle_waiter.wait(wait_ms).await;

    // If no response after 1 second, try again
    let mut retries = 0;
    while retries < 2 {
        // Check if we got stdout
        if ctx.next_stdout.wait_timeout(std::time::Duration::from_millis(1000)).await {
            break;
        }

        debug!("No response after Enter, retrying...");
        {
            let mut writer = ctx.writer.lock().map_err(|e| anyhow::anyhow!("Lock error: {}", e))?;
            writer.write_all(b"\n")?;
            writer.flush()?;
        }
        retries += 1;

        if retries == 1 {
            sleep_ms(1000).await;
        } else {
            sleep_ms(3000).await;
        }
    }

    Ok(())
}

/// Send raw text (no Enter)
pub async fn send_text(ctx: &MessageContext, text: &str) -> Result<()> {
    debug!("Sending text: {}", text);

    let mut writer = ctx.writer.lock().map_err(|e| anyhow::anyhow!("Lock error: {}", e))?;
    writer.write_all(text.as_bytes())?;
    writer.flush()?;

    ctx.idle_waiter.ping();

    Ok(())
}

/// Send Ctrl+C (SIGINT)
pub fn send_ctrl_c(writer: &Arc<Mutex<Box<dyn Write + Send>>>) -> Result<()> {
    let mut writer = writer.lock().map_err(|e| anyhow::anyhow!("Lock error: {}", e))?;
    writer.write_all(&[0x03])?; // Ctrl+C
    writer.flush()?;
    Ok(())
}

/// Send Ctrl+Y (custom toggle)
pub fn send_ctrl_y(writer: &Arc<Mutex<Box<dyn Write + Send>>>) -> Result<()> {
    let mut writer = writer.lock().map_err(|e| anyhow::anyhow!("Lock error: {}", e))?;
    writer.write_all(&[0x19])?; // Ctrl+Y
    writer.flush()?;
    Ok(())
}
