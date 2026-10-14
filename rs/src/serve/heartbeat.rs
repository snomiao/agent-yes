//! Serve-liveness heartbeat: `<AGENT_YES_HOME>/.serve-heartbeat` holds the
//! unix-ms of the last stamp, rewritten every [`WRITE_MS`].
//!
//! `ay serve install` registers `ay serve healthcheck` as the supervisor's
//! health command for a `--webrtc` daemon. That check reads this file and
//! exits non-zero when a VALID stamp is older than 15 s (ts/serve.ts
//! HEARTBEAT_STALE_MS) — a missing file counts as healthy. The TypeScript
//! daemon has stamped it for a long time; `ay serve --webrtc` now delegates to
//! this binary, which did not, so a stamp left by the last TypeScript daemon
//! stayed on disk and every check since read it as "wedged": the supervisor
//! restarted a perfectly healthy ayrs every ~45 s, for weeks, dropping every
//! viewer's data channel each time. Stamping from here makes the watchdog
//! mean what it says for both runtimes.
//!
//! Same format and the same temp+rename write as the TypeScript side, so a
//! concurrent reader never sees a torn stamp.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Stamp cadence; the check tolerates two misses (15 s stale window).
pub const WRITE_MS: u64 = 5_000;

pub fn path() -> Option<PathBuf> {
    crate::log_files::global_dir().map(|d| d.join(".serve-heartbeat"))
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Write the current unix-ms to `path` atomically (`<path>.tmp` then rename).
pub fn stamp_at(path: &Path) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = PathBuf::from(format!("{}.tmp", path.display()));
    std::fs::write(&tmp, now_ms().to_string())?;
    std::fs::rename(&tmp, path)
}

/// Best-effort stamp of the real heartbeat file.
pub fn stamp() {
    if let Some(p) = path() {
        let _ = stamp_at(&p);
    }
}

/// Stamp now and keep stamping every [`WRITE_MS`] for the life of the runtime.
/// Runs on the main runtime on purpose: if that runtime wedges, the stamps stop
/// and the watchdog's restart is the right call.
pub fn spawn() -> tokio::task::JoinHandle<()> {
    stamp();
    tokio::spawn(async {
        let mut tick = tokio::time::interval(Duration::from_millis(WRITE_MS));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        tick.tick().await; // the immediate first tick — already stamped above
        loop {
            tick.tick().await;
            stamp();
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stamp_is_a_fresh_unix_ms_written_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("nested").join(".serve-heartbeat");
        stamp_at(&p).unwrap();
        let raw = std::fs::read_to_string(&p).unwrap();
        let ts: u128 = raw.trim().parse().expect("unix-ms integer");
        let now = now_ms();
        assert!(
            now >= ts && now - ts < 5_000,
            "stamp {ts} should be within 5s of {now}"
        );
        assert!(!p.with_extension("heartbeat.tmp").exists());
        assert!(
            !dir.path()
                .join("nested")
                .join(".serve-heartbeat.tmp")
                .exists(),
            "temp file must be renamed away"
        );
        // A second stamp overwrites in place.
        stamp_at(&p).unwrap();
        let again: u128 = std::fs::read_to_string(&p).unwrap().trim().parse().unwrap();
        assert!(again >= ts);
    }
}
