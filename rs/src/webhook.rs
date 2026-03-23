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
