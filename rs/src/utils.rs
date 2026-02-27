//! Utility functions

use std::time::Duration;
use tokio::time::sleep;

/// Sleep for milliseconds
pub async fn sleep_ms(ms: u64) {
    sleep(Duration::from_millis(ms)).await;
}

/// Remove ANSI control characters from string
pub fn remove_control_characters(s: &str) -> String {
    strip_ansi_escapes::strip_str(s).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_remove_control_characters() {
        let input = "\x1b[31mHello\x1b[0m World";
        let output = remove_control_characters(input);
        assert_eq!(output, "Hello World");
    }

    #[test]
    fn test_remove_cursor_movement() {
        let input = "\x1b[2J\x1b[1;1HClear and move";
        let output = remove_control_characters(input);
        assert_eq!(output, "Clear and move");
    }
}
