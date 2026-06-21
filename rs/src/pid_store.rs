//! JSONL-based process registry — tracks running agent-yes processes

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::thread::sleep;
use std::time::{Duration, SystemTime};
use tracing::warn;

const DEFAULT_LOG_RETENTION_DAYS: i64 = 7;

// Cross-runtime registry lock, interoperable with the TS side's `proper-lockfile`
// (see ts/globalPidIndex.ts). proper-lockfile acquires by `mkdir(<file>.lock)`,
// treats a lock dir whose mtime is older than `stale` (10s) as abandoned and
// steals it, and releases by `rmdir`. We mirror that exact protocol so a Rust
// wrapper's write never clobbers a concurrent TS (or Rust) append — the bug that
// silently dropped live agents from `ay ls` when many were launched at once.
const LOCK_STALE_MS: u64 = 10_000; // == proper-lockfile default
const LOCK_RETRIES: u32 = 12;
const LOCK_RETRY_MIN_MS: u64 = 50;
const LOCK_RETRY_MAX_MS: u64 = 500;

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
    /// The `ay` wrapper pid that owns this agent (our own pid). Mirrors the TS
    /// `wrapper_pid`; a child `ay send` maps its inherited AGENT_YES_PID here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wrapper_pid: Option<u32>,
    /// The AGENT_YES_PID we inherited from our env = the parent agent's
    /// wrapper_pid. None for top-level agents. Builds the agent>subagent tree:
    /// child.parent_pid == parent.wrapper_pid.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_pid: Option<u32>,
    /// Stable identifier minted once at registration, so a share grant or an
    /// `ay <cmd> <id>` can reference this agent without depending on its
    /// ephemeral pid. Currently per-process; cross-restart re-binding is a
    /// follow-up (see docs/agent-sharing.md). Mirrors the TS `agent_id`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
}

/// Mint a short, low-collision agent id (12 hex chars from a v4 UUID). Short
/// enough to type/reference; `matchKeyword` allows prefix lookups.
fn new_agent_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..12].to_string()
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
            // We are the wrapper; record our own pid and the parent agent's
            // wrapper pid we inherited via AGENT_YES_PID (None at the tree root).
            wrapper_pid: Some(std::process::id()),
            parent_pid: std::env::var("AGENT_YES_PID")
                .ok()
                .and_then(|s| s.parse::<u32>().ok()),
            agent_id: Some(new_agent_id()),
        };
        // Hold the cross-runtime lock across the append so a concurrent rewrite
        // (another wrapper's clean_stale / a status update) can't clobber it.
        let _lock = acquire_lock(&self.path);
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
        // Lock spans the whole read-modify-write so the rewrite is computed from,
        // and committed against, a snapshot no other writer can race with.
        let _lock = acquire_lock(&self.path);
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
        // Lock spans read..write_all: a truncating rewrite must not race an
        // append, or a freshly registered (still-running) agent gets dropped.
        let _lock = acquire_lock(&self.path);
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

    // Callers hold the registry lock across read_all..write_all. Writes go to a
    // temp file then rename (atomic) so a concurrent reader — notably the TS
    // `readGlobalPids`, which reads without taking the lock — never observes a
    // half-written file.
    fn write_all(&self, records: &[PidRecord]) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let mut content = String::new();
        for r in records {
            content.push_str(&serde_json::to_string(r)?);
            content.push('\n');
        }
        let tmp = with_suffix(&self.path, ".rs.tmp");
        fs::write(&tmp, content)?;
        fs::rename(&tmp, &self.path)?;
        Ok(())
    }
}

/// RAII guard for the registry lock. Releases (`rmdir`) on drop so every exit
/// path — including `?` early returns and panics — frees the lock.
struct RegistryLock {
    dir: PathBuf,
}

impl Drop for RegistryLock {
    fn drop(&mut self) {
        let _ = fs::remove_dir(&self.dir);
    }
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(suffix);
    PathBuf::from(s)
}

fn lock_is_stale(dir: &Path) -> bool {
    let Ok(meta) = fs::metadata(dir) else {
        return false; // vanished — let the next mkdir decide
    };
    let Ok(mtime) = meta.modified() else {
        return false;
    };
    // A future mtime (clock skew) reads as a fresh, held lock — don't steal it.
    matches!(
        SystemTime::now().duration_since(mtime),
        Ok(age) if age > Duration::from_millis(LOCK_STALE_MS)
    )
}

/// Acquire the cross-runtime registry lock. Retries with capped backoff and
/// takes over a lock dir older than `LOCK_STALE_MS` (a crashed holder). Returns
/// `None` if it can't be acquired in time; callers then proceed best-effort
/// (matching the pre-lock behavior) rather than dropping the write entirely.
fn acquire_lock(path: &Path) -> Option<RegistryLock> {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let dir = with_suffix(path, ".lock");
    let mut delay = LOCK_RETRY_MIN_MS;
    for _ in 0..=LOCK_RETRIES {
        match fs::create_dir(&dir) {
            Ok(()) => return Some(RegistryLock { dir }),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                if lock_is_stale(&dir) {
                    let _ = fs::remove_dir(&dir); // steal the abandoned lock, then retry
                    continue;
                }
                sleep(Duration::from_millis(delay));
                delay = (delay * 2).min(LOCK_RETRY_MAX_MS);
            }
            Err(_) => return None,
        }
    }
    None
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
    fn test_register_mints_agent_id() {
        let dir = tempfile::tempdir().unwrap();
        let store = PidStore::with_path(dir.path().join("pids.jsonl"));
        store.register(1234, "claude", None, "/tmp", None);
        store.register(5678, "codex", None, "/tmp", None);
        let records = store.read_all().unwrap();
        let id0 = records[0].agent_id.as_deref().unwrap();
        let id1 = records[1].agent_id.as_deref().unwrap();
        // 12 hex chars, and distinct per registration.
        assert_eq!(id0.len(), 12);
        assert!(id0.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(id0, id1);
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
            wrapper_pid: None,
            parent_pid: None,
            agent_id: None,
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
                wrapper_pid: None,
                parent_pid: None,
                agent_id: None,
            }])
            .unwrap();

        store.prune_old_logs();

        assert!(!raw.exists());
        assert!(!rendered.exists());
        assert!(!lines.exists());
    }

    #[test]
    fn test_lock_acquire_releases_on_drop() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pids.jsonl");
        let lock_dir = with_suffix(&path, ".lock");
        {
            let g = acquire_lock(&path);
            assert!(g.is_some(), "lock should be acquired");
            assert!(lock_dir.exists(), "lock dir present while held");
        }
        assert!(!lock_dir.exists(), "lock dir removed on guard drop");
        // Re-acquirable after release.
        assert!(acquire_lock(&path).is_some());
    }

    #[test]
    fn test_clean_stale_keeps_live_record() {
        let dir = tempfile::tempdir().unwrap();
        let store = PidStore::with_path(dir.path().join("pids.jsonl"));
        // Our own pid is alive; a bogus one is not. Only the dead one is evicted.
        store.register(std::process::id(), "claude", None, "/tmp", None);
        store.register(999999, "claude", None, "/tmp", None);
        store.clean_stale();
        let records = store.read_all().unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].pid, std::process::id());
    }

    #[test]
    fn test_write_all_leaves_no_tmp() {
        let dir = tempfile::tempdir().unwrap();
        let store = PidStore::with_path(dir.path().join("pids.jsonl"));
        store.register(7, "claude", None, "/tmp", None);
        store.update_status(7, "idle", None, None, None);
        assert!(
            !with_suffix(&store.path, ".rs.tmp").exists(),
            "atomic rename must not leave the temp file behind"
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_lock_stale_takeover() {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pids.jsonl");
        let lock_dir = with_suffix(&path, ".lock");
        // Simulate a crashed holder: a leftover lock dir backdated past the stale
        // window. acquire_lock must steal it rather than spin until it gives up.
        std::fs::create_dir_all(&lock_dir).unwrap();
        let secs = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            - (LOCK_STALE_MS / 1000 + 5);
        let tv = libc::timeval {
            tv_sec: secs as libc::time_t,
            tv_usec: 0,
        };
        let times = [tv, tv];
        let c = CString::new(lock_dir.as_os_str().as_bytes()).unwrap();
        unsafe {
            libc::utimes(c.as_ptr(), times.as_ptr());
        }
        assert!(
            lock_is_stale(&lock_dir),
            "backdated lock should read as stale"
        );
        assert!(
            acquire_lock(&path).is_some(),
            "stale lock must be taken over"
        );
    }
}
