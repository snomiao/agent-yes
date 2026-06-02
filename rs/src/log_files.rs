//! Per-session file logging.
//!
//! Durable PTY logs live under `<cwd>/.agent-yes/` so they stay with the
//! project that produced them. Machine-global runtime state such as the pid
//! index, FIFO endpoints, winsize signals, and locks lives under
//! `$AGENT_YES_HOME` or `~/.agent-yes`.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tracing::warn;

/// Writes raw PTY output to a log file
pub struct LogWriter {
    file: Arc<Mutex<Option<fs::File>>>,
    pub raw_log_path: Option<PathBuf>,
}

impl LogWriter {
    pub fn new(pid: u32, cwd: &str) -> Self {
        let (file, path) = match project_log_dir(cwd) {
            Some(dir) => {
                let _ = fs::create_dir_all(&dir);
                let _ = ensure_project_gitignore(&dir);
                let path = dir.join(format!("{}.raw.log", pid));
                match fs::OpenOptions::new().create(true).append(true).open(&path) {
                    Ok(f) => (Some(f), Some(path)),
                    Err(e) => {
                        warn!("Failed to open log file {:?}: {}", path, e);
                        (None, None)
                    }
                }
            }
            None => (None, None),
        };
        Self {
            file: Arc::new(Mutex::new(file)),
            raw_log_path: path,
        }
    }

    pub fn write(&self, data: &str) {
        if let Ok(mut g) = self.file.lock() {
            if let Some(ref mut f) = *g {
                let _ = f.write_all(data.as_bytes());
            }
        }
    }
}

pub fn global_dir() -> Option<PathBuf> {
    std::env::var_os("AGENT_YES_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".agent-yes")))
}

pub fn project_log_dir(cwd: &str) -> Option<PathBuf> {
    Some(Path::new(cwd).join(".agent-yes"))
}

fn ensure_project_gitignore(dir: &Path) -> std::io::Result<()> {
    let path = dir.join(".gitignore");
    if path.exists() {
        return Ok(());
    }
    fs::write(path, "/*\n!.gitignore\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_global_dir_returns_some() {
        let dir = global_dir();
        assert!(dir.is_some());
        assert!(dir.unwrap().ends_with(".agent-yes"));
    }

    #[test]
    fn test_project_log_dir_uses_cwd() {
        let dir = tempfile::tempdir().unwrap();
        let log_dir = project_log_dir(dir.path().to_str().unwrap()).unwrap();
        assert_eq!(log_dir, dir.path().join(".agent-yes"));
    }

    #[test]
    fn test_log_writer_new_and_write() {
        let dir = tempfile::tempdir().unwrap();
        let writer = LogWriter::new(std::process::id(), dir.path().to_str().unwrap());
        assert!(writer.raw_log_path.is_some());
        writer.write("test log line\n");
        // Verify file exists and has content
        let path = writer.raw_log_path.as_ref().unwrap();
        assert!(path.starts_with(dir.path().join(".agent-yes")));
        let content = std::fs::read_to_string(path).unwrap();
        assert!(content.contains("test log line"));
        assert!(dir.path().join(".agent-yes/.gitignore").exists());
    }

    #[test]
    fn test_log_writer_write_multiple() {
        let dir = tempfile::tempdir().unwrap();
        let writer = LogWriter::new(std::process::id() + 100000, dir.path().to_str().unwrap());
        writer.write("line1\n");
        writer.write("line2\n");
        let path = writer.raw_log_path.as_ref().unwrap();
        let content = std::fs::read_to_string(path).unwrap();
        assert!(content.contains("line1"));
        assert!(content.contains("line2"));
    }
}
