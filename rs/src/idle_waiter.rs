//! Idle detection based on activity pings.
//!
//! Library-style module: `wait` / `wait_timeout` are part of the API surface
//! but only some callers are wired up today. New callers (e.g., idle-action
//! retry policies) are expected to land soon, so the helpers stay public.
#![allow(dead_code)]

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::time::sleep;

/// Idle waiter that tracks activity and waits for idle periods
#[derive(Clone)]
pub struct IdleWaiter {
    last_activity: Arc<AtomicU64>,
    start_time: Instant,
    /// Milliseconds added to the clock, shared by every clone. Tests use it to
    /// stand in for a long idle stretch instead of sleeping through one.
    skew_ms: Arc<AtomicU64>,
}

impl IdleWaiter {
    /// Create a new IdleWaiter
    pub fn new() -> Self {
        let start = Instant::now();
        Self {
            last_activity: Arc::new(AtomicU64::new(0)),
            start_time: start,
            skew_ms: Arc::new(AtomicU64::new(0)),
        }
    }

    /// Milliseconds since creation on the (possibly skewed) clock.
    fn now_ms(&self) -> u64 {
        self.start_time.elapsed().as_millis() as u64 + self.skew_ms.load(Ordering::SeqCst)
    }

    /// Record activity (reset idle timer)
    pub fn ping(&self) {
        self.last_activity.store(self.now_ms(), Ordering::SeqCst);
    }

    /// Get time since last activity in milliseconds
    pub fn idle_time_ms(&self) -> u64 {
        let last = self.last_activity.load(Ordering::SeqCst);
        self.now_ms().saturating_sub(last)
    }

    /// Move the clock forward by `ms` without waiting: the idle time grows by
    /// `ms` for this waiter and all its clones.
    #[cfg(test)]
    pub fn advance(&self, ms: u64) {
        self.skew_ms.fetch_add(ms, Ordering::SeqCst);
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

        let result = timeout(Duration::from_millis(200), waiter.wait(50)).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_wait_blocked_by_activity() {
        let waiter = IdleWaiter::new();
        let waiter_clone = waiter.clone();

        let pinger = tokio::spawn(async move {
            for _ in 0..5 {
                waiter_clone.ping();
                sleep(Duration::from_millis(20)).await;
            }
        });

        let result = timeout(Duration::from_millis(80), waiter.wait(100)).await;
        assert!(result.is_err());

        pinger.abort();
    }

    #[tokio::test]
    async fn test_wait_timeout_success() {
        let waiter = IdleWaiter::new();
        waiter.ping();
        // Wait for 50ms idle with 500ms timeout - should succeed
        let result = waiter.wait_timeout(50, 500).await;
        assert!(result);
    }

    #[tokio::test]
    async fn test_wait_timeout_expires() {
        let waiter = IdleWaiter::new();
        let waiter_clone = waiter.clone();

        // Keep pinging to prevent idle
        let pinger = tokio::spawn(async move {
            loop {
                waiter_clone.ping();
                sleep(Duration::from_millis(10)).await;
            }
        });

        // Wait for 500ms idle with 100ms timeout - should timeout
        let result = waiter.wait_timeout(500, 100).await;
        assert!(!result);

        pinger.abort();
    }

    #[test]
    fn test_default() {
        let waiter = IdleWaiter::default();
        assert!(waiter.idle_time_ms() < 10);
    }

    #[tokio::test]
    async fn test_clone() {
        let waiter = IdleWaiter::new();
        let clone = waiter.clone();
        waiter.ping();
        // Clone shares the same atomic
        assert!(clone.idle_time_ms() < 10);
    }
}
