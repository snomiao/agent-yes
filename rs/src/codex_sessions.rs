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
/// Returns `None` quickly if the output contains no `-` characters.
pub fn extract_session_id(output: &str) -> Option<String> {
    // Fast path: UUIDs always contain dashes
    if !output.contains('-') {
        return None;
    }
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
    // xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx  (36 chars total, 4 dashes)
    let pattern = [8, 4, 4, 4, 12];
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
    // Must not be adjacent to alphanumeric (avoid matching substrings of longer tokens)
    let before_ok = i == 0 || !b[i - 1].is_ascii_alphanumeric();
    let after_ok = pos >= b.len() || !b[pos].is_ascii_alphanumeric();
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
        assert_eq!(
            extract_session_id("xa1b2c3d4-e5f6-7890-abcd-ef1234567890"),
            None
        );
    }

    #[test]
    fn test_uuid_at_end() {
        assert_eq!(
            extract_session_id("id=a1b2c3d4-e5f6-7890-abcd-ef1234567890"),
            Some("a1b2c3d4-e5f6-7890-abcd-ef1234567890".into())
        );
    }

    #[test]
    fn test_no_dash_fast_path() {
        assert_eq!(extract_session_id("no dashes at all"), None);
    }

    #[test]
    fn test_load_save_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sessions.json");
        let mut map = HashMap::new();
        map.insert(
            "/tmp/test".to_string(),
            SessionEntry {
                session_id: "abc-123".into(),
                last_used: "2024-01-01T00:00:00Z".into(),
            },
        );
        save(&path, &map).unwrap();
        let loaded = load(&path).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded["/tmp/test"].session_id, "abc-123");
    }

    #[test]
    fn test_load_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nonexistent.json");
        let map = load(&path).unwrap();
        assert!(map.is_empty());
    }

    #[test]
    fn test_is_uuid_at_valid() {
        let s = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
        assert!(is_uuid_at(s.as_bytes(), 0));
    }

    #[test]
    fn test_is_uuid_at_invalid() {
        let s = "not-a-uuid-at-all-nope-nopey123nope";
        assert!(!is_uuid_at(s.as_bytes(), 0));
    }

    #[test]
    fn test_sessions_path_exists() {
        let path = sessions_path();
        assert!(path.ends_with("codex-sessions.json"));
    }

    #[test]
    fn test_store_and_get_session() {
        // Use a temp dir and test via save/load directly
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sessions.json");

        // Store
        let mut map = load(&path).unwrap_or_default();
        map.insert(
            "/tmp/myproject".to_string(),
            SessionEntry {
                session_id: "deadbeef-1234-5678-abcd-ef0123456789".into(),
                last_used: chrono::Utc::now().to_rfc3339(),
            },
        );
        save(&path, &map).unwrap();

        // Get
        let loaded = load(&path).unwrap();
        let entry = loaded.get("/tmp/myproject").unwrap();
        assert_eq!(entry.session_id, "deadbeef-1234-5678-abcd-ef0123456789");
    }

    #[test]
    fn test_save_creates_parent_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("dir").join("sessions.json");
        let map = HashMap::new();
        save(&path, &map).unwrap();
        assert!(path.exists());
    }

    #[test]
    fn test_get_session_missing_cwd() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sessions.json");
        let mut map = HashMap::new();
        map.insert(
            "/existing".to_string(),
            SessionEntry {
                session_id: "abc".into(),
                last_used: "now".into(),
            },
        );
        save(&path, &map).unwrap();
        let loaded = load(&path).unwrap();
        assert!(loaded.get("/nonexistent").is_none());
    }
}
