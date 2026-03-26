//! Webhook notifications — HTTP call on agent state changes
//! Reads AGENT_YES_MESSAGE_WEBHOOK env var (URL template with %s placeholder).

use tracing::{debug, warn};

/// Fire-and-forget webhook notification. No-op if env var not set.
pub fn notify(status: &str, details: &str, cwd: &str) {
    let url_template = match std::env::var("AGENT_YES_MESSAGE_WEBHOOK") {
        Ok(v) if !v.is_empty() => v,
        _ => return,
    };

    let host = hostname();
    let message = format!("[{}] {}:{} {}", status, host, cwd, details);
    let encoded = percent_encode(&message);
    let url = url_template.replace("%s", &encoded);

    debug!("Webhook notify: {} → {}", status, &url[..url.len().min(80)]);

    // Fire in background thread via curl (handles both HTTP and HTTPS, no new deps)
    std::thread::spawn(move || {
        let result = std::process::Command::new("curl")
            .args(["-s", "--max-time", "10", "-o", "/dev/null", &url])
            .status();
        match result {
            Ok(s) if s.success() => debug!("Webhook sent ok"),
            Ok(s) => warn!("Webhook curl exit: {}", s),
            Err(e) => warn!("Webhook curl failed (is curl installed?): {}", e),
        }
    });
}

fn hostname() -> String {
    #[cfg(unix)]
    {
        let mut buf = [0u8; 256];
        unsafe {
            libc::gethostname(buf.as_mut_ptr() as *mut libc::c_char, buf.len());
        }
        std::str::from_utf8(&buf)
            .unwrap_or("unknown")
            .trim_matches('\0')
            .to_string()
    }
    #[cfg(not(unix))]
    {
        std::env::var("COMPUTERNAME").unwrap_or_else(|_| "unknown".to_string())
    }
}

fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => {
                out.push('%');
                out.push_str(&format!("{:02X}", b));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_percent_encode_plain() {
        assert_eq!(percent_encode("hello"), "hello");
    }

    #[test]
    fn test_percent_encode_special() {
        assert_eq!(percent_encode("hello world"), "hello%20world");
        assert_eq!(percent_encode("a&b=c"), "a%26b%3Dc");
    }

    #[test]
    fn test_percent_encode_preserves_unreserved() {
        assert_eq!(percent_encode("a-b_c.d~e"), "a-b_c.d~e");
    }

    #[test]
    fn test_hostname_returns_string() {
        let h = hostname();
        assert!(!h.is_empty());
    }

    #[test]
    fn test_notify_noop_without_env() {
        // Should be a no-op when env var is not set
        std::env::remove_var("AGENT_YES_MESSAGE_WEBHOOK");
        notify("test", "details", "/tmp"); // should not panic
    }

    #[test]
    fn test_notify_with_env_set() {
        // Set to an invalid URL — curl will fail but notify() shouldn't panic
        std::env::set_var("AGENT_YES_MESSAGE_WEBHOOK", "http://127.0.0.1:1/test?msg=%s");
        notify("started", "test run", "/tmp/test");
        // Give background thread a moment to spawn
        std::thread::sleep(std::time::Duration::from_millis(100));
        std::env::remove_var("AGENT_YES_MESSAGE_WEBHOOK");
    }

    #[test]
    fn test_notify_with_empty_env() {
        std::env::set_var("AGENT_YES_MESSAGE_WEBHOOK", "");
        notify("test", "details", "/tmp"); // should be a no-op
        std::env::remove_var("AGENT_YES_MESSAGE_WEBHOOK");
    }

    #[test]
    fn test_percent_encode_empty() {
        assert_eq!(percent_encode(""), "");
    }

    #[test]
    fn test_percent_encode_all_special() {
        let encoded = percent_encode("@#$");
        assert_eq!(encoded, "%40%23%24");
    }
}
