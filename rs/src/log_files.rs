//! Per-session file logging — write raw PTY output to ~/.agent-yes/<pid>.raw.log

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tracing::warn;

/// Writes raw PTY output to a log file
pub struct LogWriter {
    file: Arc<Mutex<Option<fs::File>>>,
    pub raw_log_path: Option<PathBuf>,
}

impl LogWriter {
    pub fn new(pid: u32) -> Self {
        let (file, path) = match log_dir() {
            Some(dir) => {
                let _ = fs::create_dir_all(&dir);
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
        Self { file: Arc::new(Mutex::new(file)), raw_log_path: path }
    }

    pub fn write(&self, data: &str) {
        if let Ok(mut g) = self.file.lock() {
            if let Some(ref mut f) = *g {
                let _ = f.write_all(data.as_bytes());
            }
        }
    }
}

pub fn log_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".agent-yes"))
}
