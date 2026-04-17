//! Message sending and keyboard simulation module

use crate::idle_waiter::IdleWaiter;
use crate::ready_manager::ReadyManager;
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
pub async fn send_message(
    ctx: &mut MessageContext,
    message: &str,
    wait_for_ready: bool,
) -> Result<()> {
    if wait_for_ready {
        ctx.stdin_ready.wait().await;
    }

    debug!("Sending message: {}", message);

    // Write the message
    {
        let mut writer = ctx
            .writer
            .lock()
            .map_err(|e| anyhow::anyhow!("Lock error: {}", e))?;
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

/// Send Enter key to the agent (non-blocking)
pub async fn send_enter(ctx: &mut MessageContext, _wait_ms: u64) -> Result<()> {
    debug!("Sending Enter");

    // Write Enter (use \r for PTY - carriage return)
    {
        let mut writer = ctx
            .writer
            .lock()
            .map_err(|e| anyhow::anyhow!("Lock error: {}", e))?;
        writer.write_all(b"\r")?;
        writer.flush()?;
    }

    // Ping activity
    ctx.idle_waiter.ping();

    // Don't block - let the main loop continue reading PTY output
    // The retry logic would cause a deadlock since we can't read PTY
    // output while blocked here

    Ok(())
}

/// Send raw text (no Enter)
pub async fn send_text(ctx: &MessageContext, text: &str) -> Result<()> {
    debug!("Sending text: {}", text);

    let mut writer = ctx
        .writer
        .lock()
        .map_err(|e| anyhow::anyhow!("Lock error: {}", e))?;
    writer.write_all(text.as_bytes())?;
    writer.flush()?;

    ctx.idle_waiter.ping();

    Ok(())
}

/// Send Ctrl+C (SIGINT)
pub fn send_ctrl_c(writer: &Arc<Mutex<Box<dyn Write + Send>>>) -> Result<()> {
    let mut writer = writer
        .lock()
        .map_err(|e| anyhow::anyhow!("Lock error: {}", e))?;
    writer.write_all(&[0x03])?; // Ctrl+C
    writer.flush()?;
    Ok(())
}

/// Send Ctrl+Y (custom toggle)
pub fn send_ctrl_y(writer: &Arc<Mutex<Box<dyn Write + Send>>>) -> Result<()> {
    let mut writer = writer
        .lock()
        .map_err(|e| anyhow::anyhow!("Lock error: {}", e))?;
    writer.write_all(&[0x19])?; // Ctrl+Y
    writer.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mock_writer() -> Arc<Mutex<Box<dyn Write + Send>>> {
        Arc::new(Mutex::new(Box::new(Vec::<u8>::new())))
    }

    #[test]
    fn test_send_ctrl_c() {
        let buf = Arc::new(Mutex::new(Vec::<u8>::new()));
        let writer: Arc<Mutex<Box<dyn Write + Send>>> =
            Arc::new(Mutex::new(Box::new(BufWriter(buf.clone()))));
        send_ctrl_c(&writer).unwrap();
        assert_eq!(*buf.lock().unwrap(), vec![0x03]);
    }

    #[test]
    fn test_send_ctrl_y() {
        let buf = Arc::new(Mutex::new(Vec::<u8>::new()));
        let writer: Arc<Mutex<Box<dyn Write + Send>>> =
            Arc::new(Mutex::new(Box::new(BufWriter(buf.clone()))));
        send_ctrl_y(&writer).unwrap();
        assert_eq!(*buf.lock().unwrap(), vec![0x19]);
    }

    #[tokio::test]
    async fn test_send_text() {
        let buf = Arc::new(Mutex::new(Vec::<u8>::new()));
        let writer: Arc<Mutex<Box<dyn Write + Send>>> =
            Arc::new(Mutex::new(Box::new(BufWriter(buf.clone()))));
        let idle_waiter = IdleWaiter::new();
        let stdin_ready = ReadyManager::new();
        let next_stdout = ReadyManager::new();
        let ctx = MessageContext::new(writer, idle_waiter, stdin_ready, next_stdout);
        send_text(&ctx, "hello").await.unwrap();
        assert_eq!(*buf.lock().unwrap(), b"hello");
    }

    #[tokio::test]
    async fn test_send_enter() {
        let buf = Arc::new(Mutex::new(Vec::<u8>::new()));
        let writer: Arc<Mutex<Box<dyn Write + Send>>> =
            Arc::new(Mutex::new(Box::new(BufWriter(buf.clone()))));
        let idle_waiter = IdleWaiter::new();
        let stdin_ready = ReadyManager::new();
        let next_stdout = ReadyManager::new();
        let mut ctx = MessageContext::new(writer, idle_waiter, stdin_ready, next_stdout);
        send_enter(&mut ctx, 0).await.unwrap();
        assert_eq!(*buf.lock().unwrap(), b"\r");
    }

    #[tokio::test]
    async fn test_send_message() {
        let buf = Arc::new(Mutex::new(Vec::<u8>::new()));
        let writer: Arc<Mutex<Box<dyn Write + Send>>> =
            Arc::new(Mutex::new(Box::new(BufWriter(buf.clone()))));
        let idle_waiter = IdleWaiter::new();
        let stdin_ready = ReadyManager::new();
        let next_stdout = ReadyManager::new();

        // Clone next_stdout to signal ready from a background task
        let next_stdout_signaler = next_stdout.clone();
        tokio::spawn(async move {
            // Signal after a short delay so send_message's wait() unblocks
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            next_stdout_signaler.ready().await;
        });

        let mut ctx = MessageContext::new(writer, idle_waiter, stdin_ready, next_stdout);
        // Don't wait for stdin_ready (false)
        send_message(&mut ctx, "test msg", false).await.unwrap();
        assert_eq!(*buf.lock().unwrap(), b"test msg\n");
    }

    #[test]
    fn test_message_context_new() {
        let writer = mock_writer();
        let idle_waiter = IdleWaiter::new();
        let stdin_ready = ReadyManager::new();
        let next_stdout = ReadyManager::new();
        let ctx = MessageContext::new(writer, idle_waiter, stdin_ready, next_stdout);
        // Just verify it constructs without panic
        let _ = ctx.writer;
    }

    /// Helper writer that delegates to a shared buffer
    struct BufWriter(Arc<Mutex<Vec<u8>>>);

    impl Write for BufWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
}
