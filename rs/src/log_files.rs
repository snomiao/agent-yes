//! Per-session file logging.
//!
//! Durable PTY logs live under `<cwd>/.agent-yes/` so they stay with the
//! project that produced them. Machine-global runtime state such as the pid
//! index, FIFO endpoints, winsize signals, and locks lives under
//! `$AGENT_YES_HOME` or `~/.agent-yes`.

use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tracing::warn;

/// Raw PTY logs are an append-only capture that the reader renders by replaying
/// the bytes through an xterm. That renderer only ever consumes the trailing
/// ~64 MiB (`MAX_RENDER_BYTES` in the TS `readLogForRender`), because its
/// scrollback is bounded — so bytes older than that window are dead weight on
/// disk. A runaway CLI/TUI capture was seen reaching ~1 GB. Cap the file: once it
/// grows past `COMPACT_TRIGGER_BYTES`, compact it down to its last
/// `COMPACT_KEEP_BYTES`, which stays comfortably above the render window so no
/// visible output is lost. Compaction runs in-process under the writer's own
/// lock, so nothing else appends to the file while it happens.
const COMPACT_KEEP_BYTES: u64 = 80 * 1024 * 1024;
const COMPACT_TRIGGER_BYTES: u64 = 160 * 1024 * 1024;

struct WriterState {
    file: Option<fs::File>,
    /// Bytes in the file, tracked so `write` avoids a `stat` on every chunk.
    /// Seeded from the existing file size so a restart doesn't lose the cap.
    written: u64,
}

/// Writes raw PTY output to a log file
pub struct LogWriter {
    state: Arc<Mutex<WriterState>>,
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
        let written = path
            .as_ref()
            .and_then(|p| fs::metadata(p).ok())
            .map(|m| m.len())
            .unwrap_or(0);
        Self {
            state: Arc::new(Mutex::new(WriterState { file, written })),
            raw_log_path: path,
        }
    }

    pub fn write(&self, data: &str) {
        let Ok(mut g) = self.state.lock() else { return };
        if g.file.is_none() {
            return;
        }
        {
            let f = g.file.as_mut().expect("checked is_some above");
            if f.write_all(data.as_bytes()).is_err() {
                return;
            }
        }
        g.written = g.written.saturating_add(data.len() as u64);
        if g.written > COMPACT_TRIGGER_BYTES {
            if let Some(path) = self.raw_log_path.clone() {
                match compact_tail(&path, COMPACT_KEEP_BYTES) {
                    Ok((file, len)) => {
                        g.file = Some(file);
                        g.written = len;
                    }
                    Err(e) => warn!("raw log compaction failed for {:?}: {}", path, e),
                }
            }
        }
    }
}

/// Shrink `path` to its trailing `keep` bytes and return a fresh append handle
/// positioned at the (new) end, plus the resulting length. The tail is written
/// to a sibling temp file and renamed over the original so a crash mid-compaction
/// leaves the old log intact rather than a half-written one. The caller's stale
/// handle to the pre-rename inode is discarded in favour of the returned one.
fn compact_tail(path: &Path, keep: u64) -> std::io::Result<(fs::File, u64)> {
    let len = fs::metadata(path)?.len();
    if len <= keep {
        let f = fs::OpenOptions::new().create(true).append(true).open(path)?;
        return Ok((f, len));
    }
    let mut rf = fs::File::open(path)?;
    rf.seek(SeekFrom::Start(len - keep))?;
    let mut buf = Vec::with_capacity(keep as usize);
    rf.take(keep).read_to_end(&mut buf)?;

    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".compacting");
    let tmp = PathBuf::from(tmp);
    {
        let mut wf = fs::File::create(&tmp)?;
        wf.write_all(&buf)?;
        wf.sync_all()?;
    }
    fs::rename(&tmp, path)?;

    let f = fs::OpenOptions::new().create(true).append(true).open(path)?;
    Ok((f, buf.len() as u64))
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
    fs::write(path, "*\n")
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
    fn test_compact_tail_keeps_trailing_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.raw.log");
        // 300 KiB of distinct lines; compact to the last 64 KiB.
        let body: Vec<u8> = (0..300u32 * 64)
            .flat_map(|i| format!("{:015}\n", i).into_bytes())
            .collect();
        fs::write(&path, &body).unwrap();
        let keep = 64 * 1024;
        let (_f, len) = compact_tail(&path, keep).unwrap();
        assert_eq!(len, keep);
        let on_disk = fs::read(&path).unwrap();
        assert_eq!(on_disk.len() as u64, keep);
        // The kept bytes are the file's true tail.
        assert_eq!(&on_disk[..], &body[body.len() - keep as usize..]);
        // No temp file left behind.
        assert!(!dir.path().join("big.raw.log.compacting").exists());
    }

    #[test]
    fn test_log_writer_compacts_when_oversized() {
        let dir = tempfile::tempdir().unwrap();
        let writer = LogWriter::new(std::process::id() + 200000, dir.path().to_str().unwrap());
        let path = writer.raw_log_path.clone().unwrap();
        // Write past COMPACT_TRIGGER_BYTES in 1 MiB chunks; the last chunk is a
        // recognizable marker so we can prove the tail survived.
        let chunk = "x".repeat(1024 * 1024);
        let chunks = (COMPACT_TRIGGER_BYTES / (1024 * 1024)) + 4;
        for _ in 0..chunks {
            writer.write(&chunk);
        }
        writer.write("TAIL_MARKER\n");
        let size = fs::metadata(&path).unwrap().len();
        // File was compacted, not left to grow past the trigger.
        assert!(size <= COMPACT_TRIGGER_BYTES, "size {} not capped", size);
        assert!(size >= COMPACT_KEEP_BYTES, "size {} unexpectedly tiny", size);
        // Most recent output is retained.
        let mut tail = vec![0u8; 32];
        let mut f = fs::File::open(&path).unwrap();
        f.seek(SeekFrom::End(-32)).unwrap();
        f.read_exact(&mut tail).unwrap();
        assert!(String::from_utf8_lossy(&tail).contains("TAIL_MARKER"));
    }

    #[test]
    fn test_compact_tail_noop_when_small() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("small.raw.log");
        fs::write(&path, b"just a little\n").unwrap();
        let (_f, len) = compact_tail(&path, 1024).unwrap();
        assert_eq!(len, 14);
        assert_eq!(fs::read(&path).unwrap(), b"just a little\n");
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
