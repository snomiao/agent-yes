//! Ready state manager for async coordination

use std::sync::Arc;
use tokio::sync::{watch, Mutex};

/// Manages ready state for async coordination
#[derive(Clone)]
pub struct ReadyManager {
    is_ready: Arc<Mutex<bool>>,
    sender: Arc<watch::Sender<bool>>,
    receiver: watch::Receiver<bool>,
}

impl ReadyManager {
    /// Create a new ReadyManager (initially not ready)
    pub fn new() -> Self {
        let (sender, receiver) = watch::channel(false);
        Self {
            is_ready: Arc::new(Mutex::new(false)),
            sender: Arc::new(sender),
            receiver,
        }
    }

    /// Check if ready
    pub async fn is_ready(&self) -> bool {
        *self.is_ready.lock().await
    }

    /// Wait until ready
    pub async fn wait(&mut self) {
        // If already ready, return immediately
        if *self.receiver.borrow() {
            return;
        }

        // Wait for the ready signal
        let _ = self.receiver.wait_for(|&ready| ready).await;
    }

    /// Wait with timeout
    pub async fn wait_timeout(&mut self, timeout: std::time::Duration) -> bool {
        if *self.receiver.borrow() {
            return true;
        }

        tokio::select! {
            result = self.receiver.wait_for(|&ready| ready) => result.is_ok(),
            _ = tokio::time::sleep(timeout) => false,
        }
    }

    /// Mark as ready (unblocks all waiters)
    pub async fn ready(&self) {
        let mut is_ready = self.is_ready.lock().await;
        *is_ready = true;
        let _ = self.sender.send(true);
    }

    /// Mark as not ready
    pub async fn unready(&self) {
        let mut is_ready = self.is_ready.lock().await;
        *is_ready = false;
        let _ = self.sender.send(false);
    }
}

impl Default for ReadyManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::time::{timeout, Duration};

    #[tokio::test]
    async fn test_wait_returns_immediately_if_ready() {
        let mut manager = ReadyManager::new();
        manager.ready().await;

        let result = timeout(Duration::from_millis(100), manager.wait()).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_wait_blocks_if_not_ready() {
        let mut manager = ReadyManager::new();

        let result = timeout(Duration::from_millis(50), manager.wait()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_ready_unblocks_waiters() {
        let manager = ReadyManager::new();
        let mut manager_clone = manager.clone();

        let handle = tokio::spawn(async move {
            manager_clone.wait().await;
            true
        });

        tokio::time::sleep(Duration::from_millis(10)).await;
        manager.ready().await;

        let result = timeout(Duration::from_millis(100), handle).await;
        assert!(result.is_ok());
        assert!(result.unwrap().unwrap());
    }

    #[tokio::test]
    async fn test_unready_resets_state() {
        let manager = ReadyManager::new();
        manager.ready().await;
        assert!(manager.is_ready().await);

        manager.unready().await;
        assert!(!manager.is_ready().await);
    }

    #[tokio::test]
    async fn test_wait_timeout_success() {
        let mut manager = ReadyManager::new();
        let manager_clone = manager.clone();

        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            manager_clone.ready().await;
        });

        let result = manager.wait_timeout(Duration::from_millis(200)).await;
        assert!(result);
    }

    #[tokio::test]
    async fn test_wait_timeout_expires() {
        let mut manager = ReadyManager::new();
        let result = manager.wait_timeout(Duration::from_millis(50)).await;
        assert!(!result);
    }

    #[tokio::test]
    async fn test_wait_timeout_already_ready() {
        let mut manager = ReadyManager::new();
        manager.ready().await;
        let result = manager.wait_timeout(Duration::from_millis(50)).await;
        assert!(result);
    }

    #[test]
    fn test_default() {
        let manager = ReadyManager::default();
        // Can't call is_ready() without async, but it should construct fine
        let _ = manager;
    }
}
