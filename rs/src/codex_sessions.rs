//! Codex session ID extraction and persistence for crash resume.
//! Map file: ~/.config/agent-yes/codex-sessions.json

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use tracing::warn;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SessionEntry {
    #[serde(rename = "sessionId")]
    session_id: String,
    #[serde(rename = "lastUsed")]
    last_used: String,
}

type SessionMap = HashMap<String, SessionEntry>;

/// Extract the first UUID (v4 format) found in a chunk of output.
pub fn extract_session_id(output: &str) -> Option<String> {
    // UUID pattern: 8-4-4-4-12 lowercase hex
    let mut i = 0;
    let b = output.as_bytes();
    while i + 36 <= b.len() {
        if is_uuid_at(b, i) {
            return Some(output[i..i + 36].to_string());
        }
        i += 1;
    }
    None
}

fn is_uuid_at(b: &[u8], i: usize) -> bool {
    // xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    let pattern = [8, 4, 4, 4, 12];
    let dashes = [8, 13, 18, 23];
    let mut pos = i;
    for (seg, &len) in pattern.iter().enumerate() {
        for _ in 0..len {
            if pos >= b.len() || !b[pos].is_ascii_hexdigit() {
                return false;
            }
            pos += 1;
        }
        if seg < 4 {
            if pos >= b.len() || b[pos] != b'-' {
                return false;
            }
            pos += 1;
        }
    }
    // Ensure not surrounded by hex/alphanum (to avoid matching inside longer strings)
    let before_ok = i == 0 || !b[i - 1].is_ascii_alphanumeric();
    let after_ok = pos >= b.len() || !b[pos].is_ascii_alphanumeric();
    let _ = dashes; // verified inline above
    before_ok && after_ok
}

/// Persist a session ID for a working directory.
pub fn store_session(cwd: &str, session_id: &str) {
    let path = sessions_path();
    let result = (|| -> Result<()> {
        let mut map = load(&path).unwrap_or_default();
        map.insert(
            cwd.to_string(),
            SessionEntry {
                session_id: session_id.to_string(),
                last_used: chrono::Utc::now().to_rfc3339(),
            },
        );
        save(&path, &map)
    })();
    if let Err(e) = result {
        warn!("codex_sessions: store failed: {}", e);
    }
}

/// Retrieve the last stored session ID for a working directory.
pub fn get_session(cwd: &str) -> Option<String> {
    let map = load(&sessions_path()).ok()?;
    map.get(cwd).map(|e| e.session_id.clone())
}

fn sessions_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".config"))
        .join("agent-yes")
        .join("codex-sessions.json")
}

fn load(path: &PathBuf) -> Result<SessionMap> {
    if !path.exists() {
        return Ok(HashMap::new());
    }
    Ok(serde_json::from_str(&fs::read_to_string(path)?)?)
}

fn save(path: &PathBuf, map: &SessionMap) -> Result<()> {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(path, serde_json::to_string_pretty(map)?)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_uuid() {
        let s = "Session ID: a1b2c3d4-e5f6-7890-abcd-ef1234567890 done";
        assert_eq!(
            extract_session_id(s),
            Some("a1b2c3d4-e5f6-7890-abcd-ef1234567890".to_string())
        );
    }

    #[test]
    fn test_no_uuid() {
        assert_eq!(extract_session_id("no uuid here"), None);
    }

    #[test]
    fn test_uuid_boundary() {
        // Should not match if adjacent to alphanumeric
        assert_eq!(extract_session_id("xa1b2c3d4-e5f6-7890-abcd-ef1234567890"), None);
    }
}
