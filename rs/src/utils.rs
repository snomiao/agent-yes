//! Utility functions

use std::time::Duration;
use tokio::time::sleep;

/// Sleep for milliseconds
pub async fn sleep_ms(ms: u64) {
    sleep(Duration::from_millis(ms)).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_sleep_ms() {
        let start = std::time::Instant::now();
        sleep_ms(50).await;
        assert!(start.elapsed().as_millis() >= 45);
    }
}
