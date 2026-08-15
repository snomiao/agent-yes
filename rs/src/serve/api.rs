// Native Rust port of the minimal ay-serve API surface the browser console
// needs over a WebRTC room: /api/ls, /api/ls/subscribe, /api/whoami,
// /api/version, /api/host, /api/size/:kw, /api/tail/:kw, /api/send.
// Everything else 404s — the console tolerates that and degrades.
//
// Response shapes mirror ts/serve.ts exactly (see that file for the source of
// truth); data comes from the same files the TS daemon uses: pids.jsonl,
// <cwd>/.agent-yes/<pid>.raw.log, and the per-pid stdin FIFOs.
use crate::pid_store::{is_process_alive, PidRecord};
use serde_json::{json, Value};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::time::Duration;
use tokio::sync::mpsc;

const TAIL_SNAPSHOT_BYTES: u64 = 65_536;
const SSE_PING_MS: u64 = 15_000;
// A full tick enriches every agent from its live PTY log. One second saturates
// a core on larger fleets whose logs are all moving, starving the WebRTC data
// channel that carries the snapshot itself. Three seconds matches the console's
// former polling cadence while SSE still avoids sending unchanged records.
const LS_TICK_MS: u64 = 3_000;
// 50ms keeps keystroke echo snappy (the TS daemon uses fs.watch + a 60ms
// unwatched poll; a plain 50ms stat poll costs ~nothing and needs no watcher
// lifecycle — see agent-yes-fswatch-dies-in-daemon for why watchers are risky
// in long-lived daemons).
const TAIL_POLL_MS: u64 = 50;
/// Consider an agent "active" if its log grew within this window, else "idle".
const ACTIVE_WINDOW_MS: i64 = 60_000;

pub enum Body {
    Full(Vec<u8>),
    /// Streaming body (SSE). The channel closing ends the stream.
    Stream(mpsc::Receiver<Vec<u8>>),
}

pub struct ApiResponse {
    pub status: u16,
    pub content_type: String,
    pub body: Body,
}

fn text(status: u16, s: impl Into<String>) -> ApiResponse {
    ApiResponse {
        status,
        content_type: "text/plain".into(),
        body: Body::Full(s.into().into_bytes()),
    }
}

fn json_res(status: u16, v: &Value) -> ApiResponse {
    ApiResponse {
        status,
        content_type: "application/json".into(),
        body: Body::Full(serde_json::to_vec(v).unwrap_or_default()),
    }
}

fn global_dir() -> PathBuf {
    if let Ok(h) = std::env::var("AGENT_YES_HOME") {
        return PathBuf::from(h);
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".agent-yes")
}

/// Load or mint the serve API bearer token — same file the TS daemon uses
/// (`~/.agent-yes/.serve-token`), so links/tokens stay interchangeable.
pub fn load_or_create_token() -> std::io::Result<String> {
    let path = global_dir().join(".serve-token");
    if let Ok(t) = std::fs::read_to_string(&path) {
        let t = t.trim().to_string();
        if !t.is_empty() {
            return Ok(t);
        }
    }
    let token = crate::serve::e2e::random_hex(24);
    std::fs::create_dir_all(global_dir())?;
    std::fs::write(&path, &token)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(token)
}

// ---- pids.jsonl -------------------------------------------------------------

fn read_records() -> Vec<PidRecord> {
    let path = global_dir().join("pids.jsonl");
    let Ok(content) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    // merge by pid, last line wins (same as the TS/Rust stores)
    let mut order: Vec<u32> = Vec::new();
    let mut by_pid: std::collections::HashMap<u32, PidRecord> = std::collections::HashMap::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(r) = serde_json::from_str::<PidRecord>(line) {
            if !by_pid.contains_key(&r.pid) {
                order.push(r.pid);
            }
            by_pid.insert(r.pid, r);
        }
    }
    order
        .into_iter()
        .filter_map(|p| by_pid.remove(&p))
        .collect()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn file_mtime_ms(path: &str) -> Option<i64> {
    let meta = std::fs::metadata(path).ok()?;
    let m = meta.modified().ok()?;
    Some(m.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as i64)
}

/// Window within which a recorded human keystroke still counts as "typing"
/// (ts/subcommands.ts TYPING_WINDOW_MS) — comfortably longer than the Rust
/// writer's throttle so continuous typing never flickers off.
const TYPING_WINDOW_MS: i64 = 3_000;

fn is_user_typing(pid: u32) -> bool {
    last_stdin_at(pid)
        .map(|t| now_ms() - t < TYPING_WINDOW_MS)
        .unwrap_or(false)
}

fn last_stdin_at(pid: u32) -> Option<i64> {
    let p = global_dir().join("activity").join(format!("{pid}.stdin"));
    std::fs::read_to_string(p).ok()?.trim().parse().ok()
}

// ---- log-derived metadata (title / status_text), same logic as ts/serve.ts ----

type MetaCache = std::sync::Mutex<std::collections::HashMap<String, (u64, i64, Option<String>)>>;
static TITLE_CACHE: once_cell::sync::Lazy<MetaCache> = once_cell::sync::Lazy::new(Default::default);
static STATUS_CACHE: once_cell::sync::Lazy<MetaCache> =
    once_cell::sync::Lazy::new(Default::default);

fn read_file_tail(path: &str, max: u64) -> std::io::Result<(u64, i64, Vec<u8>)> {
    let mut f = std::fs::File::open(path)?;
    let meta = f.metadata()?;
    let size = meta.len();
    let mtime = meta
        .modified()
        .ok()
        .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    f.seek(SeekFrom::Start(size.saturating_sub(max)))?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf)?;
    Ok((size, mtime, buf))
}

fn file_version(path: &str) -> Option<(u64, i64)> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Some((meta.len(), mtime))
}

fn cache_get(cache: &MetaCache, key: &str, size: u64, mtime: i64) -> Option<Option<String>> {
    let map = cache.lock().ok()?;
    match map.get(key) {
        Some((s, m, v)) if *s == size && *m == mtime => Some(v.clone()),
        _ => None,
    }
}

fn cache_put(cache: &MetaCache, key: &str, size: u64, mtime: i64, v: Option<String>) {
    if let Ok(mut map) = cache.lock() {
        map.insert(key.to_string(), (size, mtime, v));
    }
}

fn strip_control(s: &str) -> String {
    s.chars()
        .filter(|c| {
            let n = *c as u32;
            !(n < 0x20 || (0x7f..=0x9f).contains(&n))
        })
        .collect()
}

/// Latest OSC 0/2 terminal title in the log tail (ts/serve.ts logTitle):
/// agents retitle their terminal via `\x1b]2;name\x07`; the most recent
/// non-empty one labels the console row. Cached per (size, mtime).
fn log_title(log_file: Option<&str>) -> Option<String> {
    let log_file = log_file?;
    let (size, mtime, buf) = read_file_tail(log_file, 65_536).ok()?;
    if let Some(hit) = cache_get(&TITLE_CACHE, log_file, size, mtime) {
        return hit;
    }
    // /\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g — last non-empty match wins.
    static OSC_TITLE: once_cell::sync::Lazy<regex::bytes::Regex> =
        once_cell::sync::Lazy::new(|| {
            regex::bytes::Regex::new(r"\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)").unwrap()
        });
    let mut title: Option<String> = None;
    for m in OSC_TITLE.captures_iter(&buf) {
        let candidate = String::from_utf8_lossy(&m[1]);
        let cleaned = strip_control(candidate.trim());
        let capped: String = cleaned.chars().take(256).collect();
        let capped = capped.trim().to_string();
        if !capped.is_empty() {
            title = Some(capped);
        }
    }
    cache_put(&TITLE_CACHE, log_file, size, mtime, title.clone());
    title
}

/// Spinner/status line from the rendered screen (ts/statusText.ts
/// parseStatusText): scan the last rendered lines bottom-up for a line that
/// starts with a spinner glyph, skipping keyboard-hint lines.
fn parse_status_text(lines: &[String]) -> Option<String> {
    const SPINNERS: &str = "✶✻✢✳✽✦✧✩✷✸✹✺✼·•●◐◓◒◑";
    const KEY_HINTS: [&str; 6] = ["esc", "ctrl", "enter", "return", "shift", "tab"];
    for raw in lines.iter().rev() {
        let line = strip_control(raw);
        let line = line.trim();
        if line.len() < 3 {
            continue;
        }
        let mut chars = line.chars();
        let first = chars.next()?;
        let is_spinner = ('\u{2800}'..='\u{28ff}').contains(&first) || SPINNERS.contains(first);
        if !is_spinner || !chars.next().map(|c| c.is_whitespace()).unwrap_or(false) {
            continue;
        }
        // /^(?:[•·]\s*)?(?:esc|ctrl|enter|return|shift|tab)\b/i
        let mut probe = line;
        if let Some(stripped) = probe.strip_prefix(['•', '·']) {
            probe = stripped.trim_start();
        }
        let lower = probe.to_lowercase();
        let is_hint = KEY_HINTS.iter().any(|k| {
            lower.strip_prefix(k).map_or(false, |rest| {
                rest.chars().next().map_or(true, |c| !c.is_alphanumeric())
            })
        });
        if is_hint {
            continue;
        }
        let capped: String = line.chars().take(220).collect();
        return Some(capped.trim().to_string());
    }
    None
}

/// Rendered-screen status text (ts/serve.ts logStatusText): replay the last
/// 32KB of raw PTY bytes through a terminal emulator at the TS fallback
/// geometry (200x50) and parse the spinner line from the last 40 rows.
/// Cached per (size, mtime) so the 1s subscribe tick stays cheap.
fn log_status_text(log_file: Option<&str>) -> Option<String> {
    let log_file = log_file?;
    let (size, mtime, buf) = read_file_tail(log_file, 32_768).ok()?;
    if let Some(hit) = cache_get(&STATUS_CACHE, log_file, size, mtime) {
        return hit;
    }
    let mut vt = crate::vterm::VTermProxy::new(50, 200);
    vt.process(&buf);
    let rendered = if vt.alternate_screen() {
        vt.contents()
    } else {
        vt.dump_scrollback()
    };
    let lines: Vec<String> = rendered.lines().map(|l| l.trim_end().to_string()).collect();
    let tail_start = lines.len().saturating_sub(40);
    let status = parse_status_text(&lines[tail_start..]);
    cache_put(&STATUS_CACHE, log_file, size, mtime, status.clone());
    status
}

/// Render the last `n` rows of a raw PTY log tail (ts/subcommands.ts
/// renderLogTailLines). `max` bounds the byte window: 32KB for screen-state
/// questions, more for the todo block, which later output often pushes up.
fn render_tail_lines(log_file: &str, max: u64, n: usize) -> Option<(u64, i64, Vec<String>)> {
    let (size, mtime, buf) = read_file_tail(log_file, max).ok()?;
    if size == 0 {
        return None;
    }
    let mut vt = crate::vterm::VTermProxy::new(50, 200);
    vt.process(&buf);
    let rendered = if vt.alternate_screen() {
        vt.contents()
    } else {
        vt.dump_scrollback()
    };
    let mut lines: Vec<String> = rendered.lines().map(|l| l.trim_end().to_string()).collect();
    if n > 0 && lines.len() > n {
        lines.drain(..lines.len() - n);
    }
    Some((size, mtime, lines))
}

/// (size, mtime)-keyed cache for the JSON-valued derived fields, same
/// invalidation rule as TITLE_CACHE: recompute only when the log grew, so the
/// 1s subscribe tick over a big fleet doesn't re-render every screen.
type JsonCache = std::sync::Mutex<std::collections::HashMap<String, (u64, i64, Value)>>;
static TASKS_CACHE: once_cell::sync::Lazy<JsonCache> = once_cell::sync::Lazy::new(Default::default);
static BADGE_CACHE: once_cell::sync::Lazy<JsonCache> = once_cell::sync::Lazy::new(Default::default);
static NI_CACHE: once_cell::sync::Lazy<JsonCache> = once_cell::sync::Lazy::new(Default::default);

fn json_cached(
    cache: &JsonCache,
    key: &str,
    size: u64,
    mtime: i64,
    compute: impl FnOnce() -> Value,
) -> Value {
    if let Ok(map) = cache.lock() {
        if let Some((s, m, v)) = map.get(key) {
            if *s == size && *m == mtime {
                return v.clone();
            }
        }
    }
    let v = compute();
    if let Ok(mut map) = cache.lock() {
        map.insert(key.to_string(), (size, mtime, v.clone()));
    }
    v
}

fn json_cache_get(cache: &JsonCache, key: &str, size: u64, mtime: i64) -> Option<Value> {
    let map = cache.lock().ok()?;
    match map.get(key) {
        Some((s, m, v)) if *s == size && *m == mtime => Some(v.clone()),
        _ => None,
    }
}

/// Task progress from the rendered todo block. Reads a 256KB window (vs 32KB
/// elsewhere) and keeps the WHOLE render — the latest block is often scrolled
/// well back from the final rows.
fn log_tasks(log_file: Option<&str>) -> Value {
    let Some(log_file) = log_file else {
        return Value::Null;
    };
    let Some((size, mtime)) = file_version(log_file) else {
        return Value::Null;
    };
    if let Some(v) = json_cache_get(&TASKS_CACHE, log_file, size, mtime) {
        return v;
    }
    let Some((size, mtime, lines)) = render_tail_lines(log_file, 256 * 1024, 0) else {
        return Value::Null;
    };
    json_cached(&TASKS_CACHE, log_file, size, mtime, || {
        crate::serve::meta::parse_task_counts(&lines)
            .map(|t| json!({ "done": t.done, "total": t.total }))
            .unwrap_or(Value::Null)
    })
}

fn log_badges(log_file: Option<&str>) -> Vec<String> {
    let Some(log_file) = log_file else {
        return vec![];
    };
    let Some((size, mtime)) = file_version(log_file) else {
        return vec![];
    };
    if let Some(v) = json_cache_get(&BADGE_CACHE, log_file, size, mtime) {
        return serde_json::from_value(v).unwrap_or_default();
    }
    let Some((size, mtime, lines)) = render_tail_lines(log_file, 32_768, 40) else {
        return vec![];
    };
    let v = json_cached(&BADGE_CACHE, log_file, size, mtime, || {
        json!(crate::serve::meta::match_badges(&lines))
    });
    serde_json::from_value(v).unwrap_or_default()
}

/// The CLI's needsInput/working patterns, compiled once per CLI name. Falls
/// back to "no patterns" (→ never needs_input) for CLIs config doesn't know.
fn cli_patterns(cli: &str) -> std::sync::Arc<(Vec<regex::Regex>, Vec<regex::Regex>)> {
    type Cell = std::sync::Mutex<
        std::collections::HashMap<String, std::sync::Arc<(Vec<regex::Regex>, Vec<regex::Regex>)>>,
    >;
    static CACHE: once_cell::sync::Lazy<Cell> = once_cell::sync::Lazy::new(Default::default);
    if let Ok(map) = CACHE.lock() {
        if let Some(v) = map.get(cli) {
            return v.clone();
        }
    }
    let v = std::sync::Arc::new(crate::serve::meta::cli_patterns(cli).unwrap_or_default());
    if let Ok(mut map) = CACHE.lock() {
        map.insert(cli.to_string(), v.clone());
    }
    v
}

fn log_needs_input(log_file: Option<&str>, cli: &str) -> Value {
    let Some(log_file) = log_file else {
        return Value::Null;
    };
    let pats = cli_patterns(cli);
    if pats.0.is_empty() {
        return Value::Null;
    }
    let Some((size, mtime)) = file_version(log_file) else {
        return Value::Null;
    };
    if let Some(v) = json_cache_get(&NI_CACHE, log_file, size, mtime) {
        return v;
    }
    let Some((size, mtime, lines)) = render_tail_lines(log_file, 32_768, 40) else {
        return Value::Null;
    };
    json_cached(&NI_CACHE, log_file, size, mtime, || {
        crate::serve::meta::classify_needs_input(&lines, &pats.0, &pats.1)
            .map(Value::String)
            .unwrap_or(Value::Null)
    })
}

/// Git snapshot for the list — served ONLY from cache. A miss returns the stale
/// value (null the first time) and schedules a background refresh.
///
/// Forking `git status` on the request path is what the TS daemon calls out as
/// the old design that "pinned host load": one fork per agent per poll tick. It
/// really does — a first uncached /api/ls over ~40 agents in submodule-heavy
/// superprojects took **1m48s** before this. The console reads a slightly stale
/// branch/dirty count instead, which is what the TS watcher-invalidated cache
/// effectively gives it too.
/// Repo root for a cwd, cached forever (a checkout doesn't move). Keying the
/// status cache by ROOT — as the TS daemon does — collapses the N agents that
/// share a worktree into ONE `git status` instead of N racing forks.
fn git_root(cwd: &str) -> Option<String> {
    type Cell = std::sync::Mutex<std::collections::HashMap<String, Option<String>>>;
    static ROOTS: once_cell::sync::Lazy<Cell> = once_cell::sync::Lazy::new(Default::default);
    if let Ok(map) = ROOTS.lock() {
        if let Some(v) = map.get(cwd) {
            return v.clone();
        }
    }
    let root = std::process::Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(cwd)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty());
    if let Ok(mut map) = ROOTS.lock() {
        map.insert(cwd.to_string(), root.clone());
    }
    root
}

fn git_status(cwd: Option<&str>) -> Value {
    let Some(cwd) = cwd else { return Value::Null };
    let Some(cwd) = git_root(cwd) else {
        return Value::Null;
    }; // not a repo
    let cwd = cwd.as_str();
    const GIT_TTL_MS: i64 = 10_000;
    type Cell = std::sync::Mutex<std::collections::HashMap<String, (i64, Value)>>;
    static CACHE: once_cell::sync::Lazy<Cell> = once_cell::sync::Lazy::new(Default::default);
    // Repo roots already being refreshed, so N agents sharing a root fork once.
    type Flight = std::sync::Mutex<std::collections::HashSet<String>>;
    static INFLIGHT: once_cell::sync::Lazy<Flight> = once_cell::sync::Lazy::new(Default::default);

    let now = now_ms();
    let mut stale = Value::Null;
    let mut fresh = false;
    if let Ok(map) = CACHE.lock() {
        if let Some((ts, v)) = map.get(cwd) {
            stale = v.clone();
            fresh = now - *ts < GIT_TTL_MS;
        }
    }
    if fresh {
        return stale;
    }
    let claimed = INFLIGHT
        .lock()
        .map(|mut s| s.insert(cwd.to_string()))
        .unwrap_or(false);
    if claimed {
        let cwd = cwd.to_string();
        std::thread::spawn(move || {
            let out = std::process::Command::new("git")
                .args(["status", "--porcelain=v2", "--branch"])
                .current_dir(&cwd)
                .output();
            let v = match out {
                Ok(o) if o.status.success() => serde_json::to_value(
                    crate::serve::meta::parse_porcelain_v2(&String::from_utf8_lossy(&o.stdout)),
                )
                .unwrap_or(Value::Null),
                // Not a repo / git missing: null, same as the TS daemon.
                _ => Value::Null,
            };
            if let Ok(mut map) = CACHE.lock() {
                map.insert(cwd.clone(), (now_ms(), v));
            }
            if let Ok(mut s) = INFLIGHT.lock() {
                s.remove(&cwd);
            }
        });
    }
    stale
}

/// One /api/ls entry: the raw record plus the derived fields the console reads.
fn with_meta(r: &PidRecord) -> Value {
    let alive = is_process_alive(r.pid);
    let exited = r.status == "exited" || !alive;
    let last_active = r.log_file.as_deref().and_then(file_mtime_ms);
    // "Waiting on you": alive, and parked on a menu it didn't auto-resolve.
    // Skipped when unresponsive — the Rust wedge signal (`stuck`) wins, which
    // is the same precedence deriveLiveState uses in `ay ls`.
    let question = if exited || r.unresponsive {
        Value::Null
    } else {
        log_needs_input(r.log_file.as_deref(), &r.cli)
    };
    let status = if exited {
        "exited"
    } else if r.unresponsive {
        "stuck"
    } else if !question.is_null() {
        "needs_input"
    } else if last_active
        .map(|t| now_ms() - t < ACTIVE_WINDOW_MS)
        .unwrap_or(false)
    {
        "active"
    } else {
        "idle"
    };
    let mut v = serde_json::to_value(r).unwrap_or_else(|_| json!({}));
    let o = v.as_object_mut().unwrap();
    o.insert("status".into(), json!(status));
    // Same sources as the TS daemon: OSC title + rendered-screen spinner line.
    o.insert("title".into(), json!(log_title(r.log_file.as_deref())));
    o.insert(
        "status_text".into(),
        if exited {
            Value::Null
        } else {
            json!(log_status_text(r.log_file.as_deref()))
        },
    );
    o.insert("question".into(), question);
    // Exited agents get null/[]: their screen and repo state are no longer live.
    o.insert(
        "git".into(),
        if exited {
            Value::Null
        } else {
            git_status(Some(&r.cwd))
        },
    );
    o.insert(
        "tasks".into(),
        if exited {
            Value::Null
        } else {
            log_tasks(r.log_file.as_deref())
        },
    );
    o.insert(
        "badges".into(),
        if exited {
            json!([])
        } else {
            let mut b = log_badges(r.log_file.as_deref());
            // Time-derived, not screen-matched — same chip `ay ls` shows.
            if is_user_typing(r.pid) {
                b.push(crate::serve::meta::TYPING_BADGE.to_string());
            }
            json!(b)
        },
    );
    // TS falls back to started_at when there's no log yet (freshly spawned).
    o.insert(
        "last_active_at".into(),
        json!(last_active.unwrap_or(r.started_at)),
    );
    o.insert("last_stdin_at".into(), json!(last_stdin_at(r.pid)));
    v
}

fn matches_keyword(r: &PidRecord, kw: &str) -> bool {
    if kw.is_empty() {
        return true;
    }
    // A purely-numeric keyword is an IDENTITY selector — exact pid, or an
    // agent_id prefix (ids are 12 random hex, so they can be all-digits). Never
    // fall through to the cwd/cli/prompt substring rules: a pid frequently
    // appears inside OTHER agents' prompts (a resume prompt listing peer pids,
    // a shared `/w/#room:<pid>` URL), and a newer such record would win the
    // newest-first tiebreak in resolve_one — sending the console's tail/stdin
    // for `#room:<pid>` to a sibling's terminal. Mirrors ts/subcommands.ts
    // matchKeyword (fix #72), which never reached this Rust port.
    if kw.chars().all(|c| c.is_ascii_digit()) {
        if r.pid.to_string() == kw {
            return true;
        }
        return r
            .agent_id
            .as_deref()
            .map(|id| id.starts_with(&kw.to_ascii_lowercase()))
            .unwrap_or(false);
    }
    if let Some(id) = &r.agent_id {
        if id.starts_with(&kw.to_ascii_lowercase()) {
            return true;
        }
    }
    let kwl = kw.to_lowercase();
    r.cwd.to_lowercase().contains(&kwl)
        || r.cli.to_lowercase().contains(&kwl)
        || r.prompt
            .as_deref()
            .map(|p| p.to_lowercase().contains(&kwl))
            .unwrap_or(false)
}

fn resolve_one(kw: &str) -> Result<PidRecord, String> {
    let mut recs: Vec<PidRecord> = read_records()
        .into_iter()
        .filter(|r| matches_keyword(r, kw))
        .collect();
    recs.sort_by_key(|r| -r.started_at);
    // Exact identity beats everything: when the keyword IS a record's pid, that
    // record wins even if an all-digit agent_id prefix also matched (parity with
    // ts/subcommands.ts resolveOne).
    if kw.chars().all(|c| c.is_ascii_digit()) {
        let by_pid: Vec<&PidRecord> = recs.iter().filter(|r| r.pid.to_string() == kw).collect();
        if by_pid.len() == 1 {
            return Ok(by_pid[0].clone());
        }
    }
    // prefer a living agent over exited ones
    if let Some(r) = recs
        .iter()
        .find(|r| r.status != "exited" && is_process_alive(r.pid))
    {
        return Ok(r.clone());
    }
    recs.into_iter()
        .next()
        .ok_or_else(|| format!("no agent matches {kw:?}"))
}

/// GET /api/search — content search over every agent's RENDERED screen text.
///
/// Scans newest-activity-first (the log mtime is the activity clock) and stops
/// at SEARCH_MAX_HITS or when the time budget runs out, reporting `partial` so
/// the console can say "showing the first N". Renders are cached by
/// (size, mtime) like the other screen-derived fields.
fn search_json(needle: &str, budget_ms: u64) -> Value {
    const SEARCH_TAIL_BYTES: u64 = 256 * 1024;
    const SEARCH_MAX_HITS: usize = 20;
    if needle.chars().count() < 2 {
        return json!({ "hits": [], "scanned": 0, "total": 0, "partial": false });
    }
    let ql = needle.to_lowercase();
    let t0 = std::time::Instant::now();

    // newest activity first
    let mut live: Vec<(PidRecord, i64)> = read_records()
        .into_iter()
        .filter_map(|r| {
            let m = r.log_file.as_deref().and_then(file_mtime_ms)?;
            Some((r, m))
        })
        .collect();
    live.sort_by_key(|(_, m)| -*m);
    let total = live.len();

    let mut hits: Vec<Value> = Vec::new();
    let mut scanned = 0usize;
    let mut partial = false;
    for (r, _) in live {
        if hits.len() >= SEARCH_MAX_HITS {
            break;
        }
        if t0.elapsed().as_millis() as u64 > budget_ms {
            partial = true;
            break;
        }
        let Some(log) = r.log_file.as_deref() else {
            continue;
        };
        let Some((_, _, lines)) = render_tail_lines(log, SEARCH_TAIL_BYTES, 0) else {
            continue;
        };
        scanned += 1;
        if let Some(h) =
            crate::serve::discover::search_hit(r.pid, &r.cli, &r.cwd, &lines.join("\n"), &ql)
        {
            hits.push(h);
        }
    }
    json!({ "hits": hits, "scanned": scanned, "total": total, "partial": partial })
}

/// resolve_one over ALL records (including exited) — what the lifecycle routes
/// need, since killing/restarting an already-dead agent must still resolve it.
pub fn resolve_one_all(kw: &str) -> Result<PidRecord, String> {
    resolve_one(kw)
}

/// Mark an agent exited in the shared pids.jsonl, so both daemons and `ay ls`
/// agree immediately instead of waiting for liveness to be re-derived.
pub fn mark_exited(pid: u32, reason: &str) {
    let path = global_dir().join("pids.jsonl");
    let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    else {
        return;
    };
    // Append-only: readers merge by pid with last-line-wins, so a partial record
    // would drop fields. Re-emit the whole record with the status patched.
    let Some(mut rec) = read_records().into_iter().find(|r| r.pid == pid) else {
        return;
    };
    rec.status = "exited".to_string();
    rec.exit_reason = Some(reason.to_string());
    if let Ok(line) = serde_json::to_string(&rec) {
        let _ = writeln!(f, "{line}");
    }
}

fn ls_json(all: bool, active: bool, keyword: &str) -> Vec<Value> {
    let mut recs = read_records();
    recs.sort_by_key(|r| -r.started_at);
    recs.iter()
        .filter(|r| all || r.status != "exited")
        .filter(|r| !active || is_process_alive(r.pid))
        .filter(|r| matches_keyword(r, keyword))
        .map(with_meta)
        .collect()
}

// ---- SSE helpers ------------------------------------------------------------

fn sse_frame(payload: &Value) -> Vec<u8> {
    format!("data: {}\n\n", payload).into_bytes()
}

fn spawn_ls_subscribe(all: bool, active: bool, keyword: String) -> mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel::<Vec<u8>>(64);
    tokio::spawn(async move {
        let mut known: std::collections::HashMap<i64, String> = std::collections::HashMap::new();
        let mut first = true;
        let mut last_ping = std::time::Instant::now();
        loop {
            let kw = keyword.clone();
            let entries = tokio::task::spawn_blocking(move || ls_json(all, active, &kw))
                .await
                .unwrap_or_default();
            let mut upsert: Vec<Value> = Vec::new();
            let mut seen: std::collections::HashSet<i64> = std::collections::HashSet::new();
            for e in &entries {
                let pid = e.get("pid").and_then(|p| p.as_i64()).unwrap_or(0);
                seen.insert(pid);
                let ser = e.to_string();
                if known.get(&pid) != Some(&ser) {
                    known.insert(pid, ser);
                    upsert.push(e.clone());
                }
            }
            let removed: Vec<i64> = known
                .keys()
                .copied()
                .filter(|p| !seen.contains(p))
                .collect();
            for p in &removed {
                known.remove(p);
            }
            let frame = if first {
                first = false;
                Some(sse_frame(
                    &json!({"full": true, "upsert": entries, "remove": []}),
                ))
            } else if !upsert.is_empty() || !removed.is_empty() {
                Some(sse_frame(&json!({"upsert": upsert, "remove": removed})))
            } else if last_ping.elapsed() >= Duration::from_millis(SSE_PING_MS) {
                Some(b": ping\n\n".to_vec())
            } else {
                None
            };
            if let Some(f) = frame {
                if f.starts_with(b": ping") {
                    last_ping = std::time::Instant::now();
                }
                if tx.send(f).await.is_err() {
                    return; // client went away
                }
            }
            tokio::time::sleep(Duration::from_millis(LS_TICK_MS)).await;
        }
    });
    rx
}

fn spawn_tail(log_file: String, raw: bool) -> mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel::<Vec<u8>>(64);
    tokio::spawn(async move {
        let mut offset: u64 = 0;
        // snapshot: last 64KB of the file
        let snapshot = tokio::task::spawn_blocking({
            let log_file = log_file.clone();
            move || -> std::io::Result<(u64, Vec<u8>)> {
                let mut f = std::fs::File::open(&log_file)?;
                let size = f.metadata()?.len();
                let start = size.saturating_sub(TAIL_SNAPSHOT_BYTES);
                f.seek(SeekFrom::Start(start))?;
                let mut buf = Vec::new();
                f.read_to_end(&mut buf)?;
                Ok((size, buf))
            }
        })
        .await
        .unwrap_or_else(|e| Err(std::io::Error::other(e)));
        match snapshot {
            Ok((size, buf)) => {
                offset = size;
                let text = decode_log(&buf, raw);
                if tx.send(sse_frame(&json!(text))).await.is_err() {
                    return;
                }
            }
            Err(_) => {
                // no log yet — start at 0 and stream once it appears
            }
        }
        let mut last_ping = std::time::Instant::now();
        loop {
            tokio::time::sleep(Duration::from_millis(TAIL_POLL_MS)).await;
            let read = tokio::task::spawn_blocking({
                let log_file = log_file.clone();
                move || -> std::io::Result<(u64, Vec<u8>)> {
                    let mut f = std::fs::File::open(&log_file)?;
                    let size = f.metadata()?.len();
                    if size < offset {
                        return Ok((size, Vec::new())); // truncated/compacted
                    }
                    if size == offset {
                        return Ok((size, Vec::new()));
                    }
                    f.seek(SeekFrom::Start(offset))?;
                    let mut buf = Vec::new();
                    f.read_to_end(&mut buf)?;
                    Ok((size, buf))
                }
            })
            .await
            .unwrap_or_else(|e| Err(std::io::Error::other(e)));
            match read {
                Ok((size, buf)) => {
                    offset = size;
                    if !buf.is_empty() {
                        let text = decode_log(&buf, raw);
                        let skip = !raw && text.trim().is_empty();
                        if !skip && tx.send(sse_frame(&json!(text))).await.is_err() {
                            return;
                        }
                    }
                }
                Err(_) => { /* file missing — keep polling */ }
            }
            if last_ping.elapsed() >= Duration::from_millis(SSE_PING_MS) {
                last_ping = std::time::Instant::now();
                if tx.send(b": ping\n\n".to_vec()).await.is_err() {
                    return;
                }
            }
        }
    });
    rx
}

fn decode_log(buf: &[u8], raw: bool) -> String {
    if raw {
        String::from_utf8_lossy(buf).into_owned()
    } else {
        let stripped = strip_ansi_escapes::strip(buf);
        String::from_utf8_lossy(&stripped).into_owned()
    }
}

// ---- /api/send --------------------------------------------------------------

fn control_code(name: &str) -> &'static str {
    match name {
        "enter" | "cr" | "return" => "\r",
        "esc" | "escape" => "\x1b",
        "ctrl-c" | "ctrl+c" => "\x03",
        "ctrl-y" | "ctrl+y" => "\x19",
        "ctrl-d" | "ctrl+d" => "\x04",
        "ctrl-\\" | "ctrl+\\" => "\x1c",
        "tab" => "\t",
        "up" => "\x1b[A",
        "down" => "\x1b[B",
        "right" => "\x1b[C",
        "left" => "\x1b[D",
        _ => "",
    }
}

fn write_fifo(path: &str, data: &[u8]) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(path)?;
        f.write_all(data)?;
        return Ok(());
    }
    #[cfg(not(unix))]
    {
        let mut f = std::fs::OpenOptions::new().write(true).open(path)?;
        f.write_all(data)?;
        Ok(())
    }
}

async fn handle_send(body: &str) -> ApiResponse {
    let Ok(req) = serde_json::from_str::<Value>(body) else {
        return text(400, "invalid JSON body");
    };
    let kw = req.get("keyword").and_then(|v| v.as_str()).unwrap_or("");
    if kw.is_empty() {
        return text(400, "missing keyword");
    }
    let msg = req
        .get("msg")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let code = req
        .get("code")
        .and_then(|v| v.as_str())
        .unwrap_or("enter")
        .to_lowercase();
    let rec = match resolve_one(kw) {
        Ok(r) => r,
        Err(e) => return text(404, e),
    };
    let Some(fifo) = rec.fifo_file.clone() else {
        return text(409, format!("pid {}: no fifo_file", rec.pid));
    };
    let trailing = control_code(&code);
    let write = |data: Vec<u8>| {
        let fifo = fifo.clone();
        tokio::task::spawn_blocking(move || write_fifo(&fifo, &data))
    };
    let result = if !msg.is_empty() && !trailing.is_empty() {
        // typed text first, control code 200 ms later (mirrors the TS daemon)
        match write(msg.clone().into_bytes())
            .await
            .unwrap_or_else(|e| Err(std::io::Error::other(e)))
        {
            Ok(()) => {
                tokio::time::sleep(Duration::from_millis(200)).await;
                write(trailing.as_bytes().to_vec())
                    .await
                    .unwrap_or_else(|e| Err(std::io::Error::other(e)))
            }
            Err(e) => Err(e),
        }
    } else {
        write(format!("{msg}{trailing}").into_bytes())
            .await
            .unwrap_or_else(|e| Err(std::io::Error::other(e)))
    };
    match result {
        Ok(()) => {
            crate::fifo::touch_stdin_activity(rec.pid);
            json_res(
                200,
                &json!({
                    "ok": true,
                    "pid": rec.pid,
                    "cli": rec.cli,
                    "cwd": rec.cwd,
                    "agentId": rec.agent_id,
                }),
            )
        }
        Err(e) => text(409, format!("pid {}: fifo write failed: {e}", rec.pid)),
    }
}

// ---- misc endpoints ----------------------------------------------------------

fn hostname() -> String {
    #[cfg(unix)]
    {
        let mut buf = [0u8; 256];
        unsafe {
            if libc::gethostname(buf.as_mut_ptr() as *mut libc::c_char, buf.len()) == 0 {
                if let Some(end) = buf.iter().position(|&b| b == 0) {
                    if let Ok(s) = std::str::from_utf8(&buf[..end]) {
                        // Keep the FULL hostname (e.g. "tak.local") — the TS
                        // daemon reports os.hostname() verbatim, and the console
                        // dedupes agents by host label; a stripped domain would
                        // make the same machine look like two hosts.
                        return s.to_string();
                    }
                }
            }
        }
    }
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "unknown".into())
}

fn whoami_host() -> String {
    let user = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .ok();
    match user {
        Some(u) if !u.is_empty() => format!("{u}@{}", hostname()),
        _ => hostname(),
    }
}

fn host_info() -> Value {
    let cpus = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(0);
    let mut loadavg = [0f64; 3];
    #[cfg(unix)]
    unsafe {
        libc::getloadavg(loadavg.as_mut_ptr(), 3);
    }
    json!({
        "host": hostname(),
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "cpus": cpus,
        "loadavg": loadavg,
        "mem": { "total": 0, "free": 0 },
        "uptime": 0,
        "caps": { "send": true, "kill": false, "spawn": false, "spawnHook": false, "provision": false },
    })
}

// ---- router -------------------------------------------------------------------

fn parse_query(query: &str) -> std::collections::HashMap<String, String> {
    query
        .split('&')
        .filter_map(|kv| {
            let mut it = kv.splitn(2, '=');
            Some((it.next()?.to_string(), it.next().unwrap_or("").to_string()))
        })
        .collect()
}

pub(crate) fn url_decode(s: &str) -> String {
    let mut out = Vec::with_capacity(s.len());
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' if i + 2 < b.len() => {
                if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                    out.push(v);
                    i += 3;
                } else {
                    out.push(b'%');
                    i += 1;
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Handle one API request. `path_with_query` like "/api/ls?all=1".
/// Auth is the caller's job (the WebRTC bridge injects the master token).
/// Append one perf beacon row, then cap the file by keeping the newest half
/// once it passes 4MB. Best-effort throughout: a failed beacon write must never
/// surface as an error to the viewer.
fn perf_beacon(b: &Value) {
    let clip = |k: &str, n: usize| {
        b.get(k)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .chars()
            .take(n)
            .collect::<String>()
    };
    let line = json!({
        "t": now_ms(),
        "room": clip("room", 64),
        "viewer": clip("viewer", 64),
        "build": clip("build", 16),
        "ua": clip("ua", 120),
        "summary": b.get("summary").cloned().unwrap_or(Value::Null),
    });
    let home = global_dir();
    let file = home.join("perf-beacons.jsonl");
    std::fs::create_dir_all(&home).ok();
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file)
    {
        writeln!(f, "{line}").ok();
    }
    if std::fs::metadata(&file)
        .map(|m| m.len() > 4 * 1024 * 1024)
        .unwrap_or(false)
    {
        if let Ok(bytes) = std::fs::read(&file) {
            // Cut at the midpoint, then resume at the next line start — that
            // also lands us back on a UTF-8 boundary.
            let mid = bytes.len() / 2;
            let start = bytes[mid..]
                .iter()
                .position(|b| *b == b'\n')
                .map(|i| mid + i + 1);
            std::fs::write(&file, &bytes[start.unwrap_or(bytes.len())..]).ok();
        }
    }
}

pub async fn handle(method: &str, path_with_query: &str, body: &str) -> ApiResponse {
    let (path, query) = match path_with_query.split_once('?') {
        Some((p, q)) => (p, q),
        None => (path_with_query, ""),
    };
    let q = parse_query(query);
    let all = q.get("all").map(|v| v == "1").unwrap_or(false);
    let active = q.get("active").map(|v| v == "1").unwrap_or(false);
    let keyword = q.get("keyword").cloned().unwrap_or_default();

    match (method, path) {
        ("GET", "/api/ls") => {
            let entries = tokio::task::spawn_blocking(move || ls_json(all, active, &keyword))
                .await
                .unwrap_or_default();
            json_res(200, &Value::Array(entries))
        }
        ("GET", "/api/ls/subscribe") => ApiResponse {
            status: 200,
            content_type: "text/event-stream".into(),
            body: Body::Stream(spawn_ls_subscribe(all, active, keyword.clone())),
        },
        ("GET", "/api/whoami") => json_res(200, &json!({ "host": whoami_host() })),
        ("GET", "/api/version") => json_res(200, &json!({ "version": env!("CARGO_PKG_VERSION") })),
        ("GET", "/api/host") => json_res(200, &host_info()),
        ("GET", p) if p.starts_with("/api/size/") => {
            let kw = url_decode(&p["/api/size/".len()..]);
            match resolve_one(&kw) {
                Ok(r) => {
                    let size = crate::serve::nego::read_ptysize(r.pid);
                    json_res(
                        200,
                        &json!({
                            "pid": r.pid,
                            "cols": size.map(|s| s.0),
                            "rows": size.map(|s| s.1),
                            "cwd": r.cwd, "cli": r.cli, "nego": true,
                        }),
                    )
                }
                Err(e) => text(404, e),
            }
        }
        ("GET", "/api/presence") => json_res(200, &crate::serve::nego::presence_get().await),
        ("POST", "/api/presence") => {
            let Ok(v) = serde_json::from_str::<Value>(body) else {
                return text(400, "invalid JSON body");
            };
            match crate::serve::nego::presence_post(&v).await {
                Ok(()) => text(204, ""),
                Err((status, msg)) => text(status, msg),
            }
        }
        ("POST", p) if p.starts_with("/api/resize/") => {
            let kw = url_decode(&p["/api/resize/".len()..]);
            let Ok(v) = serde_json::from_str::<Value>(body) else {
                return text(400, "invalid JSON body");
            };
            match resolve_one(&kw) {
                Ok(r) => match crate::serve::nego::resize_post(r.pid, &v).await {
                    Ok(res) => json_res(200, &res),
                    Err((status, msg)) => text(status, msg),
                },
                Err(e) => text(404, e),
            }
        }
        ("GET", p) if p.starts_with("/api/tail/") => {
            let kw = url_decode(&p["/api/tail/".len()..]);
            let raw = q.get("raw").map(|v| v == "1").unwrap_or(false);
            match resolve_one(&kw) {
                Ok(r) => match r.log_file {
                    Some(log) => ApiResponse {
                        status: 200,
                        content_type: "text/event-stream".into(),
                        body: Body::Stream(spawn_tail(log, raw)),
                    },
                    None => text(404, format!("pid {}: no log_file", r.pid)),
                },
                Err(e) => text(404, e),
            }
        }
        ("POST", "/api/send") => handle_send(body).await,
        ("GET", "/api/spawn-config") => crate::serve::control::spawn_config(),
        ("GET", "/api/notes") => json_res(200, &crate::serve::discover::notes(&global_dir())),
        ("GET", "/api/graph") => {
            let records: Vec<PidRecord> = read_records()
                .into_iter()
                .filter(|r| r.status != "exited")
                .collect();
            let sizes = records
                .iter()
                .filter_map(|r| {
                    crate::serve::nego::read_ptysize(r.pid)
                        .map(|(c, rows)| (r.pid, (c as u16, rows as u16)))
                })
                .collect();
            json_res(
                200,
                &crate::serve::graph::build(crate::serve::graph::GraphInput {
                    records: &records,
                    hostname: hostname(),
                    reads: crate::serve::discover::read_edges(&global_dir()),
                    sizes,
                }),
            )
        }
        // /api/ws + /api/ws/status walk the workspace root through the JS
        // codehost/provision package; the TS daemon itself 501s without it.
        ("GET", "/api/ws") | ("GET", "/api/ws/status") => text(
            501,
            "workspace routes need the JS codehost/provision package — use `ay serve`",
        ),
        ("GET", "/api/edges") => {
            let cwds: Vec<String> = read_records().into_iter().map(|r| r.cwd).collect();
            json_res(
                200,
                &json!({
                    "reads": crate::serve::discover::read_edges(&global_dir()),
                    "sends": crate::serve::discover::message_edges(&cwds),
                }),
            )
        }
        ("GET", "/api/search") => {
            let needle = q.get("q").cloned().unwrap_or_default().trim().to_string();
            let budget = q
                .get("budget_ms")
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(900)
                .min(3_000);
            tokio::task::spawn_blocking(move || search_json(&needle, budget))
                .await
                .map(|v| json_res(200, &v))
                .unwrap_or_else(|e| text(500, e.to_string()))
        }
        ("POST", "/api/kill") => crate::serve::control::kill(body),
        ("POST", "/api/restart") => crate::serve::control::restart(body),
        ("POST", "/api/spawn") => crate::serve::control::spawn(body),

        // ── Widget sensor broker ────────────────────────────────────────────
        // The Rust daemon issues master tokens only (no scoped-token minting),
        // so the subject/caps binding is always unrestricted here; the broker
        // still enforces it so a scoped path can be wired in later unchanged.
        ("POST", "/api/widget/register") => match serde_json::from_str::<Value>(body) {
            Ok(v) => json_res(200, &crate::serve::widget::register(&v, None)),
            Err(_) => text(400, "invalid JSON body"),
        },
        ("GET", "/api/widget/list") => json_res(200, &crate::serve::widget::list()),
        ("GET", p) if p.starts_with("/api/widget/poll/") => {
            let vid = url_decode(&p["/api/widget/poll/".len()..]);
            ApiResponse {
                status: 200,
                content_type: "text/event-stream".into(),
                body: Body::Stream(crate::serve::widget::poll(vid)),
            }
        }
        ("POST", "/api/widget/result") => match serde_json::from_str::<Value>(body) {
            Ok(v) => json_res(200, &crate::serve::widget::result(&v)),
            Err(_) => text(400, "invalid JSON body"),
        },
        ("POST", "/api/widget/read") => match serde_json::from_str::<Value>(body) {
            Ok(v) => match crate::serve::widget::read(&v, None, None).await {
                Ok(res) => json_res(200, &res),
                Err((status, msg)) => text(status, msg),
            },
            Err(_) => text(400, "invalid JSON body"),
        },

        // POST /api/perf-beacon — a viewer that MEASURED slowness reports it.
        // Purely local: rows append to <AGENT_YES_HOME>/perf-beacons.jsonl so a
        // headless watcher can see slowness without driving a browser.
        ("POST", "/api/perf-beacon") => match serde_json::from_str::<Value>(body) {
            Ok(v) => {
                perf_beacon(&v);
                text(204, "")
            }
            Err(_) => text(400, "invalid JSON body"),
        },

        // ── Single-agent view-only shares (ts/agentShare.ts port) ───────────
        // Mint / list / revoke scoped share rooms. Reachable by whoever already
        // holds full control of this host — a scoped viewer can't get here (its
        // scope filter default-denies /api/share*).
        ("POST", "/api/share") => {
            let Ok(v) = serde_json::from_str::<Value>(body) else {
                return text(400, "invalid JSON body");
            };
            let Some(agent) = v
                .get("agent")
                .and_then(|a| a.as_str())
                .filter(|a| !a.is_empty())
            else {
                return text(400, "agent required");
            };
            let perm = v.get("perm").and_then(|p| p.as_str()).unwrap_or("r");
            if perm != "r" && perm != "rw" {
                return text(400, format!("invalid perm {perm} (want r or rw)"));
            }
            match crate::serve::agent_share::create(
                agent,
                perm,
                crate::serve::share::DEFAULT_SIGHOST,
            )
            .await
            {
                Ok(share) => json_res(200, &share),
                Err((status, msg)) => text(status, msg),
            }
        }
        ("GET", "/api/shares") => json_res(200, &crate::serve::agent_share::list_json()),
        ("DELETE", p) if p.starts_with("/api/share/") => {
            let id = url_decode(&p["/api/share/".len()..]);
            if crate::serve::agent_share::revoke(&id) {
                text(200, "revoked")
            } else {
                text(404, "no such share")
            }
        }

        // ── Port exposures through the edge relay (ts/expose.ts port) ───────
        ("POST", "/api/expose") => {
            let Ok(v) = serde_json::from_str::<Value>(body) else {
                return text(400, "invalid JSON body");
            };
            let port = v.get("port").and_then(|p| p.as_u64()).unwrap_or(0);
            if port < 1 || port > 65535 {
                return text(400, "valid port required");
            }
            let relay = v.get("relay").and_then(|r| r.as_str());
            match crate::serve::expose::ensure(port as u16, relay).await {
                Ok(out) => json_res(200, &out),
                Err(e) => text(502, format!("expose failed: {e:#}")),
            }
        }
        ("GET", "/api/exposes") => json_res(200, &crate::serve::expose::list().await),
        ("DELETE", p) if p.starts_with("/api/expose/") => {
            match p["/api/expose/".len()..].parse::<u16>() {
                Ok(port) if crate::serve::expose::stop(port).await => text(200, "revoked"),
                _ => text(404, "no such exposure"),
            }
        }

        ("OPTIONS", _) => text(204, ""),
        _ => text(404, "not found"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_status_text_spinner_and_hints() {
        let lines = vec![
            "✶ Verifying calendar meetings… (6m 30s · ↓ 19.5k tokens)".to_string(),
            "· esc to interrupt".to_string(),
        ];
        assert_eq!(
            parse_status_text(&lines).as_deref(),
            Some("✶ Verifying calendar meetings… (6m 30s · ↓ 19.5k tokens)")
        );
        let braille = vec!["⠋ Working on it".to_string()];
        assert_eq!(
            parse_status_text(&braille).as_deref(),
            Some("⠋ Working on it")
        );
        assert_eq!(parse_status_text(&["plain text".to_string()]), None);
    }

    #[test]
    fn numeric_keyword_is_identity_not_substring() {
        // Regression: after a fleet restore, one agent's resume prompt listed a
        // peer's pid. That record was newer, so `/w/#room:<pid>` tail+stdin
        // resolved to the wrong terminal while the pane header showed the
        // requested pid.
        let rec = |j: serde_json::Value| -> PidRecord { serde_json::from_value(j).unwrap() };
        let target = rec(json!({
            "pid": 1111, "cli": "claude", "cwd": "/repo/alpha",
            "prompt": "resume your lane",
            "log_file": null, "status": "active", "exit_code": null,
            "exit_reason": null, "started_at": 1_000, "agent_id": "aaaa0000bbbb"
        }));
        let peer = rec(json!({
            "pid": 2222, "cli": "claude", "cwd": "/repo/beta",
            "prompt": "peers respawned: alpha 1111, gamma 3333",
            "log_file": null, "status": "active", "exit_code": null,
            "exit_reason": null, "started_at": 2_000, "agent_id": "cccc0000dddd"
        }));
        // pid match stays exact; the pid inside another agent's prompt no longer matches
        assert!(matches_keyword(&target, "1111"));
        assert!(!matches_keyword(&peer, "1111"));
        // numeric keyword still reaches an all-digit agent_id prefix
        let digits = rec(json!({
            "pid": 42, "cli": "claude", "cwd": "/x", "prompt": null,
            "log_file": null, "status": "active", "exit_code": null,
            "exit_reason": null, "started_at": 3_000, "agent_id": "111134abcdef"
        }));
        assert!(matches_keyword(&digits, "1111"));
        // non-numeric keywords keep the substring rules
        assert!(matches_keyword(&peer, "repo/beta"));
        assert!(matches_keyword(&peer, "gamma"));
    }

    #[test]
    fn log_title_multibyte_safe() {
        // Regression: a hand-rolled byte-index scan panicked on UTF-8
        // boundaries (Japanese titles), which nuked the whole /api/ls response.
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("t.raw.log");
        std::fs::write(
            &p,
            "前置き日本語\x1b]2;✳ 深夜定義の統一 — テスト\x07後続\x1b]0;\x07",
        )
        .unwrap();
        let t = log_title(Some(p.to_str().unwrap()));
        assert_eq!(t.as_deref(), Some("✳ 深夜定義の統一 — テスト"));
    }
}
