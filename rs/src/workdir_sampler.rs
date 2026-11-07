//! Where this agent actually works, measured from the kernel.
//!
//! The wrapped CLI's own cwd never moves after spawn: claude's Bash tool starts
//! every call in the project dir, so a lane told to work in another worktree
//! runs `cd <worktree> && …` per call. The registry `cwd` stays the spawn dir
//! and `ay ls` can't tell such lanes apart.
//!
//! The shells it starts DO run in the real dir, whatever the command text
//! looked like (`bash -c`, a script that cds, `make -C`, `git -C` — all chdir
//! for real). So the wrapper samples the cwd of its descendants every few
//! seconds and records the repo they work in to `<agent-yes home>/workdir/
//! <pid>.json` (read back by ts/workDir.ts). A side file, not a registry field:
//! wrappers from older releases rewrite the whole registry with a record type
//! that lacks the field and would keep erasing it; the file also keeps these
//! updates off the registry lock.
//! Nothing here reads what the agent wrote or claims; a stale or forgotten
//! self-report can't drift from what the processes do.
//!
//! What counts: processes inside a SHELL subtree under the agent (a shell and
//! everything below it). Non-shell helpers the CLI starts directly — MCP
//! servers, language servers — sit in the spawn dir for the whole session and
//! would drown every real signal, so they are skipped.
//!
//! Each (pid, cwd) pair votes ONCE, when first seen: a long-lived background
//! process (a dev server, a watcher) casts one vote instead of one per tick,
//! so it can't pin the result. Votes map to their repo root (nearest ancestor
//! with a `.git` entry — worktrees and submodules included); dirs outside any
//! repo (scratch/temp dirs) don't vote. The winner is a recency-weighted vote
//! over the last [`WINDOW`] votes, so one stray command elsewhere doesn't flip
//! it but a lane that moved on wins after a few commands in the new place.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// How often the wrapper samples its process tree while things are changing.
pub const SAMPLE_EVERY: Duration = Duration::from_secs(2);
/// An unchanged sample doubles the wait, up to this; any change resets it.
pub const SAMPLE_MAX_EVERY: Duration = Duration::from_secs(30);

/// Wait before the next sample after `unchanged` identical samples in a row.
pub fn next_delay(unchanged: u32) -> Duration {
    SAMPLE_EVERY
        .saturating_mul(1u32 << unchanged.min(4))
        .min(SAMPLE_MAX_EVERY)
}
/// Votes that take part in the decision.
pub const WINDOW: usize = 40;
/// Per-vote decay, newest = 1.0.
/// 0.75: a history of any length is outweighed by ~3 fresh votes (a lane that
/// moved on, or came back), while one stray vote never flips it.
const DECAY: f64 = 0.75;
/// Refresh `workdir_at` for an unchanged winner at most this often.
const REFRESH_MS: i64 = 60_000;

const SHELLS: &[&str] = &["bash", "zsh", "sh", "dash", "fish", "ksh", "ash"];

/// One process in the snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Proc {
    pub pid: u32,
    pub ppid: u32,
    pub comm: String,
}

pub fn is_shell(comm: &str) -> bool {
    // login shells show as "-bash"; paths as "/bin/bash" on some platforms
    let base = comm.trim_start_matches('-');
    let base = base.rsplit('/').next().unwrap_or(base);
    SHELLS.contains(&base)
}

/// Pids under `root` that are a shell or below one (the shell's own subtree).
/// `root` itself and non-shell branches above any shell are excluded.
pub fn shell_subtree_pids(root: u32, procs: &[Proc]) -> Vec<u32> {
    let mut kids: HashMap<u32, Vec<&Proc>> = HashMap::new();
    for p in procs {
        kids.entry(p.ppid).or_default().push(p);
    }
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    // (pid, inside_shell)
    let mut stack: Vec<(u32, bool)> = vec![(root, false)];
    while let Some((pid, inside)) = stack.pop() {
        if !seen.insert(pid) {
            continue;
        }
        for c in kids.get(&pid).map(|v| v.as_slice()).unwrap_or(&[]) {
            let now_inside = inside || is_shell(&c.comm);
            if now_inside {
                out.push(c.pid);
            }
            stack.push((c.pid, now_inside));
        }
    }
    out
}

/// Nearest ancestor of `dir` (inclusive) holding a `.git` entry — a dir for a
/// normal clone, a file for worktrees and submodules.
pub fn repo_root(dir: &Path) -> Option<PathBuf> {
    let mut cur = Some(dir);
    while let Some(d) = cur {
        if d.join(".git").exists() {
            return Some(d.to_path_buf());
        }
        cur = d.parent();
    }
    None
}

/// The vote state for one agent.
#[derive(Default)]
pub struct Tracker {
    /// cwd each live pid was last seen in — a pid votes again only when it moves.
    last_cwd: HashMap<u32, PathBuf>,
    votes: VecDeque<(PathBuf, i64)>,
    root_cache: HashMap<PathBuf, Option<PathBuf>>,
    written: Option<(PathBuf, i64)>,
}

/// What to store after a sample, when it changed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Update {
    pub workdir: String,
    pub at: i64,
}

impl Tracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed one snapshot of (pid, cwd) pairs taken at `now` (unix ms).
    /// Returns an update when the winner changed, or when an unchanged
    /// winner's timestamp is due a refresh.
    pub fn observe(&mut self, sample: &[(u32, PathBuf)], now: i64) -> Option<Update> {
        let live: HashSet<u32> = sample.iter().map(|(p, _)| *p).collect();
        self.last_cwd.retain(|p, _| live.contains(p));
        // Roots some live process sits in right now: they confirm a winner's
        // timestamp even when no new vote arrives (a lane parked in one shell).
        let mut present: HashSet<PathBuf> = HashSet::new();
        for (pid, cwd) in sample {
            let root = self
                .root_cache
                .entry(cwd.clone())
                .or_insert_with(|| repo_root(cwd))
                .clone();
            if let Some(r) = &root {
                present.insert(r.clone());
            }
            if self.last_cwd.get(pid) == Some(cwd) {
                continue;
            }
            self.last_cwd.insert(*pid, cwd.clone());
            if let Some(root) = root {
                self.votes.push_back((root, now));
                while self.votes.len() > WINDOW {
                    self.votes.pop_front();
                }
            }
        }
        // Bounded: one entry per distinct dir ever seen; drop it all if a
        // pathological agent walks thousands of dirs.
        if self.root_cache.len() > 4096 {
            self.root_cache.clear();
        }
        let (winner, last_vote_at) = self.winner()?;
        let last_at = if present.contains(&winner) {
            now
        } else {
            last_vote_at
        };
        let due = match &self.written {
            Some((w, at)) => *w != winner || last_at - at >= REFRESH_MS,
            None => true,
        };
        if !due {
            return None;
        }
        self.written = Some((winner.clone(), last_at));
        Some(Update {
            workdir: winner.to_string_lossy().into_owned(),
            at: last_at,
        })
    }

    /// Recency-weighted vote; ties go to the root voted for most recently.
    fn winner(&self) -> Option<(PathBuf, i64)> {
        let n = self.votes.len();
        let mut score: HashMap<&PathBuf, (f64, i64, usize)> = HashMap::new();
        for (i, (root, at)) in self.votes.iter().enumerate() {
            let w = DECAY.powi((n - 1 - i) as i32);
            let e = score.entry(root).or_insert((0.0, 0, 0));
            e.0 += w;
            e.1 = e.1.max(*at);
            e.2 = i;
        }
        score
            .into_iter()
            .max_by(|a, b| {
                (a.1 .0)
                    .partial_cmp(&b.1 .0)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then(a.1 .2.cmp(&b.1 .2))
            })
            .map(|(root, (_, at, _))| (root.clone(), at))
    }
}

// ---------------------------------------------------------------------------
// platform: process table + per-pid cwd
// ---------------------------------------------------------------------------

#[cfg(target_os = "linux")]
fn snapshot(_root: u32) -> Vec<Proc> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir("/proc") else {
        return out;
    };
    for e in rd.flatten() {
        let Some(pid) = e.file_name().to_str().and_then(|s| s.parse::<u32>().ok()) else {
            continue;
        };
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
            continue;
        };
        if let Some(p) = parse_proc_stat(pid, &stat) {
            out.push(p);
        }
    }
    out
}

/// `/proc/<pid>/stat`: "pid (comm) state ppid …" — comm may contain spaces
/// and parens, so split on the LAST ')'.
// Only the Linux sampler calls this; keep it warning-free under -D warnings on
// a Windows/macOS checkout (its unit test still exercises it there).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn parse_proc_stat(pid: u32, stat: &str) -> Option<Proc> {
    let open = stat.find('(')?;
    let close = stat.rfind(')')?;
    let comm = stat.get(open + 1..close)?.to_string();
    let mut rest = stat.get(close + 1..)?.split_whitespace();
    let _state = rest.next()?;
    let ppid = rest.next()?.parse().ok()?;
    Some(Proc { pid, ppid, comm })
}

#[cfg(target_os = "linux")]
fn cwds(pids: &[u32]) -> Vec<(u32, PathBuf)> {
    pids.iter()
        .filter_map(|p| {
            std::fs::read_link(format!("/proc/{p}/cwd"))
                .ok()
                .map(|c| (*p, c))
        })
        .collect()
}

// macOS: libproc instead of forking `ps -A` and `lsof` every sample. With dozens
// of wrappers each forking two helpers every 2 s, the forks cost far more than
// the data (and much more under memory pressure). `proc_listchildpids` walks
// only this wrapper's own subtree; `PROC_PIDVNODEPATHINFO` reads a pid's cwd.
#[cfg(target_os = "macos")]
fn snapshot(root: u32) -> Vec<Proc> {
    let mut out = Vec::new();
    let mut stack = vec![root];
    let mut seen = HashSet::new();
    while let Some(parent) = stack.pop() {
        if !seen.insert(parent) {
            continue;
        }
        for pid in child_pids(parent) {
            out.push(Proc {
                pid,
                ppid: parent,
                comm: proc_path(pid).unwrap_or_default(),
            });
            stack.push(pid);
        }
    }
    out
}

#[cfg(target_os = "macos")]
fn child_pids(ppid: u32) -> Vec<u32> {
    let mut buf = vec![0i32; 256];
    loop {
        // SAFETY: `buf` is a live, writable allocation of exactly the byte size passed.
        let count = unsafe {
            libc::proc_listchildpids(
                ppid as libc::pid_t,
                buf.as_mut_ptr().cast(),
                (buf.len() * std::mem::size_of::<i32>()) as libc::c_int,
            )
        };
        // Unlike proc_listpids, this returns the NUMBER of pids written.
        if count <= 0 {
            return Vec::new();
        }
        let n = count as usize;
        if n < buf.len() {
            return buf[..n]
                .iter()
                .filter(|p| **p > 0)
                .map(|p| *p as u32)
                .collect();
        }
        // Filled the buffer: there may be more children, retry bigger.
        let len = buf.len() * 2;
        buf.resize(len, 0);
    }
}

/// Executable path of `pid` (what `ps -o comm=` printed), if it is still alive.
#[cfg(target_os = "macos")]
fn proc_path(pid: u32) -> Option<String> {
    let mut buf = [0u8; 4096]; // PROC_PIDPATHINFO_MAXSIZE
                               // SAFETY: `buf` is writable for the length passed.
    let n = unsafe {
        libc::proc_pidpath(
            pid as libc::c_int,
            buf.as_mut_ptr().cast(),
            buf.len() as u32,
        )
    };
    (n > 0).then(|| String::from_utf8_lossy(&buf[..n as usize]).into_owned())
}

#[cfg(target_os = "macos")]
fn cwds(pids: &[u32]) -> Vec<(u32, PathBuf)> {
    pids.iter()
        .filter_map(|&pid| proc_cwd(pid).map(|c| (pid, c)))
        .collect()
}

#[cfg(target_os = "macos")]
fn proc_cwd(pid: u32) -> Option<PathBuf> {
    // SAFETY: zeroed is a valid bit pattern for this plain-data C struct; the
    // kernel writes at most `size_of` bytes into it.
    let mut info: libc::proc_vnodepathinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_vnodepathinfo>() as libc::c_int;
    let n = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            libc::PROC_PIDVNODEPATHINFO,
            0,
            (&mut info as *mut libc::proc_vnodepathinfo).cast(),
            size,
        )
    };
    if n < size {
        return None;
    }
    // vip_path is a MAXPATHLEN C string, declared as 32x32 c_char by libc.
    let raw: &[u8] = unsafe {
        std::slice::from_raw_parts(
            info.pvi_cdir.vip_path.as_ptr().cast::<u8>(),
            std::mem::size_of_val(&info.pvi_cdir.vip_path),
        )
    };
    let end = raw.iter().position(|b| *b == 0)?;
    (end > 0).then(|| PathBuf::from(String::from_utf8_lossy(&raw[..end]).into_owned()))
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn snapshot(_root: u32) -> Vec<Proc> {
    Vec::new()
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn cwds(_pids: &[u32]) -> Vec<(u32, PathBuf)> {
    Vec::new()
}

/// One sample: cwd of every process in a shell subtree under `root`.
pub fn sample(root: u32) -> Vec<(u32, PathBuf)> {
    let procs = snapshot(root);
    cwds(&shell_subtree_pids(root, &procs))
}

pub fn workdir_path(pid: u32) -> Option<PathBuf> {
    crate::log_files::global_dir().map(|d| d.join("workdir").join(format!("{pid}.json")))
}

/// Store the winner for `pid`, tagged with the registration's `agent_id` so a
/// later agent that reuses the pid never inherits it. Atomic (temp + rename).
pub fn write_workdir(pid: u32, agent_id: Option<&str>, u: &Update) {
    let Some(path) = workdir_path(pid) else {
        return;
    };
    let body = serde_json::json!({ "workdir": u.workdir, "at": u.at, "agent_id": agent_id });
    let res = (|| -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
        std::fs::write(&tmp, body.to_string())?;
        std::fs::rename(&tmp, &path)
    })();
    if let Err(e) = res {
        tracing::debug!("workdir: write failed: {e}");
    }
}

pub fn remove_workdir(pid: u32) {
    if let Some(p) = workdir_path(pid) {
        let _ = std::fs::remove_file(p);
    }
}

/// Background task: sample every [`SAMPLE_EVERY`] and store the winner for
/// `pid` (this wrapper). Aborted when the returned guard drops.
pub fn spawn(pid: u32, agent_id: Option<String>) -> AbortOnDrop {
    let handle = tokio::spawn(async move {
        let mut tracker = Tracker::new();
        let mut last: Option<Vec<(u32, PathBuf)>> = None;
        let mut unchanged = 0u32;
        loop {
            tokio::time::sleep(next_delay(unchanged)).await;
            let Ok(sample) = tokio::task::spawn_blocking(move || sample(pid)).await else {
                continue;
            };
            if last.as_ref() == Some(&sample) {
                unchanged = unchanged.saturating_add(1);
            } else {
                unchanged = 0;
                last = Some(sample.clone());
            }
            let now = chrono::Utc::now().timestamp_millis();
            if let Some(u) = tracker.observe(&sample, now) {
                // Awaited, so writes for this pid never overlap: the shared temp
                // name can't be clobbered and the newest sample always lands last.
                let id = agent_id.clone();
                let _ = tokio::task::spawn_blocking(move || write_workdir(pid, id.as_deref(), &u))
                    .await;
            }
        }
    });
    AbortOnDrop(handle)
}

pub struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(pid: u32, ppid: u32, comm: &str) -> Proc {
        Proc {
            pid,
            ppid,
            comm: comm.into(),
        }
    }

    #[test]
    fn shell_subtree_skips_non_shell_helpers() {
        // 1111 wrapper → 1112 claude → {1113 bash → 1114 git, 1115 mcp-server → 1116 node}
        let procs = vec![
            p(1112, 1111, "claude"),
            p(1113, 1112, "bash"),
            p(1114, 1113, "git"),
            p(1115, 1112, "mcp-server"),
            p(1116, 1115, "node"),
            p(2000, 1, "bash"),
        ];
        let mut got = shell_subtree_pids(1111, &procs);
        got.sort();
        assert_eq!(got, vec![1113, 1114]);
    }

    #[test]
    fn is_shell_handles_login_and_path_forms() {
        assert!(is_shell("bash"));
        assert!(is_shell("-zsh"));
        assert!(is_shell("/bin/zsh"));
        assert!(!is_shell("bashful"));
        assert!(!is_shell("node"));
    }

    #[test]
    fn delay_backs_off_when_unchanged_and_resets() {
        assert_eq!(next_delay(0), Duration::from_secs(2));
        assert_eq!(next_delay(1), Duration::from_secs(4));
        assert_eq!(next_delay(3), Duration::from_secs(16));
        assert_eq!(next_delay(4), Duration::from_secs(30));
        assert_eq!(next_delay(u32::MAX), Duration::from_secs(30));
    }

    #[test]
    fn parses_proc_stat_with_spaces_and_parens_in_comm() {
        let s = "1113 (my (odd) sh) S 1112 1113 1113 0 -1";
        assert_eq!(parse_proc_stat(1113, s), Some(p(1113, 1112, "my (odd) sh")));
    }

    fn repo(base: &Path, name: &str) -> PathBuf {
        let d = base.join(name);
        std::fs::create_dir_all(d.join(".git")).unwrap();
        std::fs::create_dir_all(d.join("src")).unwrap();
        d
    }

    #[test]
    fn repo_root_finds_dir_or_file_dot_git() {
        let t = tempfile::tempdir().unwrap();
        let a = repo(t.path(), "a");
        assert_eq!(repo_root(&a.join("src")), Some(a.clone()));
        let wt = t.path().join("wt");
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(wt.join(".git"), "gitdir: /x").unwrap();
        assert_eq!(repo_root(&wt), Some(wt.clone()));
        assert_eq!(repo_root(Path::new("/")), None);
    }

    #[test]
    fn tracker_follows_the_shells_and_ignores_repeats() {
        let t = tempfile::tempdir().unwrap();
        let main = repo(t.path(), "main");
        let feat = repo(t.path(), "feat");
        let mut tr = Tracker::new();

        // first command runs in the spawn repo
        let u = tr.observe(&[(1113, main.clone())], 1000).unwrap();
        assert_eq!(u.workdir, main.to_string_lossy());
        // the same pid still sitting there: no new vote, no update
        assert_eq!(tr.observe(&[(1113, main.clone())], 3000), None);

        // the lane moves: a few commands in feat (sub-dirs map to the root)
        for (i, pid) in [1120u32, 1121, 1122].iter().enumerate() {
            tr.observe(&[(*pid, feat.join("src"))], 5000 + i as i64 * 2000);
        }
        assert_eq!(tr.written.as_ref().unwrap().0, feat);
    }

    #[test]
    fn one_stray_vote_does_not_flip_but_three_do() {
        let t = tempfile::tempdir().unwrap();
        let a = repo(t.path(), "a");
        let b = repo(t.path(), "b");
        let mut tr = Tracker::new();
        let mut pid = 1000u32;
        let mut vote = |tr: &mut Tracker, d: &PathBuf| {
            pid += 1;
            tr.observe(&[(pid, d.clone())], pid as i64);
        };
        for _ in 0..30 {
            vote(&mut tr, &a);
        }
        vote(&mut tr, &b);
        assert_eq!(tr.written.as_ref().unwrap().0, a);
        vote(&mut tr, &b);
        vote(&mut tr, &b);
        assert_eq!(tr.written.as_ref().unwrap().0, b);
    }

    #[test]
    fn a_lane_parked_in_one_shell_still_refreshes_its_timestamp() {
        let t = tempfile::tempdir().unwrap();
        let a = repo(t.path(), "a");
        let mut tr = Tracker::new();
        assert!(tr.observe(&[(1, a.clone())], 0).is_some());
        // same pid, same cwd: no new vote, but it is still there a minute later
        assert_eq!(tr.observe(&[(1, a.clone())], 30_000), None);
        assert_eq!(
            tr.observe(&[(1, a.clone())], 61_000).map(|u| u.at),
            Some(61_000)
        );
        // gone: the timestamp stays at the last confirmation
        assert_eq!(tr.observe(&[], 200_000), None);
    }

    #[test]
    fn a_long_lived_process_votes_once() {
        let t = tempfile::tempdir().unwrap();
        let server = repo(t.path(), "server");
        let work = repo(t.path(), "work");
        let mut tr = Tracker::new();
        // a dev server in another repo stays alive for the whole session …
        tr.observe(&[(1200, server.clone())], 0);
        // … while the lane runs many short commands in its worktree
        for i in 0..5u32 {
            tr.observe(
                &[(1200, server.clone()), (1300 + i, work.clone())],
                1000 * (i as i64 + 1),
            );
        }
        assert_eq!(tr.written.as_ref().unwrap().0, work);
    }

    #[test]
    fn dirs_outside_any_repo_do_not_vote() {
        let t = tempfile::tempdir().unwrap();
        let scratch = t.path().join("scratch");
        std::fs::create_dir_all(&scratch).unwrap();
        let mut tr = Tracker::new();
        assert_eq!(tr.observe(&[(1113, scratch)], 0), None);
    }

    #[test]
    fn unchanged_winner_refreshes_its_timestamp_at_most_every_minute() {
        let t = tempfile::tempdir().unwrap();
        let a = repo(t.path(), "a");
        let mut tr = Tracker::new();
        assert!(tr.observe(&[(1, a.clone())], 0).is_some());
        assert_eq!(tr.observe(&[(2, a.clone())], 30_000), None);
        assert_eq!(
            tr.observe(&[(3, a.clone())], 61_000),
            Some(Update {
                workdir: a.to_string_lossy().into_owned(),
                at: 61_000
            })
        );
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn samples_a_real_child_shell_cwd() {
        let t = tempfile::tempdir().unwrap();
        let dir = std::fs::canonicalize(t.path()).unwrap();
        let mut child = std::process::Command::new("sh")
            .arg("-c")
            .arg("sleep 5; true")
            .current_dir(&dir)
            .spawn()
            .unwrap();
        std::thread::sleep(Duration::from_millis(100));
        let got = sample(std::process::id());
        let _ = child.kill();
        let _ = child.wait();
        assert!(
            got.iter().any(|(p, c)| *p == child.id() && *c == dir),
            "{got:?}"
        );
    }
}
