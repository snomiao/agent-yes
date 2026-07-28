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
const LS_TICK_MS: u64 = 1_000;
const TAIL_POLL_MS: u64 = 200;
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
    dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")).join(".agent-yes")
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
    order.into_iter().filter_map(|p| by_pid.remove(&p)).collect()
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

fn last_stdin_at(pid: u32) -> Option<i64> {
    let p = global_dir().join("activity").join(format!("{pid}.stdin"));
    std::fs::read_to_string(p).ok()?.trim().parse().ok()
}

/// One /api/ls entry: the raw record plus the derived fields the console reads.
fn with_meta(r: &PidRecord) -> Value {
    let alive = is_process_alive(r.pid);
    let exited = r.status == "exited" || !alive;
    let last_active = r.log_file.as_deref().and_then(file_mtime_ms);
    let status = if exited {
        "exited"
    } else if r.unresponsive {
        "stuck"
    } else if last_active.map(|t| now_ms() - t < ACTIVE_WINDOW_MS).unwrap_or(false) {
        "active"
    } else {
        "idle"
    };
    let dir_name = r
        .cwd
        .rsplit(['/', '\\'])
        .find(|s| !s.is_empty())
        .unwrap_or(&r.cwd);
    let mut v = serde_json::to_value(r).unwrap_or_else(|_| json!({}));
    let o = v.as_object_mut().unwrap();
    o.insert("status".into(), json!(status));
    o.insert("title".into(), json!(format!("{} — {}", r.cli, dir_name)));
    o.insert("status_text".into(), Value::Null);
    o.insert("question".into(), Value::Null);
    o.insert("git".into(), Value::Null);
    o.insert("tasks".into(), Value::Null);
    o.insert("badges".into(), json!([]));
    o.insert("last_active_at".into(), json!(last_active));
    o.insert("last_stdin_at".into(), json!(last_stdin_at(r.pid)));
    v
}

fn matches_keyword(r: &PidRecord, kw: &str) -> bool {
    if kw.is_empty() {
        return true;
    }
    if r.pid.to_string() == kw {
        return true;
    }
    if let Some(id) = &r.agent_id {
        if id.starts_with(&kw.to_ascii_lowercase()) {
            return true;
        }
    }
    let kwl = kw.to_lowercase();
    r.cwd.to_lowercase().contains(&kwl)
        || r.cli.to_lowercase().contains(&kwl)
        || r.prompt.as_deref().map(|p| p.to_lowercase().contains(&kwl)).unwrap_or(false)
}

fn resolve_one(kw: &str) -> Result<PidRecord, String> {
    let mut recs: Vec<PidRecord> = read_records().into_iter().filter(|r| matches_keyword(r, kw)).collect();
    recs.sort_by_key(|r| -r.started_at);
    // prefer a living agent over exited ones
    if let Some(r) = recs.iter().find(|r| r.status != "exited" && is_process_alive(r.pid)) {
        return Ok(r.clone());
    }
    recs.into_iter().next().ok_or_else(|| format!("no agent matches {kw:?}"))
}

fn ls_json(all: bool, active: bool) -> Vec<Value> {
    let mut recs = read_records();
    recs.sort_by_key(|r| -r.started_at);
    recs.iter()
        .filter(|r| all || r.status != "exited")
        .filter(|r| !active || is_process_alive(r.pid))
        .map(with_meta)
        .collect()
}

// ---- SSE helpers ------------------------------------------------------------

fn sse_frame(payload: &Value) -> Vec<u8> {
    format!("data: {}\n\n", payload).into_bytes()
}

fn spawn_ls_subscribe(all: bool, active: bool) -> mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel::<Vec<u8>>(64);
    tokio::spawn(async move {
        let mut known: std::collections::HashMap<i64, String> = std::collections::HashMap::new();
        let mut first = true;
        let mut last_ping = std::time::Instant::now();
        loop {
            let entries = tokio::task::spawn_blocking(move || ls_json(all, active))
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
            let removed: Vec<i64> = known.keys().copied().filter(|p| !seen.contains(p)).collect();
            for p in &removed {
                known.remove(p);
            }
            let frame = if first {
                first = false;
                Some(sse_frame(&json!({"full": true, "upsert": entries, "remove": []})))
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
    let msg = req.get("msg").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let code = req.get("code").and_then(|v| v.as_str()).unwrap_or("enter").to_lowercase();
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
        match write(msg.clone().into_bytes()).await.unwrap_or_else(|e| Err(std::io::Error::other(e))) {
            Ok(()) => {
                tokio::time::sleep(Duration::from_millis(200)).await;
                write(trailing.as_bytes().to_vec()).await.unwrap_or_else(|e| Err(std::io::Error::other(e)))
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
    let user = std::env::var("USER").or_else(|_| std::env::var("USERNAME")).ok();
    match user {
        Some(u) if !u.is_empty() => format!("{u}@{}", hostname()),
        _ => hostname(),
    }
}

fn host_info() -> Value {
    let cpus = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0);
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

fn url_decode(s: &str) -> String {
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
pub async fn handle(method: &str, path_with_query: &str, body: &str) -> ApiResponse {
    let (path, query) = match path_with_query.split_once('?') {
        Some((p, q)) => (p, q),
        None => (path_with_query, ""),
    };
    let q = parse_query(query);
    let all = q.get("all").map(|v| v == "1").unwrap_or(false);
    let active = q.get("active").map(|v| v == "1").unwrap_or(false);

    match (method, path) {
        ("GET", "/api/ls") => {
            let entries = tokio::task::spawn_blocking(move || ls_json(all, active))
                .await
                .unwrap_or_default();
            json_res(200, &Value::Array(entries))
        }
        ("GET", "/api/ls/subscribe") => ApiResponse {
            status: 200,
            content_type: "text/event-stream".into(),
            body: Body::Stream(spawn_ls_subscribe(all, active)),
        },
        ("GET", "/api/whoami") => json_res(200, &json!({ "host": whoami_host() })),
        ("GET", "/api/version") => {
            json_res(200, &json!({ "version": env!("CARGO_PKG_VERSION") }))
        }
        ("GET", "/api/host") => json_res(200, &host_info()),
        ("GET", p) if p.starts_with("/api/size/") => {
            let kw = url_decode(&p["/api/size/".len()..]);
            match resolve_one(&kw) {
                Ok(r) => json_res(
                    200,
                    &json!({
                        "pid": r.pid, "cols": null, "rows": null,
                        "cwd": r.cwd, "cli": r.cli, "nego": false,
                    }),
                ),
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
        ("OPTIONS", _) => text(204, ""),
        _ => text(404, "not found"),
    }
}
