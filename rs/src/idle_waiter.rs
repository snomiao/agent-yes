//! Idle detection based on activity pings

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::time::sleep;

/// Idle waiter that tracks activity and waits for idle periods
#[derive(Clone)]
pub struct IdleWaiter {
    last_activity: Arc<AtomicU64>,
    start_time: Instant,
}

impl IdleWaiter {
    /// Create a new IdleWaiter
    pub fn new() -> Self {
        let start = Instant::now();
        Self {
            last_activity: Arc::new(AtomicU64::new(0)),
            start_time: start,
        }
    }

    /// Record activity (reset idle timer)
    pub fn ping(&self) {
        let elapsed = self.start_time.elapsed().as_millis() as u64;
        self.last_activity.store(elapsed, Ordering::SeqCst);
    }

    /// Get time since last activity in milliseconds
    pub fn idle_time_ms(&self) -> u64 {
        let last = self.last_activity.load(Ordering::SeqCst);
        let now = self.start_time.elapsed().as_millis() as u64;
        now.saturating_sub(last)
    }

    /// Wait until idle for at least the specified duration
    pub async fn wait(&self, idle_ms: u64) {
        loop {
            let idle = self.idle_time_ms();
            if idle >= idle_ms {
                return;
            }
            // Wait for remaining time plus a small buffer
            let remaining = idle_ms - idle;
            sleep(Duration::from_millis(remaining.min(100))).await;
        }
    }

    /// Wait until idle or timeout
    pub async fn wait_timeout(&self, idle_ms: u64, timeout_ms: u64) -> bool {
        let deadline = self.start_time.elapsed().as_millis() as u64 + timeout_ms;

        loop {
            let now = self.start_time.elapsed().as_millis() as u64;
            if now >= deadline {
                return false;
            }

            let idle = self.idle_time_ms();
            if idle >= idle_ms {
                return true;
            }

            let remaining = idle_ms - idle;
            let time_left = deadline - now;
            let wait_time = remaining.min(time_left).min(100);
            sleep(Duration::from_millis(wait_time)).await;
        }
    }
}

impl Default for IdleWaiter {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::time::timeout;

    #[tokio::test]
    async fn test_ping_resets_idle() {
        let waiter = IdleWaiter::new();
        waiter.ping();
        assert!(waiter.idle_time_ms() < 10);

        sleep(Duration::from_millis(50)).await;
        assert!(waiter.idle_time_ms() >= 50);

        waiter.ping();
        assert!(waiter.idle_time_ms() < 10);
    }

    #[tokio::test]
    async fn test_wait_returns_after_idle() {
        let waiter = IdleWaiter::new();
        waiter.ping();

        // Wait for 50ms idle - should complete after ~50ms
        let result = timeout(Duration::from_millis(200), waiter.wait(50)).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_wait_blocked_by_activity() {
        let waiter = IdleWaiter::new();
        let waiter_clone = waiter.clone();

        // Keep pinging every 20ms
        let pinger = tokio::spawn(async move {
            for _ in 0..5 {
                waiter_clone.ping();
                sleep(Duration::from_millis(20)).await;
            }
        });

        // Try to wait for 100ms idle - should timeout before pinger stops
        let result = timeout(Duration::from_millis(80), waiter.wait(100)).await;
        assert!(result.is_err());

        pinger.abort();
    }
}
