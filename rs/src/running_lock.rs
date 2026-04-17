//! File-based process lock — prevents concurrent agent-yes runs in the same directory.
//! Lock file: ~/.agent-yes/running.lock.json

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::Duration;
use tracing::{debug, info, warn};

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Task {
    pid: u32,
    cwd: String,
    git_root: Option<String>,
    prompt: Option<String>,
    status: String, // "running"
    started_at: i64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct LockFile {
    tasks: Vec<Task>,
}

pub struct RunningLock {
    path: PathBuf,
    pid: u32,
    cwd: String,
}

impl RunningLock {
    pub fn new(cwd: &str) -> Self {
        Self {
            path: lock_path(),
            pid: std::process::id(),
            cwd: cwd.to_string(),
        }
    }

    /// Acquire lock. Polls every 2s if another agent holds it for the same git root/cwd.
    pub async fn acquire(&self, prompt: Option<&str>) -> Result<()> {
        self.clean_stale();

        let git_root = get_git_root(&self.cwd);
        let lock_key = git_root.as_deref().unwrap_or(&self.cwd).to_string();

        let mut waited_secs = 0u64;
        loop {
            let lock = self.read().unwrap_or_default();
            let blocker = lock.tasks.iter().find(|t| {
                t.pid != self.pid
                    && t.status == "running"
                    && t.git_root.as_deref().unwrap_or(&t.cwd) == lock_key
            });

            match blocker {
                None => break,
                Some(b) => {
                    if waited_secs == 0 {
                        eprintln!(
                            "[agent-yes] Waiting for lock held by PID {} in {} (press Ctrl+C to abort)",
                            b.pid, b.cwd
                        );
                    }
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    waited_secs += 2;
                    if waited_secs % 30 == 0 {
                        info!(
                            "Still waiting for lock after {}s (PID {} in {})",
                            waited_secs, b.pid, b.cwd
                        );
                    }
                    self.clean_stale();
                }
            }
        }

        // Register ourselves
        let task = Task {
            pid: self.pid,
            cwd: self.cwd.clone(),
            git_root,
            prompt: prompt.map(|s| s.to_string()),
            status: "running".to_string(),
            started_at: chrono::Utc::now().timestamp_millis(),
        };
        let mut lock = self.read().unwrap_or_default();
        lock.tasks.retain(|t| t.pid != self.pid);
        lock.tasks.push(task);
        self.write(&lock)?;
        debug!("Lock acquired (PID {})", self.pid);
        Ok(())
    }

    pub fn release(&self) {
        let mut lock = self.read().unwrap_or_default();
        lock.tasks.retain(|t| t.pid != self.pid);
        if let Err(e) = self.write(&lock) {
            warn!("RunningLock: release failed: {}", e);
        }
        debug!("Lock released (PID {})", self.pid);
    }

    fn clean_stale(&self) {
        let mut lock = self.read().unwrap_or_default();
        lock.tasks
            .retain(|t| crate::pid_store::is_process_alive(t.pid));
        if let Err(e) = self.write(&lock) {
            warn!("RunningLock: failed to write after clean_stale: {}", e);
        }
    }

    fn read(&self) -> Result<LockFile> {
        if !self.path.exists() {
            return Ok(LockFile::default());
        }
        let content = fs::read_to_string(&self.path)?;
        Ok(serde_json::from_str(&content).unwrap_or_default())
    }

    fn write(&self, lock: &LockFile) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let tmp = self.path.with_extension("tmp");
        fs::write(&tmp, serde_json::to_string_pretty(lock)?)?;
        fs::rename(&tmp, &self.path)?;
        Ok(())
    }
}

impl Drop for RunningLock {
    fn drop(&mut self) {
        self.release();
    }
}

fn lock_path() -> PathBuf {
    crate::log_files::log_dir()
        .unwrap_or_else(|| PathBuf::from(".agent-yes"))
        .join("running.lock.json")
}

fn get_git_root(cwd: &str) -> Option<String> {
    std::process::Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(cwd)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_lock(dir: &std::path::Path) -> RunningLock {
        RunningLock {
            path: dir.join("running.lock.json"),
            pid: std::process::id(),
            cwd: "/tmp/test".to_string(),
        }
    }

    #[test]
    fn test_read_empty() {
        let dir = tempfile::tempdir().unwrap();
        let lock = test_lock(dir.path());
        let file = lock.read().unwrap();
        assert!(file.tasks.is_empty());
    }

    #[test]
    fn test_write_and_read() {
        let dir = tempfile::tempdir().unwrap();
        let lock = test_lock(dir.path());
        let data = LockFile {
            tasks: vec![Task {
                pid: 42,
                cwd: "/tmp".into(),
                git_root: Some("/repo".into()),
                prompt: Some("test".into()),
                status: "running".into(),
                started_at: 1000,
            }],
        };
        lock.write(&data).unwrap();
        let loaded = lock.read().unwrap();
        assert_eq!(loaded.tasks.len(), 1);
        assert_eq!(loaded.tasks[0].pid, 42);
        assert_eq!(loaded.tasks[0].cwd, "/tmp");
        assert_eq!(loaded.tasks[0].git_root, Some("/repo".into()));
    }

    #[tokio::test]
    async fn test_acquire_and_release() {
        let dir = tempfile::tempdir().unwrap();
        let lock = test_lock(dir.path());
        lock.acquire(Some("hello")).await.unwrap();
        let file = lock.read().unwrap();
        assert_eq!(file.tasks.len(), 1);
        assert_eq!(file.tasks[0].status, "running");
        lock.release();
        let file = lock.read().unwrap();
        assert!(file.tasks.is_empty());
    }

    #[test]
    fn test_clean_stale_removes_dead_pids() {
        let dir = tempfile::tempdir().unwrap();
        let lock = test_lock(dir.path());
        let data = LockFile {
            tasks: vec![Task {
                pid: 999999, // almost certainly dead
                cwd: "/tmp".into(),
                git_root: None,
                prompt: None,
                status: "running".into(),
                started_at: 0,
            }],
        };
        lock.write(&data).unwrap();
        lock.clean_stale();
        let file = lock.read().unwrap();
        assert!(file.tasks.is_empty());
    }

    #[test]
    fn test_drop_releases_lock() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("running.lock.json");
        {
            let lock = RunningLock {
                path: path.clone(),
                pid: std::process::id(),
                cwd: "/tmp".into(),
            };
            let data = LockFile {
                tasks: vec![Task {
                    pid: std::process::id(),
                    cwd: "/tmp".into(),
                    git_root: None,
                    prompt: None,
                    status: "running".into(),
                    started_at: 0,
                }],
            };
            lock.write(&data).unwrap();
        } // drop here
        let content = fs::read_to_string(&path).unwrap();
        let file: LockFile = serde_json::from_str(&content).unwrap();
        assert!(file.tasks.is_empty());
    }

    #[test]
    fn test_get_git_root_in_repo() {
        // We're in a git repo, so this should return something
        let root = get_git_root(".");
        assert!(root.is_some());
    }

    #[test]
    fn test_get_git_root_outside_repo() {
        let root = get_git_root("/");
        assert!(root.is_none());
    }

    #[tokio::test]
    async fn test_acquire_with_stale_blocker() {
        let dir = tempfile::tempdir().unwrap();
        let lock = test_lock(dir.path());
        // Write a stale lock from a dead PID
        let data = LockFile {
            tasks: vec![Task {
                pid: 999999, // dead PID
                cwd: "/tmp/test".into(),
                git_root: None,
                prompt: None,
                status: "running".into(),
                started_at: 0,
            }],
        };
        lock.write(&data).unwrap();
        // acquire should clean stale and succeed immediately
        lock.acquire(Some("test")).await.unwrap();
        let file = lock.read().unwrap();
        assert_eq!(file.tasks.len(), 1);
        assert_eq!(file.tasks[0].pid, std::process::id());
    }

    #[test]
    fn test_new_uses_current_pid() {
        let lock = RunningLock::new("/tmp");
        assert_eq!(lock.pid, std::process::id());
        assert_eq!(lock.cwd, "/tmp");
    }

    #[test]
    fn test_lock_path_fn() {
        let path = lock_path();
        assert!(path.ends_with("running.lock.json"));
    }
}
