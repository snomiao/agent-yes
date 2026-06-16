//! Defense-in-depth orphan reaper — complements `pty_spawner::reap_group`.
//!
//! reap_group kills the agent's process group when the *wrapper* exits cleanly.
//! But if the wrapper is killed WITHOUT running that cleanup — SIGKILL by an OOM
//! killer or an `oxmgr`/launchd force-restart, a panic — its leaked descendants
//! (a `yes | cmd`, a runaway build) survive, reparented to PID 1, pinning cores.
//!
//! So we persist each running agent's `(wrapper pid, agent pgid)`. A sweep (run
//! at every agent startup, plus the `ay reap` command) kills the recorded pgid of
//! any agent whose wrapper is now GONE, then forgets it. Because it targets a
//! RECORDED pgid of a CONFIRMED-DEAD wrapper — never `ppid==1` — it is
//! container-safe (where PID 1 is the init with many legitimate children) and
//! never touches a process outside a dead agent's own group.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::PathBuf;

#[derive(Serialize, Deserialize)]
struct Entry {
    wpid: i32, // the agent-yes wrapper process
    pgid: i32, // the agent CLI's process group (it leads its own session)
}

fn registry_path() -> PathBuf {
    crate::log_files::global_dir()
        .unwrap_or_else(|| PathBuf::from(".agent-yes"))
        .join("reaper.jsonl")
}

#[cfg(unix)]
fn is_alive(pid: i32) -> bool {
    if pid <= 1 {
        return false;
    }
    // kill(pid, 0) probes existence: 0 == alive & signalable; EPERM == alive but
    // owned by another user; ESRCH == gone.
    let rc = unsafe { libc::kill(pid, 0) };
    rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}
#[cfg(not(unix))]
fn is_alive(_pid: i32) -> bool {
    true
}

/// Record this wrapper + its agent's process group so a later sweep can reap the
/// group if the wrapper dies without cleaning up. Best-effort.
pub fn register(wrapper_pid: u32, pgid: i32) {
    if pgid <= 1 {
        return; // never persist a group we'd refuse to signal anyway
    }
    let path = registry_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let Ok(line) = serde_json::to_string(&Entry {
        wpid: wrapper_pid as i32,
        pgid,
    }) else {
        return;
    };
    // O_APPEND keeps concurrent agents' small writes from interleaving.
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{line}");
    }
}

/// SIGKILL the recorded process group of every agent whose wrapper has exited,
/// and rewrite the registry keeping only still-running agents. Best-effort.
pub fn sweep() {
    let path = registry_path();
    let Ok(content) = fs::read_to_string(&path) else {
        return;
    };
    let mut keep: Vec<String> = Vec::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<Entry>(line) else {
            continue; // drop malformed lines
        };
        if is_alive(entry.wpid) {
            keep.push(line.to_string()); // agent still running — keep watching it
            continue;
        }
        // Wrapper gone — reap any survivors in its recorded group. The pgid
        // outlives the group leader, so this catches descendants already
        // reparented to PID 1. The `> 1` guard is critical: kill(-1) would
        // signal every process the user owns.
        #[cfg(unix)]
        if entry.pgid > 1 {
            unsafe {
                libc::kill(-entry.pgid, libc::SIGKILL);
            }
        }
    }
    let tmp = path.with_extension("jsonl.tmp");
    if fs::write(&tmp, keep.join("\n")).is_ok() {
        let _ = fs::rename(&tmp, &path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_alive_self_and_dead() {
        assert!(is_alive(std::process::id() as i32));
        assert!(!is_alive(999_999)); // almost certainly nonexistent
        assert!(!is_alive(1)); // PID 1 guarded out (never treated as a reapable wrapper)
        assert!(!is_alive(0));
    }

    #[test]
    fn test_register_and_sweep_keeps_live_drops_dead() {
        // Isolate the registry under a temp HOME so we don't touch the real file.
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("AGENT_YES_HOME", dir.path());

        // A live wrapper (us) is kept; a dead wrapper (999999) is dropped. The
        // live entry's pgid is never signalled (wrapper alive); the dead entry's
        // pgid points at a nonexistent group so its kill is a harmless ESRCH
        // no-op — we only exercise the bookkeeping here, not real signalling.
        register(std::process::id() as u32, 222_222);
        register(999_999, 999_998);
        sweep();

        let left = fs::read_to_string(registry_path()).unwrap();
        let lines: Vec<&str> = left.lines().filter(|l| !l.trim().is_empty()).collect();
        assert_eq!(lines.len(), 1, "only the live wrapper should remain");
        assert!(lines[0].contains(&std::process::id().to_string()));

        std::env::remove_var("AGENT_YES_HOME");
    }
}
