// Per-process-TREE resource rollup for `ayrs serve`, ported from ts/procStats.ts.
//
// Why this exists: `ay ps`/`ay ls` list WRAPPER pids, but one ay-managed agent is
// a whole subtree — wrapper, CLI, its version process, bg-pty-host, bg-spare, the
// daemon, plus whatever the agent itself spawned (often 30+ processes). The VMM
// and `ps` see those as unrelated rows; only ay knows the wrapper pids, so only
// ay can roll the cost up to "this session costs 612 MiB / 1.2 cores".
//
// Deliberately BEST-EFFORT: every reader returns None/empty when it cannot answer
// (no /proc, unreadable pid, a process that exited mid-sample). The serve layer
// renders "-" rather than failing — an inspection feature must never be the thing
// that breaks the daemon.
//
// CPU is a SAMPLED DELTA, never a lifetime average: we read /proc/<pid>/stat's
// cumulative utime+stime twice, separated by a real time window, and subtract
// (guarding against pid reuse via the starttime token). RSS is a point-in-time
// snapshot (the resident set has no meaningful "delta").

use std::collections::{HashMap, HashSet};

/// clock ticks per second for the `utime`/`stime` fields of /proc/<pid>/stat.
/// Fixed at the syscall boundary (NOT the configurable CONFIG_HZ); 100 on every
/// Linux ABI we run on.
const USER_HZ: f64 = 100.0;

/// Assumed page size when we cannot measure the real one.
const DEFAULT_PAGE_SIZE: u64 = 4096;

/// One process, as sampled. `cpu_seconds` is CUMULATIVE since process start.
#[derive(Debug, Clone, Default)]
pub struct ProcSample {
    pub pid: u32,
    pub ppid: u32,
    pub rss: u64,
    /// Cumulative CPU (user+sys) in seconds since process start.
    pub cpu_seconds: f64,
    /// "when did this pid start" token (starttime field), for detecting pid
    /// reuse between the two samples. Empty when unknowable = "no opinion".
    pub start_token: String,
}

fn page_size() -> u64 {
    // Measure via /proc/self/status VmRSS (kB) vs /proc/self/stat rss (pages).
    // Hardcoding 4 KiB under-reports by 4x on a 16 KiB-page arm64 kernel.
    let read = |p: &str| std::fs::read_to_string(format!("/proc/self/{p}")).ok();
    let (Some(stat), Some(status)) = (read("stat"), read("status")) else {
        return DEFAULT_PAGE_SIZE;
    };
    let Some(close) = stat.rfind(')') else {
        return DEFAULT_PAGE_SIZE;
    };
    let pages: u64 = stat[close + 1..]
        .split_whitespace()
        .nth(21)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let kb: u64 = status
        .lines()
        .find_map(|l| l.strip_prefix("VmRSS:"))
        .and_then(|s| s.trim().split_whitespace().next())
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    if pages == 0 || kb == 0 {
        return DEFAULT_PAGE_SIZE;
    }
    let raw = (kb * 1024) as f64 / pages as f64;
    let mut best = DEFAULT_PAGE_SIZE;
    for candidate in [4096u64, 8192, 16384, 65536] {
        if (raw - candidate as f64).abs() < (raw - best as f64).abs() {
            best = candidate;
        }
    }
    best
}

/// Parse the fields of a /proc/<pid>/stat line we need. Field 2 (comm) is
/// wrapped in parens and may contain spaces AND parens, so everything after it
/// must be indexed from the LAST `)`. Post-`)` fields begin at field 3, so field
/// N is at index N-3: state=3→0, ppid=4→1, utime=14→11, stime=15→12,
/// starttime=22→19, rss=24→21.
fn parse_proc_stat(pid: u32, stat: &str, page_size_bytes: u64) -> Option<ProcSample> {
    let close = stat.rfind(')')?;
    let f: Vec<&str> = stat[close + 1..].split_whitespace().collect();
    // Need at least through rss (index 21) + starttime (index 19) + utime/stime.
    if f.len() <= 21 {
        return None;
    }
    let ppid: u32 = f.get(1)?.parse().ok()?;
    let utime: f64 = f.get(11)?.parse().ok()?;
    let stime: f64 = f.get(12)?.parse().ok()?;
    let rss_pages: u64 = f.get(21).and_then(|s| s.parse().ok()).unwrap_or(0);
    Some(ProcSample {
        pid,
        ppid,
        rss: rss_pages.saturating_mul(page_size_bytes),
        cpu_seconds: (utime + stime) / USER_HZ,
        start_token: f.get(19).copied().unwrap_or_default().to_string(),
    })
}

fn list_pids() -> Vec<u32> {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for e in entries.flatten() {
        let name = e.file_name();
        let Some(s) = name.to_str() else { continue };
        if s.bytes().all(|b| b.is_ascii_digit()) {
            if let Ok(pid) = s.parse::<u32>() {
                out.push(pid);
            }
        }
    }
    out
}

/// One snapshot of every visible process, keyed by pid. On Linux this reads
/// /proc/<pid>/stat concurrently (thousands of processes). On non-Linux (macOS/
/// BSD) there is no /proc, so it falls back to one `ps -eo` spawn — the same
/// fallback ts/procStats.ts's `defaultReadPsTable` uses. The ps fallback has no
/// stable start token (pid-reuse guard degrades to "no opinion") and reports CPU
/// as cumulative `utime+stime`/USER_HZ reconstructed from the `time=[[dd-]hh:]mm:ss`
/// column, so the delta math in the sampler still works.
pub fn snapshot_procs() -> HashMap<u32, ProcSample> {
    let pids = list_pids();
    if pids.is_empty() {
        return snapshot_ps_fallback();
    }
    let ps = page_size();
    // Chunk across a modest pool; each thread reads its share of /proc/<pid>/stat.
    let chunk = pids.len().div_ceil(16.min(pids.len())).max(1);
    std::thread::scope(|s| {
        let handles: Vec<_> = pids
            .chunks(chunk)
            .map(|part| {
                s.spawn(move || {
                    part.iter()
                        .filter_map(|&pid| parse_one(pid, ps))
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        let mut out = HashMap::new();
        for h in handles {
            for sample in h.join().unwrap_or_default() {
                out.insert(sample.pid, sample);
            }
        }
        out
    })
}

/// Parse `[[dd-]hh:]mm:ss` (ps `time=`) into cumulative CPU seconds.
fn parse_ps_time(raw: &str) -> f64 {
    let (days, clock) = match raw.split_once('-') {
        Some((d, c)) => (d.parse::<f64>().unwrap_or(0.0), c),
        None => (0.0, raw),
    };
    let mut secs = 0.0;
    let mut first = true;
    for part in clock.split(':') {
        secs = secs * 60.0 + part.parse::<f64>().unwrap_or(0.0);
        first = false;
    }
    let _ = first;
    secs + days * 86400.0
}

/// Non-Linux fallback: `ps -eo pid=,ppid=,rss=,time=,comm=` (comm last so its
/// spaces don't shift the fixed leading columns; state is dropped since macOS
/// offers no single-letter state in this column set, and we don't currently
/// render per-process state). RSS is in KiB on both Linux and macOS `ps`.
fn snapshot_ps_fallback() -> HashMap<u32, ProcSample> {
    let Ok(out) = std::process::Command::new("ps")
        .args(["-eo", "pid=,ppid=,rss=,time=,comm="])
        .output()
    else {
        return HashMap::new();
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut procs = HashMap::new();
    for line in text.lines() {
        let mut it = line.split_whitespace();
        let (Some(pid_s), Some(ppid_s), Some(rss_s), Some(time_s)) =
            (it.next(), it.next(), it.next(), it.next())
        else {
            continue;
        };
        let _comm = it.collect::<Vec<_>>().join(" ");
        let (Ok(pid), Ok(ppid), Ok(rss_kib)) = (
            pid_s.parse::<u32>(),
            ppid_s.parse::<u32>(),
            rss_s.parse::<u64>(),
        ) else {
            continue;
        };
        procs.insert(
            pid,
            ProcSample {
                pid,
                ppid,
                rss: rss_kib * 1024, // KiB → bytes
                cpu_seconds: parse_ps_time(time_s),
                start_token: String::new(), // no stable pid-reuse token from ps
            },
        );
    }
    procs
}

fn parse_one(pid: u32, page_size_bytes: u64) -> Option<ProcSample> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    parse_proc_stat(pid, &stat, page_size_bytes)
}

/// ppid → children index, for descendant walks.
pub fn build_child_index(procs: &HashMap<u32, ProcSample>) -> HashMap<u32, Vec<u32>> {
    let mut kids: HashMap<u32, Vec<u32>> = HashMap::new();
    for p in procs.values() {
        kids.entry(p.ppid).or_default().push(p.pid);
    }
    kids
}

/// Every pid in the subtree rooted at `root`, inclusive (explicit stack, so a
/// corrupt/racing snapshot with a cycle degrades instead of overflowing).
pub fn descendants_of(
    root: u32,
    kids: &HashMap<u32, Vec<u32>>,
    exclude: &HashSet<u32>,
) -> HashSet<u32> {
    let mut out = HashSet::new();
    let mut stack = vec![root];
    while let Some(pid) = stack.pop() {
        if out.contains(&pid) || exclude.contains(&pid) {
            continue;
        }
        out.insert(pid);
        if let Some(children) = kids.get(&pid) {
            for &c in children {
                stack.push(c);
            }
        }
    }
    out
}

/// Rolled-up cost of one agent's whole process subtree over a sample window.
#[derive(Debug, Clone, Default)]
pub struct TreeStats {
    pub pid: u32,
    pub rss: u64,
    /// Summed CPU seconds across the subtree over the window (NOT yet divided by
    /// elapsed — the caller divides by the measured window to get a fraction).
    pub cpu_delta: f64,
    pub procs: usize,
}

/// Sum one root's claimed members' cost, guarding pid reuse (starttime change)
/// and newcomers (no baseline → 0 CPU contribution this window).
fn rollup(
    root: u32,
    members: &HashSet<u32>,
    first: &HashMap<u32, ProcSample>,
    second: &HashMap<u32, ProcSample>,
) -> TreeStats {
    let mut rss = 0u64;
    let mut cpu_delta = 0f64;
    let mut count = 0usize;
    for &pid in members {
        let Some(now) = second.get(&pid) else {
            continue;
        }; // exited mid-window
        count += 1;
        rss = rss.saturating_add(now.rss);
        let Some(before) = first.get(&pid) else {
            continue;
        }; // newcomer: no baseline
           // pid reuse: same pid, different process → subtracting is meaningless.
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

/// Whole-box vitals: loadavg (1/5/15) and memory from /proc/loadavg + meminfo.
#[derive(Debug, Clone, Default)]
pub struct SystemStats {
    pub load: [f64; 3],
    pub load_valid: bool,
    pub ncpu: u32,
    pub mem_total: u64,
    pub mem_available: u64,
}

/// Parse /proc/meminfo (`MemTotal:  16316360 kB`) into a byte-valued map.
pub fn parse_meminfo(raw: &str) -> HashMap<String, u64> {
    let mut out = HashMap::new();
    for line in raw.lines() {
        let mut it = line.split_whitespace();
        let Some(key) = it.next() else { continue };
        let key = key.trim_end_matches(':').to_string();
        let Some(val) = it.next().and_then(|v| v.parse::<u64>().ok()) else {
            continue;
        };
        out.insert(key, val * 1024);
    }
    out
}

pub fn system_stats() -> SystemStats {
    let mut s = SystemStats {
        ncpu: std::thread::available_parallelism()
            .map(|n| n.get() as u32)
            .unwrap_or(0),
        ..Default::default()
    };
    if let Ok(load_raw) = std::fs::read_to_string("/proc/loadavg") {
        let fields: Vec<f64> = load_raw
            .split_whitespace()
            .take(3)
            .map(|x| x.parse().unwrap_or(f64::NAN))
            .collect();
        if fields.len() == 3 && fields.iter().all(|f| f.is_finite()) {
            s.load = [fields[0], fields[1], fields[2]];
            s.load_valid = true;
        }
    } else {
        // Non-Linux: getloadavg(3) works on macOS/BSD too (matches node:os in the
        // TS fallback). No /proc/loadavg there.
        #[cfg(unix)]
        unsafe {
            let mut la = [0f64; 3];
            let n = libc::getloadavg(la.as_mut_ptr(), 3);
            if n >= 1 {
                s.load = la;
                s.load_valid = la.iter().any(|&x| x > 0.0);
            }
        }
    }
    if let Ok(mem_raw) = std::fs::read_to_string("/proc/meminfo") {
        let mem = parse_meminfo(&mem_raw);
        s.mem_total = mem.get("MemTotal").copied().unwrap_or(0);
        // MemAvailable is the kernel's own estimate of what a new allocation can
        // get; "free" is misleading on a warm page cache.
        s.mem_available = mem.get("MemAvailable").copied().unwrap_or(0);
    } else {
        // macOS/BSD: `sysctl hw.memsize` (bytes) is total RAM. "Available" has no
        // direct sysctl twin (`vm.page_free_count` is far too low to be useful),
        // so we approximate used-vs-total from `vm_stat` by reusing the VM's
        // free+inactive pages — a reasonable "reclaimable" proxy.
        s.mem_total = sysctl_u64("hw.memsize").unwrap_or(0);
        s.mem_available = macos_available_bytes().unwrap_or(0);
    }
    s
}

/// Read a u64 sysctl on macOS/BSD. None on error (unsupported key, non-macOS…).
fn sysctl_u64(key: &str) -> Option<u64> {
    let out = std::process::Command::new("sysctl")
        .args(["-n", key])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    text.trim().parse::<u64>().ok()
}

/// MacOS "reclaimable" memory ≈ free + inactive pages from `vm_stat` (page size
/// 4096 on arm64). Best-effort; None when vm_stat is missing/parse fails.
fn macos_available_bytes() -> Option<u64> {
    let out = std::process::Command::new("vm_stat").output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let mut free = 0u64;
    let mut inactive = 0u64;
    for line in text.lines() {
        let mut it = line.split(':');
        let Some(key) = it.next() else { continue };
        let key = key.trim();
        let Some(val) = it.next().and_then(|v| v.trim().strip_suffix('.')) else {
            continue;
        };
        let val = val.trim().parse::<u64>().unwrap_or(0);
        match key {
            "Pages free" => free = val,
            "Pages inactive" => inactive = val,
            _ => {}
        }
    }
    if free == 0 && inactive == 0 {
        return None;
    }
    Some((free + inactive).saturating_mul(4096))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_stat_indexes_past_parens_in_comm() {
        // comm contains a paren and a space: "foo) bar (baz" — fields after the
        // LAST `)` must still parse. state=S, ppid=1, utime=100, stime=200.
        let line = "42 (foo) bar (baz) S 1 0 0 0 0 0 0 0 0 0 100 200 0 0 0 0 0 0 99 0 30 0 0 0 0 0 0 0 0 0 0";
        let p = parse_proc_stat(42, line, 4096).unwrap();
        assert_eq!(p.pid, 42);
        assert_eq!(p.ppid, 1);
        assert_eq!(p.cpu_seconds, (100.0 + 200.0) / USER_HZ);
        assert_eq!(p.rss, 30 * 4096);
        assert_eq!(p.start_token, "99");
    }

    #[test]
    fn descendants_walk_closure_and_cycle_terminates() {
        let mut procs = HashMap::new();
        for &(pid, ppid) in &[(1, 0), (2, 1), (3, 1), (4, 3), (5, 4)] {
            procs.insert(
                pid,
                ProcSample {
                    pid,
                    ppid,
                    ..Default::default()
                },
            );
        }
        // Add a (impossible but defensive) cycle: 5 -> 3.
        let kids = build_child_index(&procs);
        let d = descendants_of(1, &kids, &HashSet::new());
        assert_eq!(d, HashSet::from([1, 2, 3, 4, 5]));
    }

    #[test]
    fn rollup_skips_newcomer_and_reused_pid_cpu() {
        let mut first = HashMap::new();
        first.insert(
            1,
            ProcSample {
                pid: 1,
                ppid: 0,
                cpu_seconds: 10.0,
                start_token: "A".into(),
                rss: 1000,
            },
        );
        // pid 2 in second only → newcomer, contributes 0 CPU.
        // pid 3 reused (token B → C) → contributes 0 CPU.
        let mut second = HashMap::new();
        second.insert(
            1,
            ProcSample {
                pid: 1,
                ppid: 0,
                cpu_seconds: 12.0,
                start_token: "A".into(),
                rss: 2000,
            },
        );
        second.insert(
            2,
            ProcSample {
                pid: 2,
                ppid: 1,
                cpu_seconds: 99.0,
                start_token: "X".into(),
                rss: 50,
            },
        );
        second.insert(
            3,
            ProcSample {
                pid: 3,
                ppid: 1,
                cpu_seconds: 30.0,
                start_token: "C".into(),
                rss: 40,
            },
        );
        // Give pid 3 a baseline too, but with token B.
        first.insert(
            3,
            ProcSample {
                pid: 3,
                ppid: 1,
                cpu_seconds: 20.0,
                start_token: "B".into(),
                rss: 30,
            },
        );

        let members = HashSet::from([1, 2, 3]);
        let t = rollup(1, &members, &first, &second);
        assert_eq!(t.procs, 3);
        assert_eq!(t.rss, 2000 + 50 + 40);
        // Only pid 1 contributes a delta: 12 - 10 = 2.
        assert!((t.cpu_delta - 2.0).abs() < 1e-9);
    }

    #[test]
    fn meminfo_parses_bytes() {
        let raw = "MemTotal:       16316360 kB\nMemAvailable:   1000000 kB\n";
        let m = parse_meminfo(raw);
        assert_eq!(m.get("MemTotal"), Some(&(16316360u64 * 1024)));
        assert_eq!(m.get("MemAvailable"), Some(&(1000000u64 * 1024)));
    }
}
