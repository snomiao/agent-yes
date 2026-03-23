//! JSONL-based process registry — tracks running agent-yes processes

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, Write};
use std::path::PathBuf;
use tracing::warn;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PidRecord {
    pub pid: u32,
    pub cli: String,
    pub prompt: Option<String>,
    pub cwd: String,
    pub log_file: Option<String>,
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

    pub fn register(&self, pid: u32, cli: &str, prompt: Option<&str>, cwd: &str, log_file: Option<&str>) {
        let record = PidRecord {
            pid,
            cli: cli.to_string(),
            prompt: prompt.map(|s| s.to_string()),
            cwd: cwd.to_string(),
            log_file: log_file.map(|s| s.to_string()),
            status: "active".to_string(),
            exit_code: None,
            exit_reason: None,
            started_at: chrono::Utc::now().timestamp_millis(),
        };
        if let Err(e) = self.append(&record) {
            warn!("PidStore: failed to register: {}", e);
        }
    }

    pub fn update_status(&self, pid: u32, status: &str, exit_code: Option<i32>, exit_reason: Option<&str>) {
        let result = (|| -> Result<()> {
            let mut records = self.read_all()?;
            for r in &mut records {
                if r.pid == pid {
                    r.status = status.to_string();
                    r.exit_code = exit_code;
                    r.exit_reason = exit_reason.map(|s| s.to_string());
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

    fn append(&self, record: &PidRecord) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let line = serde_json::to_string(record)? + "\n";
        let mut file = fs::OpenOptions::new().create(true).append(true).open(&self.path)?;
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
                Err(e) => warn!("PidStore: skipping corrupt record ({}): {:?}", e, &line[..line.len().min(80)]),
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
    crate::log_files::log_dir()
        .unwrap_or_else(|| PathBuf::from(".agent-yes"))
        .join("pids.jsonl")
}

pub fn is_process_alive(pid: u32) -> bool {
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as libc::pid_t, 0) == 0
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        true // conservative: assume alive on non-unix
    }
}
