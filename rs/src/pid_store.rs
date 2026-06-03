//! JSONL-based process registry — tracks running agent-yes processes

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use tracing::warn;

const DEFAULT_LOG_RETENTION_DAYS: i64 = 7;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PidRecord {
    pub pid: u32,
    pub cli: String,
    pub prompt: Option<String>,
    pub cwd: String,
    pub log_file: Option<String>,
    /// Path to per-pid FIFO for `cy send`. None when FIFO IPC is unavailable
    /// (Windows, or a build that disables it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fifo_file: Option<String>,
    pub status: String, // "active" | "idle" | "exited"
    pub exit_code: Option<i32>,
    pub exit_reason: Option<String>,
    pub started_at: i64, // unix ms
}

pub struct PidStore {
    path: PathBuf,
}

impl PidStore {
    pub fn new() -> Self {
        Self { path: store_path() }
    }

    #[cfg(test)]
    fn with_path(path: PathBuf) -> Self {
        Self { path }
    }

    /// Pre-FIFO API kept so embedders that don't allocate a FIFO can still
    /// register a pid record. Production agents call `register_with_fifo`.
    #[allow(dead_code)]
    pub fn register(
        &self,
        pid: u32,
        cli: &str,
        prompt: Option<&str>,
        cwd: &str,
        log_file: Option<&str>,
    ) {
        self.register_with_fifo(pid, cli, prompt, cwd, log_file, None);
    }

    pub fn register_with_fifo(
        &self,
        pid: u32,
        cli: &str,
        prompt: Option<&str>,
        cwd: &str,
        log_file: Option<&str>,
        fifo_file: Option<&str>,
    ) {
        let record = PidRecord {
            pid,
            cli: cli.to_string(),
            prompt: prompt.map(|s| s.to_string()),
            cwd: cwd.to_string(),
            log_file: log_file.map(|s| s.to_string()),
            fifo_file: fifo_file.map(|s| s.to_string()),
            status: "active".to_string(),
            exit_code: None,
            exit_reason: None,
            started_at: chrono::Utc::now().timestamp_millis(),
        };
        if let Err(e) = self.append(&record) {
            warn!("PidStore: failed to register: {}", e);
        }
    }

    pub fn update_status(
        &self,
        pid: u32,
        status: &str,
        exit_code: Option<i32>,
        exit_reason: Option<&str>,
        log_file: Option<&str>,
    ) {
        let result = (|| -> Result<()> {
            let mut records = self.read_all()?;
            for r in &mut records {
                if r.pid == pid {
                    r.status = status.to_string();
                    r.exit_code = exit_code;
                    r.exit_reason = exit_reason.map(|s| s.to_string());
                    // Only repoint the log when given one (raw -> rendered on
                    // clean exit); otherwise keep the raw path recorded at start.
                    if let Some(lf) = log_file {
                        r.log_file = Some(lf.to_string());
                    }
                }
            }
            self.write_all(&records)
        })();
        if let Err(e) = result {
            warn!("PidStore: failed to update status: {}", e);
        }
    }

    pub fn clean_stale(&self) {
        let result = (|| -> Result<()> {
            let records = self.read_all()?;
            let live: Vec<PidRecord> = records
                .into_iter()
                .filter(|r| r.status != "exited" && is_process_alive(r.pid))
                .collect();
            self.write_all(&live)
        })();
        if let Err(e) = result {
            warn!("PidStore: failed to clean stale: {}", e);
        }
    }

    pub fn prune_old_logs(&self) {
        let result = (|| -> Result<usize> {
            let records = self.read_all()?;
            let now = chrono::Utc::now().timestamp_millis();
            let max_age_ms = log_retention_ms();
            let mut removed = 0;
            for r in records {
                let dead = r.status == "exited" || !is_process_alive(r.pid);
                let old = now.saturating_sub(r.started_at) > max_age_ms;
                if !dead || !old {
                    continue;
                }
                for path in log_siblings(r.log_file.as_deref()) {
                    match fs::remove_file(&path) {
                        Ok(()) => removed += 1,
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                        Err(e) => warn!("PidStore: failed to prune log {:?}: {}", path, e),
                    }
                }
            }
            Ok(removed)
        })();
        match result {
            Ok(removed) if removed > 0 => {
                tracing::debug!("PidStore: pruned {} stale log file(s)", removed);
            }
            Ok(_) => {}
            Err(e) => warn!("PidStore: failed to prune old logs: {}", e),
        }
    }

    fn append(&self, record: &PidRecord) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let line = serde_json::to_string(record)? + "\n";
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        file.write_all(line.as_bytes())?;
        Ok(())
    }

    fn read_all(&self) -> Result<Vec<PidRecord>> {
        if !self.path.exists() {
            return Ok(vec![]);
        }
        let reader = std::io::BufReader::new(fs::File::open(&self.path)?);
        let mut records = vec![];
        for line in reader.lines() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<PidRecord>(&line) {
                Ok(r) => records.push(r),
                Err(e) => warn!(
                    "PidStore: skipping corrupt record ({}): {:?}",
                    e,
                    &line[..line.len().min(80)]
                ),
            }
        }
        Ok(records)
    }

    fn write_all(&self, records: &[PidRecord]) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let mut content = String::new();
        for r in records {
            content.push_str(&serde_json::to_string(r)?);
            content.push('\n');
        }
        fs::write(&self.path, content)?;
        Ok(())
    }
}

fn store_path() -> PathBuf {
    crate::log_files::global_dir()
        .unwrap_or_else(|| PathBuf::from(".agent-yes"))
        .join("pids.jsonl")
}

fn log_retention_ms() -> i64 {
    let days = std::env::var("AGENT_YES_LOG_RETENTION_DAYS")
        .ok()
        .and_then(|s| s.parse::<i64>().ok())
        .filter(|d| *d > 0)
        .unwrap_or(DEFAULT_LOG_RETENTION_DAYS);
    days * 24 * 60 * 60 * 1000
}

fn log_siblings(log_file: Option<&str>) -> Vec<PathBuf> {
    let Some(log_file) = log_file else {
        return vec![];
    };
    let path = Path::new(log_file);
    let s = path.to_string_lossy();
    let base = s
        .strip_suffix(".raw.log")
        .or_else(|| s.strip_suffix(".log"))
        .unwrap_or(&s);
    vec![
        PathBuf::from(format!("{base}.raw.log")),
        PathBuf::from(format!("{base}.log")),
        PathBuf::from(format!("{base}.lines.log")),
        PathBuf::from(format!("{base}.debug.log")),
    ]
}

pub fn is_process_alive(pid: u32) -> bool {
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as libc::pid_t, 0) == 0
    }
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::Foundation::{CloseHandle, FALSE, STILL_ACTIVE};
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        // `PROCESS_QUERY_LIMITED_INFORMATION` is the smallest access right
        // that lets `GetExitCodeProcess` succeed and works against processes
        // we don't own (anything in `pids.jsonl` may have been spawned by
        // any account on the box). If the pid isn't a live process, OpenProcess
        // returns NULL (ERROR_INVALID_PARAMETER for a pid that never existed,
        // or no permission); both cases mean "treat as dead" for stale eviction.
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
        if h.is_null() {
            return false;
        }
        // The pid handle may belong to a process that already exited but is
        // still in the kernel table; STILL_ACTIVE distinguishes the two.
        let mut exit_code: u32 = 0;
        let ok = GetExitCodeProcess(h, &mut exit_code);
        CloseHandle(h);
        ok != FALSE && exit_code == STILL_ACTIVE as u32
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = pid;
        true // conservative: assume alive on unsupported platforms
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_register_and_read_all() {
        let dir = tempfile::tempdir().unwrap();
        let store = PidStore::with_path(dir.path().join("pids.jsonl"));
        store.register(1234, "claude", Some("hello"), "/tmp", Some("/tmp/log"));
        let records = store.read_all().unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].pid, 1234);
        assert_eq!(records[0].cli, "claude");
        assert_eq!(records[0].prompt, Some("hello".into()));
        assert_eq!(records[0].cwd, "/tmp");
        assert_eq!(records[0].status, "active");
    }

    #[test]
    fn test_register_multiple() {
        let dir = tempfile::tempdir().unwrap();
        let store = PidStore::with_path(dir.path().join("pids.jsonl"));
        store.register(100, "claude", None, "/a", None);
        store.register(200, "codex", Some("test"), "/b", None);
        let records = store.read_all().unwrap();
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].pid, 100);
        assert_eq!(records[1].pid, 200);
    }

    #[test]
    fn test_update_status() {
        let dir = tempfile::tempdir().unwrap();
        let store = PidStore::with_path(dir.path().join("pids.jsonl"));
        store.register(42, "claude", None, "/tmp", None);
        store.update_status(42, "exited", Some(0), Some("done"), None);
        let records = store.read_all().unwrap();
        assert_eq!(records[0].status, "exited");
        assert_eq!(records[0].exit_code, Some(0));
        assert_eq!(records[0].exit_reason, Some("done".into()));
    }

    #[test]
    fn test_clean_stale_removes_dead() {
        let dir = tempfile::tempdir().unwrap();
        let store = PidStore::with_path(dir.path().join("pids.jsonl"));
        // PID 999999 almost certainly doesn't exist
        store.register(999999, "claude", None, "/tmp", None);
        store.clean_stale();
        let records = store.read_all().unwrap();
        assert!(records.is_empty());
    }

    #[test]
    fn test_read_all_empty_file() {
        let dir = tempfile::tempdir().unwrap();
        let store = PidStore::with_path(dir.path().join("pids.jsonl"));
        let records = store.read_all().unwrap();
        assert!(records.is_empty());
    }

    #[test]
    fn test_read_all_skips_corrupt_lines() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pids.jsonl");
        std::fs::write(&path, "not json\n").unwrap();
        let store = PidStore::with_path(path);
        let records = store.read_all().unwrap();
        assert!(records.is_empty());
    }

    #[test]
    fn test_is_process_alive_self() {
        assert!(is_process_alive(std::process::id()));
    }

    #[test]
    fn test_is_process_alive_dead() {
        assert!(!is_process_alive(999999));
    }

    #[test]
    fn test_new_default_path() {
        let store = PidStore::new();
        assert!(store.path.ends_with("pids.jsonl"));
    }

    #[test]
    fn test_write_all_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let store = PidStore::with_path(dir.path().join("pids.jsonl"));
        let records = vec![PidRecord {
            pid: 1,
            cli: "claude".into(),
            prompt: None,
            cwd: "/tmp".into(),
            log_file: None,
            fifo_file: None,
            status: "active".into(),
            exit_code: None,
            exit_reason: None,
            started_at: 0,
        }];
        store.write_all(&records).unwrap();
        let loaded = store.read_all().unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].pid, 1);
    }

    #[test]
    fn test_prune_old_logs_removes_dead_old_log_siblings() {
        let dir = tempfile::tempdir().unwrap();
        let store = PidStore::with_path(dir.path().join("pids.jsonl"));
        let base = dir.path().join("1234");
        let raw = PathBuf::from(format!("{}.raw.log", base.display()));
        let rendered = PathBuf::from(format!("{}.log", base.display()));
        let lines = PathBuf::from(format!("{}.lines.log", base.display()));
        std::fs::write(&raw, "raw").unwrap();
        std::fs::write(&rendered, "rendered").unwrap();
        std::fs::write(&lines, "lines").unwrap();

        let old_started_at = chrono::Utc::now().timestamp_millis()
            - (DEFAULT_LOG_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000;
        store
            .write_all(&[PidRecord {
                pid: 999999,
                cli: "claude".into(),
                prompt: None,
                cwd: "/tmp".into(),
                log_file: Some(raw.to_string_lossy().to_string()),
                fifo_file: None,
                status: "exited".into(),
                exit_code: Some(0),
                exit_reason: Some("completed".into()),
                started_at: old_started_at,
            }])
            .unwrap();

        store.prune_old_logs();

        assert!(!raw.exists());
        assert!(!rendered.exists());
        assert!(!lines.exists());
    }
}
