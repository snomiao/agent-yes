// Periodic per-agent resource sampler for the console heatmaps.
//
// Runs a background sweep that reads /proc for every live agent's process tree
// and rolls each up to CPU-seconds (sampled delta) + RSS (point snapshot) +
// process count. Those rollups are bucketed into a per-agent rolling window so
// the console can paint an "is this agent busy / fat / fork-bombing right now"
// heatmap behind each list row — WITHOUT the browser sampling anything itself.
//
// Adaptive granularity: the FIRST full sweep times how long one pass over every
// agent's tree takes. A pass is cheap on a small fleet (~ms) and expensive on a
// big one (thousands of /proc reads). We pick a bucket width so that the sampler
// stays a negligible background cost:
//
//   pass time <  1s  →  bucket =  60s, window = 60 buckets  (1h)
//   pass time >= 1s  →  bucket = 300s, window = 12 buckets  (1h)
//
// Both windows cover one hour; the coarse mode just stakes fewer, bigger points.
// The whole thing is BEST-EFFORT: a failed /proc read, an agent that exited
// mid-sweep, or a kernel with no /proc (non-Linux) all degrade to "no data"
// rather than erroring the serve path.

use super::procstats::{
    build_child_index, descendants_of, snapshot_procs, ProcSample, TreeStats,
};
use crate::pid_store::is_process_alive;
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};

const BUCKET_FAST_SECS: u64 = 60;
const BUCKET_SLOW_SECS: u64 = 300;
const WINDOW_FAST: usize = 60; // 1h @ 1m buckets
const WINDOW_SLOW: usize = 12; // 1h @ 5m buckets
const PASS_THRESHOLD_MS: u128 = 1000;

/// One bucketed per-agent sample (one point on the heatmap).
#[derive(Debug, Clone, Default)]
pub struct Bucket {
    /// CPU seconds summed across the tree over this bucket's window.
    pub cpu_seconds: f64,
    /// RSS (bytes) snapshot at bucket close.
    pub rss: u64,
    /// Live process count at bucket close.
    pub procs: usize,
}

/// Whole-box vitals + the unattributed (non-agent-yes) rollup, for the room line.
#[derive(Debug, Clone, Default)]
pub struct ResSnapshot {
    /// wrapper pid → resource window (oldest first), each (unix_ms_ts, bucket).
    pub agents: HashMap<u32, Vec<(i64, Bucket)>>,
    /// The unattributed (non-agent-yes) rollup at the last sweep.
    pub unattributed: Bucket,
    /// Bucket width actually in use (60 or 300), for the console's axis label.
    pub bucket_secs: u64,
}

#[derive(Default)]
struct SampleState {
    snap: ResSnapshot,
    /// Set once we've run the first timing pass and chosen a bucket width.
    bucket_secs: u64,
    /// Per-pid cumulative /proc counters from the PREVIOUS sweep, keyed by root
    /// wrapper pid → (member pid → sample). Used to compute honest CPU deltas.
    prev: HashMap<u32, HashMap<u32, ProcSample>>,
}

fn state() -> &'static Mutex<SampleState> {
    static S: OnceLock<Mutex<SampleState>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(SampleState::default()))
}

/// The per-agent window length for a given bucket width.
fn window_len(bucket_secs: u64) -> usize {
    if bucket_secs <= BUCKET_FAST_SECS {
        WINDOW_FAST
    } else {
        WINDOW_SLOW
    }
}

/// The daemon's shared home root, mirroring `api::global_dir`. Kept local so this
/// module has no dependency cycle with api.rs.
fn global_dir() -> std::path::PathBuf {
    if let Ok(h) = std::env::var("AGENT_YES_HOME") {
        return std::path::PathBuf::from(h);
    }
    dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join(".agent-yes")
}

/// Live wrapper pids (newest-first) straight from pids.jsonl, matching /api/ls.
fn live_roots() -> Vec<u32> {
    let path = global_dir().join("pids.jsonl");
    let Ok(content) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    let mut order: Vec<u32> = Vec::new();
    let mut seen: HashSet<u32> = HashSet::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let Some(pid) = v.get("pid").and_then(|p| p.as_u64()).map(|p| p as u32) else {
            continue;
        };
        if v.get("status").and_then(|s| s.as_str()) == Some("exited") {
            continue;
        }
        if seen.insert(pid) {
            order.push(pid);
        }
    }
    // Newest-first (pids.jsonl is append-only; last line for a pid is newest).
    order.reverse();
    order
        .into_iter()
        .filter(|&pid| is_process_alive(pid))
        .collect()
}

/// Rollup of one root's tree against the previous sweep's counters.
fn rollup(
    root: u32,
    members: &HashSet<u32>,
    prev: Option<&HashMap<u32, ProcSample>>,
    snap: &HashMap<u32, ProcSample>,
) -> TreeStats {
    let mut rss = 0u64;
    let mut cpu_delta = 0f64;
    let mut count = 0usize;
    for &pid in members {
        let Some(now) = snap.get(&pid) else { continue }; // exited mid-sweep
        count += 1;
        rss = rss.saturating_add(now.rss);
        let Some(before) = prev.and_then(|m| m.get(&pid)) else {
            continue; // no baseline → 0 CPU this bucket (first sweep or newcomer)
        };
        let reused = !before.start_token.is_empty()
            && !now.start_token.is_empty()
            && before.start_token != now.start_token;
        if !reused {
            cpu_delta += (now.cpu_seconds - before.cpu_seconds).max(0.0);
        }
    }
    TreeStats {
        pid: root,
        rss,
        cpu_delta,
        procs: count,
    }
}

fn bucket_from(t: &TreeStats) -> Bucket {
    Bucket {
        cpu_seconds: t.cpu_delta,
        rss: t.rss,
        procs: t.procs,
    }
}

/// One full sweep: snapshot /proc, roll each live root's tree (and the unattributed
/// rest), append a bucket per agent, and persist counters for the next delta.
/// Returns the wall-clock duration of the /proc pass (for the adaptive timer).
fn sweep_once(st: &mut SampleState) -> std::time::Duration {
    let roots = live_roots();
    let t_start = std::time::Instant::now();
    let snap = snapshot_procs();
    let pass_dur = t_start.elapsed();

    let kids = build_child_index(&snap);
    let mut claimed: HashSet<u32> = HashSet::new();
    let mut by_root: HashMap<u32, TreeStats> = HashMap::new();

    // Claim deepest-first so a nested agent keeps its own subtree. live_roots are
    // newest-first, which is NOT necessarily deepest-first, but for the heatmap we
    // care that (a) no process is double-counted and (b) each wrapper's subtree is
    // attributed. A parent absorbing a subagent slightly over-reports the parent
    // and under-reports the subagent — cosmetic for a heatmap, and still bounded.
    // TODO(perf): sort roots deepest-first (children before parents) to match the
    // TS sampler's exact attribution and keep parent/child numbers honest.
    for &root in &roots {
        let members = descendants_of(root, &kids, &claimed);
        for &m in &members {
            claimed.insert(m);
        }
        by_root.insert(root, rollup(root, &members, st.prev.get(&root), &snap));
    }

    // Everything not claimed by any agent root = the "unattributed" remainder.
    let rest: HashSet<u32> = snap
        .keys()
        .copied()
        .filter(|p| !claimed.contains(p))
        .collect();
    let unattributed = rollup(0, &rest, None, &snap);

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    let bucket_secs = st.bucket_secs.max(1);
    let max = window_len(bucket_secs);

    // Persist counters FOR NEXT sweep, then append buckets using THIS sweep's data.
    // (The CPU delta is vs the previous sweep's snapshot; we overwrite prev after.)
    let mut next_prev: HashMap<u32, HashMap<u32, ProcSample>> = HashMap::new();
    for &root in &roots {
        if let Some(stats) = by_root.get(&root) {
            let series = st.snap.agents.entry(root).or_default();
            series.push((now_ms, bucket_from(stats)));
            if series.len() > max {
                let drain = series.len() - max;
                series.drain(0..drain);
            }
        }
        next_prev.insert(root, snap.clone());
    }
    st.prev = next_prev;

    st.snap.unattributed = bucket_from(&unattributed);
    st.snap.bucket_secs = st.bucket_secs;

    pass_dur
}

/// Snapshot for the serve layer. Reads the cache without forcing a sweep.
pub fn res_snapshot() -> ResSnapshot {
    state().lock().map(|s| s.snap.clone()).unwrap_or_default()
}

/// Force one sweep now (first pass) and return the chosen bucket width. Used by
/// serve startup to prime the first /api/ls with real numbers, and by tests.
pub fn probe_once() -> u64 {
    let mut st = match state().lock() {
        Ok(st) => st,
        Err(_) => return BUCKET_FAST_SECS,
    };
    if st.bucket_secs == 0 {
        let d = sweep_once(&mut st);
        st.bucket_secs = if d.as_millis() < PASS_THRESHOLD_MS {
            BUCKET_FAST_SECS
        } else {
            BUCKET_SLOW_SECS
        };
        st.snap.bucket_secs = st.bucket_secs;
    }
    st.bucket_secs
}

/// Kick off the background sampler. Idempotent; spawn once from serve startup.
/// The thread sleeps a full bucket, then sweeps, then repeats. `probe_once` (called
/// from serve startup ahead of this) already primed the first sample and chose the
/// bucket width, so sleeping first avoids a double-sweep that would mint two
/// buckets at the same millisecond.
pub fn start_sampler() {
    std::thread::spawn(|| loop {
        std::thread::sleep(std::time::Duration::from_secs(current_bucket_secs().max(1)));
        let mut st = match state().lock() {
            Ok(st) => st,
            Err(_) => return,
        };
        if st.bucket_secs == 0 {
            // No probe ran (unusual): do the timing pass here to pick a width.
            let d = sweep_once(&mut st);
            st.bucket_secs = if d.as_millis() < PASS_THRESHOLD_MS {
                BUCKET_FAST_SECS
            } else {
                BUCKET_SLOW_SECS
            };
            st.snap.bucket_secs = st.bucket_secs;
        } else {
            sweep_once(&mut st);
        }
    });
}

/// The bucket width, or a sane default before the first pass has picked one.
fn current_bucket_secs() -> u64 {
    state()
        .lock()
        .map(|s| {
            if s.bucket_secs == 0 {
                BUCKET_FAST_SECS
            } else {
                s.bucket_secs
            }
        })
        .unwrap_or(BUCKET_FAST_SECS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_width_tracks_bucket() {
        assert_eq!(window_len(BUCKET_FAST_SECS), 60);
        assert_eq!(window_len(BUCKET_SLOW_SECS), 12);
    }

    #[test]
    fn window_clips_on_overflow() {
        let mut st = SampleState::default();
        st.bucket_secs = BUCKET_FAST_SECS;
        // Simulate 61 pushes into one agent's series via a direct manual clip.
        let mut series: Vec<(i64, Bucket)> = Vec::new();
        for i in 0..(WINDOW_FAST + 5) {
            series.push((i as i64, Bucket::default()));
            if series.len() > window_len(st.bucket_secs) {
                let drain = series.len() - window_len(st.bucket_secs);
                series.drain(0..drain);
            }
        }
        assert_eq!(series.len(), WINDOW_FAST);
    }
}
