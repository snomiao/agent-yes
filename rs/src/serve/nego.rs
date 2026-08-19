// PTY size negotiation — Rust port of ts/sizeNego.ts + the serve-side cap
// store / applyNego machinery (ts/serve.ts, PR #266 "smallest client wins").
//
// Mechanism (identical to the TS daemon, byte-compatible file formats so both
// daemons can negotiate over the same agents concurrently):
//   - each viewer reports a size cap via POST /api/presence {cap:{cols,rows}}
//   - serve persists one cap file per (daemon, viewer):
//       ~/.agent-yes/caps/<agent_pid>/d<serve_pid>:<viewer>
//     containing "<cols> <rows> <ts_ms> <role>\n"; TTL 12s
//   - negotiation = elementwise min over live caps, floored at 40x10
//   - the winner is written to ~/.agent-yes/winsize/<pid> ("<cols> <rows> <ts>\n")
//     followed by SIGWINCH; the agent runtime (rs pty_spawner / ts index) reads
//     the file on SIGWINCH (or polls on Windows) and resizes the real PTY
//   - when the last cap disappears, withdraw after a 30s grace — but only for
//     agents that still have a real TTY (never snap a headless agent to 80x24),
//     and only if the winsize file still holds our own last write
use once_cell::sync::Lazy;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::time::Duration;
use tokio::sync::Mutex;

pub const CAP_MIN_COLS: u32 = 20;
pub const CAP_MAX_COLS: u32 = 500;
pub const CAP_MIN_ROWS: u32 = 5;
pub const CAP_MAX_ROWS: u32 = 200;
pub const NEGO_FLOOR_COLS: u32 = 40;
pub const NEGO_FLOOR_ROWS: u32 = 10;
pub const CAP_TTL_MS: i64 = 12_000;
pub const PRESENCE_TTL_MS: i64 = 12_000;
const NEGO_DEBOUNCE_MS: u64 = 350;
const NEGO_SWEEP_MS: u64 = 5_000;
const NEGO_WITHDRAW_GRACE_MS: i64 = 30_000;
/// ±1-cell dead band against the on-disk winsize, absorbing viewer jitter and
/// duplicate writes from sibling daemons negotiating the same union of caps.
const DEAD_BAND: i64 = 1;

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Cap {
    pub cols: u32,
    pub rows: u32,
}

/// Floor to ints, reject out-of-range (mirrors sanitizeCap).
pub fn sanitize_cap(cols: f64, rows: f64) -> Option<Cap> {
    if !cols.is_finite() || !rows.is_finite() {
        return None;
    }
    let (c, r) = (cols.floor() as i64, rows.floor() as i64);
    if c < CAP_MIN_COLS as i64
        || c > CAP_MAX_COLS as i64
        || r < CAP_MIN_ROWS as i64
        || r > CAP_MAX_ROWS as i64
    {
        return None;
    }
    Some(Cap { cols: c as u32, rows: r as u32 })
}

/// Elementwise min over caps, clamped up to the floor (mirrors negotiateSize).
pub fn negotiate_size(caps: &[Cap]) -> Option<Cap> {
    let first = caps.first()?;
    let mut eff = *first;
    for c in &caps[1..] {
        eff.cols = eff.cols.min(c.cols);
        eff.rows = eff.rows.min(c.rows);
    }
    eff.cols = eff.cols.max(NEGO_FLOOR_COLS);
    eff.rows = eff.rows.max(NEGO_FLOOR_ROWS);
    Some(eff)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn global_dir() -> PathBuf {
    if let Ok(h) = std::env::var("AGENT_YES_HOME") {
        return PathBuf::from(h);
    }
    dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")).join(".agent-yes")
}

fn caps_dir(pid: u32) -> PathBuf {
    global_dir().join("caps").join(pid.to_string())
}

fn winsize_path(pid: u32) -> PathBuf {
    global_dir().join("winsize").join(pid.to_string())
}

pub fn ptysize_path(pid: u32) -> PathBuf {
    global_dir().join("ptysize").join(pid.to_string())
}

/// Read the agent's current PTY size sidecar ("<cols> <rows>\n"), for /api/size.
pub fn read_ptysize(pid: u32) -> Option<(u32, u32)> {
    let s = std::fs::read_to_string(ptysize_path(pid)).ok()?;
    let mut it = s.split_whitespace();
    let cols: u32 = it.next()?.parse().ok()?;
    let rows: u32 = it.next()?.parse().ok()?;
    if cols == 0 || rows == 0 {
        return None;
    }
    Some((cols, rows))
}

/// Cap filename: d<serve_pid>:<viewer> with [^\w.:-] replaced by "_",
/// byte-compatible with the TS capFile().
fn cap_file(pid: u32, viewer: &str) -> PathBuf {
    let raw = format!("d{}:{}", std::process::id(), viewer);
    let safe: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == ':' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    caps_dir(pid).join(safe)
}

pub fn publish_cap(pid: u32, viewer: &str, cap: Cap, role: &str) {
    let dir = caps_dir(pid);
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(
        cap_file(pid, viewer),
        format!("{} {} {} {}\n", cap.cols, cap.rows, now_ms(), role),
    );
}

pub fn withdraw_cap(pid: u32, viewer: &str) {
    let _ = std::fs::remove_file(cap_file(pid, viewer));
}

/// Read every live cap for an agent, pruning files older than CAP_TTL_MS.
fn read_shared_caps(pid: u32) -> Vec<Cap> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(caps_dir(pid)) else {
        return out;
    };
    let now = now_ms();
    for e in entries.flatten() {
        let path = e.path();
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        let mut it = content.split_whitespace();
        let cap = (|| {
            let cols: f64 = it.next()?.parse().ok()?;
            let rows: f64 = it.next()?.parse().ok()?;
            let ts: i64 = it.next()?.parse().ok()?;
            if now - ts > CAP_TTL_MS {
                return None; // stale — prune below
            }
            sanitize_cap(cols, rows)
        })();
        match cap {
            Some(c) => out.push(c),
            None => {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
    out
}

/// `ps -o tty= -p <pid>` — "?"/"??"/empty/error ⇒ no real TTY ⇒ never withdraw
/// (a headless agent would snap back to 80x24).
fn has_real_tty(pid: u32) -> bool {
    #[cfg(unix)]
    {
        let out = std::process::Command::new("ps")
            .args(["-o", "tty=", "-p", &pid.to_string()])
            .output();
        match out {
            Ok(o) if o.status.success() => {
                let tty = String::from_utf8_lossy(&o.stdout).trim().to_string();
                !(tty.is_empty() || tty == "?" || tty == "??")
            }
            _ => false,
        }
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}

fn sigwinch(pid: u32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, libc::SIGWINCH);
    }
    #[cfg(not(unix))]
    let _ = pid; // Windows runtime polls the winsize file every 250ms
}

// ---- presence + nego state ---------------------------------------------------

#[derive(Clone)]
pub struct PresenceEntry {
    pub viewer: String,
    pub agent: String, // pid, stringified like the TS map
    pub cols: u32,
    pub rows: u32,
    pub sel: Option<String>,
    pub cap: Option<Cap>,
    pub ts: i64,
}

struct AppliedWrite {
    content: String, // exact bytes we last wrote to winsize/<pid>
}

#[derive(Default)]
struct NegoState {
    presence: HashMap<String, PresenceEntry>,
    applied: HashMap<u32, AppliedWrite>,
    caps_gone_at: HashMap<u32, i64>,
    pending: HashSet<u32>,
    sweep_running: bool,
}

static STATE: Lazy<Mutex<NegoState>> = Lazy::new(|| Mutex::new(NegoState::default()));

/// Debounced negotiation trigger (mirrors scheduleNego, 350ms). Also lazily
/// starts the 5s grow-back sweep that re-negotiates every applied pid so cap
/// TTL expiry / foreign winsize drift heals without any POST.
pub async fn schedule_nego(pid: u32) {
    let mut st = STATE.lock().await;
    if !st.sweep_running {
        st.sweep_running = true;
        tokio::spawn(async {
            loop {
                tokio::time::sleep(Duration::from_millis(NEGO_SWEEP_MS)).await;
                let pids: Vec<u32> = STATE.lock().await.applied.keys().copied().collect();
                for pid in pids {
                    schedule_nego_inner(pid).await;
                }
            }
        });
    }
    if st.pending.contains(&pid) {
        return;
    }
    st.pending.insert(pid);
    drop(st);
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(NEGO_DEBOUNCE_MS)).await;
        STATE.lock().await.pending.remove(&pid);
        apply_nego(pid).await;
    });
}

async fn schedule_nego_inner(pid: u32) {
    // sweep path skips the debounce-dedup bookkeeping; apply directly
    apply_nego(pid).await;
}

async fn apply_nego(pid: u32) {
    let caps = tokio::task::spawn_blocking(move || read_shared_caps(pid))
        .await
        .unwrap_or_default();
    let eff = negotiate_size(&caps);
    let mut st = STATE.lock().await;
    match eff {
        Some(eff) => {
            st.caps_gone_at.remove(&pid);
            // dead band vs the ON-DISK winsize (not our prev write): absorbs
            // jitter and heals foreign writes only when they truly differ
            let curr = std::fs::read_to_string(winsize_path(pid)).ok().and_then(|s| {
                let mut it = s.split_whitespace();
                Some((it.next()?.parse::<i64>().ok()?, it.next()?.parse::<i64>().ok()?))
            });
            if let Some((c, r)) = curr {
                if (c - eff.cols as i64).abs() <= DEAD_BAND && (r - eff.rows as i64).abs() <= DEAD_BAND {
                    // still record that nego owns this pid so the sweep keeps watching
                    st.applied.entry(pid).or_insert(AppliedWrite {
                        content: format!("{} {}", eff.cols, eff.rows),
                    });
                    return;
                }
            }
            let content = format!("{} {} {}\n", eff.cols, eff.rows, now_ms());
            let path = winsize_path(pid);
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            if std::fs::write(&path, &content).is_ok() {
                st.applied.insert(pid, AppliedWrite { content: content.clone() });
                sigwinch(pid);
                eprintln!(
                    "[api/resize] pid={pid} {}x{} src=presence-nego daemon=d{} caps={}",
                    eff.cols,
                    eff.rows,
                    std::process::id(),
                    caps.len(),
                );
            }
        }
        None => {
            // no live caps: withdraw only if we ever applied, after a grace
            // period, and only for agents with a real TTY
            let Some(prev) = st.applied.get(&pid).map(|a| a.content.clone()) else {
                return;
            };
            let gone_at = *st.caps_gone_at.entry(pid).or_insert_with(now_ms);
            if now_ms() - gone_at < NEGO_WITHDRAW_GRACE_MS {
                return;
            }
            drop(st);
            let tty = tokio::task::spawn_blocking(move || has_real_tty(pid))
                .await
                .unwrap_or(false);
            let mut st = STATE.lock().await;
            if !tty {
                return; // headless — leave the negotiated size in place forever
            }
            // only unlink if the file still holds OUR last write; a different
            // content means `ay attach` / a forced resize owns it now
            let path = winsize_path(pid);
            if std::fs::read_to_string(&path).map(|c| c == prev).unwrap_or(false) {
                let _ = std::fs::remove_file(&path);
                sigwinch(pid);
                eprintln!(
                    "[api/resize] pid={pid} withdraw src=presence-nego daemon=d{}",
                    std::process::id()
                );
            }
            st.applied.remove(&pid);
            st.caps_gone_at.remove(&pid);
        }
    }
}

// ---- /api/presence handlers ----------------------------------------------------

/// POST /api/presence — returns Err((status, msg)) for protocol errors.
pub async fn presence_post(body: &Value) -> Result<(), (u16, String)> {
    let viewer: String = body
        .get("viewer")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .chars()
        .take(64)
        .collect();
    if viewer.is_empty() {
        return Err((400, "missing viewer".into()));
    }
    let agent: Option<u32> = match body.get("agent") {
        None | Some(Value::Null) => None,
        Some(Value::Number(n)) => n.as_u64().map(|v| v as u32),
        Some(Value::String(s)) => s.parse().ok(),
        _ => None,
    };
    let cap = body.get("cap").and_then(|c| {
        let cols = c.get("cols")?.as_f64()?;
        let rows = c.get("rows")?.as_f64()?;
        Some((cols, rows))
    });
    // Mutate the map under the lock, but run every await (file I/O,
    // schedule_nego — which re-locks STATE) strictly AFTER the guard drops:
    // holding the non-reentrant tokio Mutex across schedule_nego() deadlocked
    // the whole presence/nego subsystem the first time a viewer switched agents.
    let sane = cap.and_then(|(c, r)| sanitize_cap(c, r));
    let mut withdraw_prev: Option<u32> = None;
    let mut st = STATE.lock().await;
    let prev_agent: Option<u32> = st.presence.get(&viewer).and_then(|e| e.agent.parse().ok());
    match agent {
        None => {
            // clear this viewer's entry (and its cap on the previous agent)
            st.presence.remove(&viewer);
            drop(st);
            if let Some(prev) = prev_agent {
                let v = viewer.clone();
                tokio::task::spawn_blocking(move || withdraw_cap(prev, &v)).await.ok();
                schedule_nego(prev).await;
            }
        }
        Some(pid) => {
            if let Some(prev) = prev_agent {
                if prev != pid {
                    withdraw_prev = Some(prev);
                }
            }
            st.presence.insert(
                viewer.clone(),
                PresenceEntry {
                    viewer: viewer.clone(),
                    agent: pid.to_string(),
                    cols: body.get("cols").and_then(|v| v.as_f64()).map(|v| v.max(0.0) as u32).unwrap_or(0),
                    rows: body.get("rows").and_then(|v| v.as_f64()).map(|v| v.max(0.0) as u32).unwrap_or(0),
                    sel: body
                        .get("sel")
                        .and_then(|v| v.as_str())
                        .map(|s| s.chars().take(200).collect()),
                    cap: sane,
                    ts: now_ms(),
                },
            );
            drop(st);
            if let Some(prev) = withdraw_prev {
                let v = viewer.clone();
                tokio::task::spawn_blocking(move || withdraw_cap(prev, &v)).await.ok();
                schedule_nego(prev).await;
            }
            let v = viewer.clone();
            match sane {
                Some(c) => {
                    tokio::task::spawn_blocking(move || publish_cap(pid, &v, c, "viewer"))
                        .await
                        .ok();
                }
                None => {
                    tokio::task::spawn_blocking(move || withdraw_cap(pid, &v)).await.ok();
                }
            }
            schedule_nego(pid).await;
        }
    }
    Ok(())
}

/// GET /api/presence — live entries, TTL-pruned.
pub async fn presence_get() -> Value {
    let mut st = STATE.lock().await;
    let now = now_ms();
    st.presence.retain(|_, e| now - e.ts <= PRESENCE_TTL_MS);
    let entries: Vec<Value> = st
        .presence
        .values()
        .map(|e| {
            json!({
                "viewer": e.viewer,
                "agent": e.agent,
                "cols": e.cols,
                "rows": e.rows,
                "sel": e.sel,
                "cap": e.cap.map(|c| json!({"cols": c.cols, "rows": c.rows})),
                "ts": e.ts,
            })
        })
        .collect();
    Value::Array(entries)
}

/// POST /api/resize/:pid — cap mode by default, force mode with force:true
/// (the WebRTC bridge always carries the master token, so force is honored).
pub async fn resize_post(pid: u32, body: &Value) -> Result<Value, (u16, String)> {
    let cols = body.get("cols").and_then(|v| v.as_f64()).map(|v| v.floor().max(1.0)).unwrap_or(0.0);
    let rows = body.get("rows").and_then(|v| v.as_f64()).map(|v| v.floor().max(1.0)).unwrap_or(0.0);
    if cols < 1.0 || rows < 1.0 {
        return Err((400, "missing cols/rows".into()));
    }
    let force = body.get("force").and_then(|v| v.as_bool()).unwrap_or(false);
    if force {
        let content = format!("{} {} {}\n", cols as u32, rows as u32, now_ms());
        let path = winsize_path(pid);
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        std::fs::write(&path, &content).map_err(|e| (500, e.to_string()))?;
        sigwinch(pid);
        eprintln!(
            "[api/resize] pid={pid} {}x{} src=api-resize-FORCED daemon=d{}",
            cols as u32,
            rows as u32,
            std::process::id()
        );
        return Ok(json!({"ok": true, "pid": pid, "cols": cols as u32, "rows": rows as u32, "forced": true}));
    }
    let Some(cap) = sanitize_cap(cols, rows) else {
        return Err((400, "cols/rows out of range".into()));
    };
    let viewer: String = body
        .get("viewer")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("api-resize")
        .chars()
        .take(64)
        .collect();
    let v = viewer.clone();
    tokio::task::spawn_blocking(move || publish_cap(pid, &v, cap, "viewer")).await.ok();
    schedule_nego(pid).await;
    eprintln!(
        "[api/resize] pid={pid} {}x{} src=api-resize-cap daemon=d{}",
        cap.cols,
        cap.rows,
        std::process::id()
    );
    Ok(json!({"ok": true, "pid": pid, "cols": cap.cols, "rows": cap.rows, "mode": "cap"}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_bounds() {
        assert_eq!(sanitize_cap(100.7, 30.9), Some(Cap { cols: 100, rows: 30 }));
        assert_eq!(sanitize_cap(19.0, 30.0), None);
        assert_eq!(sanitize_cap(501.0, 30.0), None);
        assert_eq!(sanitize_cap(100.0, 4.0), None);
        assert_eq!(sanitize_cap(100.0, 201.0), None);
        assert_eq!(sanitize_cap(f64::NAN, 30.0), None);
    }

    #[test]
    fn negotiate_min_and_floor() {
        let caps = [Cap { cols: 120, rows: 40 }, Cap { cols: 90, rows: 50 }];
        assert_eq!(negotiate_size(&caps), Some(Cap { cols: 90, rows: 40 }));
        // floor clamps tiny mins up to 40x10
        let caps = [Cap { cols: 20, rows: 5 }];
        assert_eq!(negotiate_size(&caps), Some(Cap { cols: 40, rows: 10 }));
        assert_eq!(negotiate_size(&[]), None);
    }

    // Regression: a viewer switching agents (prev != pid) used to call
    // schedule_nego() while still holding the STATE guard — a self-deadlock on
    // the non-reentrant tokio Mutex that froze every later presence request.
    #[tokio::test]
    async fn viewer_agent_switch_does_not_deadlock() {
        // NOTE: no AGENT_YES_HOME override — env vars are process-global and
        // racing the other tests on it is flaky. The fake pids write throwaway
        // cap files under the real home; cleaned up below (and TTL-pruned).
        let b1 = serde_json::json!({"viewer":"swt","agent":911111,"cap":{"cols":100,"rows":30}});
        let b2 = serde_json::json!({"viewer":"swt","agent":922222,"cap":{"cols":100,"rows":30}});
        let run = async {
            presence_post(&b1).await.unwrap();
            presence_post(&b2).await.unwrap(); // the prev != pid path
            presence_get().await
        };
        let got = tokio::time::timeout(std::time::Duration::from_secs(5), run)
            .await
            .expect("presence deadlocked on viewer agent-switch");
        assert!(!got.as_array().unwrap().is_empty());
        for pid in [911111u32, 922222] {
            let _ = std::fs::remove_dir_all(caps_dir(pid));
            let _ = std::fs::remove_file(winsize_path(pid));
        }
    }

    #[test]
    fn cap_file_sanitizes_name() {
        let p = cap_file(1, "we/ird viewer");
        let name = p.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with(&format!("d{}:", std::process::id())));
        assert!(name.ends_with("we_ird_viewer"));
    }
}
