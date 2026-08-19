//! Periodic raw-log reclamation for logs whose WRITER cannot compact itself.
//!
//! `log_files::LogWriter` already caps its own file: past
//! `COMPACT_TRIGGER_BYTES` it rewrites the log down to `COMPACT_KEEP_BYTES`.
//! That covers every agent started by a binary containing this code — but not
//! the ones that matter. Compaction shipped after some long-lived agents had
//! already been exec'd, and a running process keeps the image it was loaded
//! with: updating the on-disk binary does nothing for it, and it will never
//! compact its own log no matter how large that log grows. One such writer, a
//! full-screen TUI repainting roughly once a second, reached ~18 GB over eleven
//! days and accounted for 96% of its state directory.
//!
//! Nothing in the writer can fix that, so the daemon does it from the outside:
//! sweep the known log directories and apply the same in-place compaction to
//! any raw log over the trigger, whoever wrote it.

use crate::log_files::{compact_tail, global_dir, COMPACT_KEEP_BYTES, COMPACT_TRIGGER_BYTES};
use std::collections::HashSet;
use std::path::PathBuf;
use std::time::Duration;
use tracing::info;

/// How often the daemon sweeps for oversized logs.
///
/// This is a disk-reclamation backstop, not a hot path, and it only does real
/// work when a file is actually over the trigger — otherwise it is a `read_dir`
/// plus a `stat` per log. The interval bounds how far past the trigger a
/// runaway writer can get: a log has to gain `TRIGGER - KEEP` (80 MiB) before
/// it qualifies again, which at the ~28 KB/s of the observed runaway TUI takes
/// close to an hour, so a 10-minute tick keeps the overshoot to a rounding
/// error while staying far too infrequent to matter for load.
const SWEEP_INTERVAL: Duration = Duration::from_secs(600);

/// Directories that can hold raw logs: one per distinct agent cwd (raw logs are
/// per-project — `<cwd>/.agent-yes/<pid>.raw.log`, see
/// `log_files::project_log_dir`) plus the machine-global dir, which holds the
/// logs of agents whose cwd is the home directory.
fn log_dirs() -> Vec<PathBuf> {
    let mut dirs: HashSet<PathBuf> = HashSet::new();
    if let Some(g) = global_dir() {
        dirs.insert(g);
    }
    for rec in crate::serve::api::read_records() {
        if rec.cwd.is_empty() {
            continue;
        }
        if let Some(d) = crate::log_files::project_log_dir(&rec.cwd) {
            dirs.insert(d);
        }
    }
    dirs.into_iter().collect()
}

/// Compact every oversized `*.raw.log` under `dirs`. Returns one
/// `(path, before, after)` per file actually reclaimed, so the caller can log
/// only when something happened.
///
/// Split out from the loop so tests can drive it against a tempdir without a
/// runtime, a pid store, or a ten-minute wait.
pub(crate) fn sweep_dirs(dirs: &[PathBuf]) -> Vec<(PathBuf, u64, u64)> {
    let mut done = Vec::new();
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue; // agent cwd deleted, or not readable — nothing to do
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.to_string_lossy().ends_with(".raw.log") {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            if !meta.is_file() || meta.len() <= COMPACT_TRIGGER_BYTES {
                continue;
            }
            let before = meta.len();
            // Same in-place rewrite the writer uses: the inode is preserved, so
            // a live follower (`/api/tail`, and the web console over WebRTC)
            // resumes from the new frontier via its `size < offset` guard
            // instead of being pinned to an unlinked file forever.
            match compact_tail(&path, COMPACT_KEEP_BYTES) {
                Ok(after) if after < before => done.push((path, before, after)),
                _ => {}
            }
        }
    }
    done
}

/// Start the sweep loop. Fire-and-forget: a failure to reclaim disk must never
/// take the daemon down, so every error is swallowed and retried next tick.
pub fn spawn() {
    tokio::spawn(async move {
        loop {
            // compact_tail reads and rewrites up to COMPACT_KEEP_BYTES, so this
            // belongs on the blocking pool rather than an async worker.
            let reclaimed = tokio::task::spawn_blocking(|| sweep_dirs(&log_dirs()))
                .await
                .unwrap_or_default();
            // Silent when there is nothing to say. A per-tick line would grow
            // this daemon's own log without bound, which is the exact failure
            // this module exists to clean up after.
            for (path, before, after) in reclaimed {
                info!(
                    "raw log compacted: {} {} -> {} bytes",
                    path.display(),
                    before,
                    after
                );
            }
            tokio::time::sleep(SWEEP_INTERVAL).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `compact_tail` only engages past COMPACT_TRIGGER_BYTES, so the fixtures
    /// have to actually exceed it; keep the body cheap to generate.
    fn write_sized(path: &std::path::Path, len: u64) {
        let chunk = vec![b'x'; 1024 * 1024];
        let mut f = std::fs::File::create(path).unwrap();
        use std::io::Write;
        let mut written = 0u64;
        while written < len {
            let n = chunk.len().min((len - written) as usize);
            f.write_all(&chunk[..n]).unwrap();
            written += n as u64;
        }
    }

    #[cfg(unix)]
    fn inode_of(path: &std::path::Path) -> u64 {
        use std::os::unix::fs::MetadataExt;
        std::fs::metadata(path).unwrap().ino()
    }

    #[test]
    fn sweeps_an_oversized_log_down_to_keep() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("1111.raw.log");
        write_sized(&p, COMPACT_TRIGGER_BYTES + 8 * 1024 * 1024);
        let done = sweep_dirs(&[dir.path().to_path_buf()]);
        assert_eq!(done.len(), 1, "oversized log should have been reclaimed");
        assert_eq!(
            std::fs::metadata(&p).unwrap().len(),
            COMPACT_KEEP_BYTES,
            "compacted file should be exactly KEEP bytes"
        );
    }

    #[test]
    fn leaves_a_log_under_the_trigger_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("1111.raw.log");
        write_sized(&p, 4 * 1024 * 1024);
        let before = std::fs::read(&p).unwrap();
        assert!(sweep_dirs(&[dir.path().to_path_buf()]).is_empty());
        assert_eq!(
            std::fs::read(&p).unwrap(),
            before,
            "an under-threshold log must not be modified at all"
        );
    }

    #[test]
    #[cfg(unix)]
    fn preserves_the_inode_so_live_followers_are_not_frozen() {
        // This is the whole reason compaction rewrites in place instead of
        // temp-file + rename: a follower's fd stays bound to the old inode and
        // would never see another append.
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("1111.raw.log");
        write_sized(&p, COMPACT_TRIGGER_BYTES + 4 * 1024 * 1024);
        let before = inode_of(&p);
        assert_eq!(sweep_dirs(&[dir.path().to_path_buf()]).len(), 1);
        assert_eq!(inode_of(&p), before, "compaction must not swap the inode");
    }

    #[test]
    fn ignores_non_raw_logs_and_missing_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let other = dir.path().join("notes.jsonl");
        write_sized(&other, COMPACT_TRIGGER_BYTES + 1024 * 1024);
        let len = std::fs::metadata(&other).unwrap().len();
        let missing = dir.path().join("gone");
        assert!(sweep_dirs(&[dir.path().to_path_buf(), missing]).is_empty());
        assert_eq!(
            std::fs::metadata(&other).unwrap().len(),
            len,
            "only *.raw.log is in scope"
        );
    }

    #[test]
    fn keeps_the_tail_not_the_head() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("1111.raw.log");
        write_sized(&p, COMPACT_TRIGGER_BYTES + 2 * 1024 * 1024);
        // Stamp a marker at the very end; the newest bytes are the ones the
        // renderer needs, so they must survive.
        {
            use std::io::Write;
            let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
            f.write_all(b"NEWEST-MARKER").unwrap();
        }
        assert_eq!(sweep_dirs(&[dir.path().to_path_buf()]).len(), 1);
        let body = std::fs::read(&p).unwrap();
        assert!(
            body.ends_with(b"NEWEST-MARKER"),
            "the trailing bytes must be preserved"
        );
    }
}
