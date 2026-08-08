// Single-agent, view-only shares — Rust port of ts/agentShare.ts (Option X from
// docs/agent-sharing.md).
//
// A scoped share stands up its OWN e2ee WebRTC room (a fresh, unpersisted room —
// never the persisted master fleet room) that exposes exactly ONE agent,
// read-only by default. The room's bridge routes every request through
// `scoped_handle`, which DEFAULT-DENIES and permits only read paths, each
// verified to resolve to the shared `agent_id` (the stable per-process id, not
// the reusable pid). Read-only is enforced here on the host — the browser hiding
// controls is only UX.
//
// Shares are ephemeral (no disk persistence): a daemon restart drops them, and a
// restarted agent mints a fresh agent_id, so the holder re-shares (a deliberate
// NON-GOAL per the design).
use super::api::{self, ApiResponse, Body};
use super::e2e;
use super::share;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::Mutex;
use tokio::sync::{mpsc, watch};

pub const MAX_SHARES: usize = 8;
pub const DEFAULT_SHARE_TTL_MS: i64 = 24 * 60 * 60 * 1000; // 24h

/// What a bridged room is allowed to reach on the local API.
pub enum Scope {
    /// The master fleet room: the full API surface.
    Full,
    /// A scoped share: one agent, read-only unless `rw`.
    Agent { agent_id: String, rw: bool },
}

struct ShareEntry {
    agent_id: String,
    perm: &'static str, // "r" | "rw"
    room: String,
    link: String,
    label: String,
    created_at: i64,
    expires_at: i64,
    /// Flipping this to true shuts the session down (ws + every peer pc).
    cancel: watch::Sender<bool>,
}

fn registry() -> &'static Mutex<HashMap<String, ShareEntry>> {
    static SHARES: std::sync::OnceLock<Mutex<HashMap<String, ShareEntry>>> =
        std::sync::OnceLock::new();
    SHARES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// ts/agentShare.ts hashStr: Java-style 31-multiplier hash over UTF-16 units,
/// i32 wraparound — kept bit-identical so share ids look the same either daemon.
fn hash_str(s: &str) -> i32 {
    let mut h: i32 = 0;
    for u in s.encode_utf16() {
        h = h.wrapping_mul(31).wrapping_add(u as i32);
    }
    h
}

fn to_base36(mut n: u64) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".into();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

fn entry_json(id: &str, e: &ShareEntry) -> Value {
    json!({
        "shareId": id,
        "agentId": e.agent_id,
        "perm": e.perm,
        "room": e.room,
        "link": e.link,
        "label": e.label,
        "createdAt": e.created_at,
        "expiresAt": e.expires_at,
    })
}

pub fn list_json() -> Value {
    let map = registry().lock().unwrap();
    let mut rows: Vec<(&String, &ShareEntry)> = map.iter().collect();
    rows.sort_by_key(|(_, e)| -e.created_at);
    Value::Array(rows.into_iter().map(|(id, e)| entry_json(id, e)).collect())
}

pub fn revoke(share_id: &str) -> bool {
    let entry = registry().lock().unwrap().remove(share_id);
    match entry {
        Some(e) => {
            let _ = e.cancel.send(true);
            true
        }
        None => false,
    }
}

/// Resolve a keyword to a live agent and mint a fresh view-only room for it.
/// Errors carry the HTTP status the route answers with (contract: ts/serve.ts).
pub async fn create(agent: &str, perm: &str, sighost: &str) -> Result<Value, (u16, String)> {
    if registry().lock().unwrap().len() >= MAX_SHARES {
        return Err((
            409,
            format!("too many active shares (max {MAX_SHARES}) — revoke one first"),
        ));
    }
    let rec = api::resolve_one_all(agent).map_err(|e| (404, e))?;
    let Some(agent_id) = rec.agent_id.clone() else {
        // Only agents registered with a stable id can be scoped safely; pid alone
        // is reused and unsafe as the security key.
        return Err((
            404,
            format!(
                "agent {} has no stable agent_id — cannot share (restart it)",
                rec.pid
            ),
        ));
    };
    let base = rec.cwd.split('/').rfind(|s| !s.is_empty());
    let label = match base {
        Some(b) => format!("{} · {}", rec.cli, b),
        None => rec.cli.clone(),
    };

    // Fresh, unpersisted room — never claim_room/persist_room (ephemeral by design).
    let room = share::mint_room(sighost);
    let (secret, _) = e2e::parse_secret(&room.token).map_err(|e| (500, e.to_string()))?;
    let link = share::format_share_link(&room.room, &secret, &room.host);

    let share_id = format!(
        "s{}",
        to_base36(
            i64::from(hash_str(&format!("{}{}{}", room.room, agent_id, link))).unsigned_abs()
        )
    );
    let created_at = now_ms();
    let expires_at = created_at + DEFAULT_SHARE_TTL_MS;

    let rw = perm == "rw";
    let scope = Arc::new(Scope::Agent {
        agent_id: agent_id.clone(),
        rw,
    });
    let (cancel_tx, cancel_rx) = watch::channel(false);
    tokio::spawn(share::run_scoped_session(
        room.room.clone(),
        secret,
        room.host.clone(),
        scope,
        cancel_rx,
    ));
    // TTL expiry — mirrors the TS setTimeout(revoke, ttl).
    {
        let share_id = share_id.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(
                DEFAULT_SHARE_TTL_MS as u64,
            ))
            .await;
            revoke(&share_id);
        });
    }

    let entry = ShareEntry {
        agent_id,
        perm: if rw { "rw" } else { "r" },
        room: room.room.clone(),
        link,
        label,
        created_at,
        expires_at,
        cancel: cancel_tx,
    };
    let out = entry_json(&share_id, &entry);
    registry().lock().unwrap().insert(share_id, entry);
    Ok(out)
}

// ---- the scope filter (ts/agentShare.ts scopedFetch) ------------------------

fn forbidden(msg: &str) -> ApiResponse {
    ApiResponse {
        status: 403,
        content_type: "text/plain".into(),
        body: Body::Full(msg.as_bytes().to_vec()),
    }
}

fn target_is_agent(keyword: &str, agent_id: &str) -> bool {
    match api::resolve_one_all(keyword) {
        Ok(rec) => rec.agent_id.as_deref() == Some(agent_id),
        Err(_) => false,
    }
}

/// Route a bridged request through the scope. Full passes straight to the API;
/// Agent default-denies and permits only the scoped read (and rw-steer) paths.
pub async fn scoped_handle(
    scope: &Scope,
    method: &str,
    path_with_query: &str,
    body: &str,
) -> ApiResponse {
    let (agent_id, rw) = match scope {
        Scope::Full => return api::handle(method, path_with_query, body).await,
        Scope::Agent { agent_id, rw } => (agent_id.as_str(), *rw),
    };
    let (path, query) = match path_with_query.split_once('?') {
        Some((p, q)) => (p, q),
        None => (path_with_query, ""),
    };

    // Static host metadata, no agent data.
    if method == "GET" && path == "/api/version" {
        return api::handle(method, path_with_query, body).await;
    }
    // Self-describing capability so the viewer console can enter read-only UI.
    // The host stays the real boundary (writes are 403'd regardless).
    if method == "GET" && path == "/api/whoami" {
        let res = api::handle(method, path_with_query, body).await;
        return with_share_flag(res, agent_id, rw);
    }

    // Agent list: force keyword=agent_id (cheap server-side narrowing) then
    // post-filter by EXACT agent_id — the keyword matcher can fuzzy-match a
    // sibling whose cwd/prompt contains the hex, so the hint is not a boundary.
    if method == "GET" && (path == "/api/ls" || path == "/api/ls/subscribe") {
        let mut params: Vec<String> = query
            .split('&')
            .filter(|kv| !kv.is_empty() && !kv.starts_with("keyword=") && !kv.starts_with("all="))
            .map(|s| s.to_string())
            .collect();
        params.push(format!("keyword={agent_id}"));
        let scoped_path = format!("{path}?{}", params.join("&"));
        let res = api::handle(method, &scoped_path, body).await;
        return if path == "/api/ls" {
            filter_ls_json(res, agent_id)
        } else {
            filter_ls_sse(res, agent_id.to_string())
        };
    }

    // Per-agent reads — verify the target resolves to OUR agent_id.
    if method == "GET" {
        for prefix in ["/api/read/", "/api/tail/", "/api/status/", "/api/size/"] {
            if let Some(rest) = path.strip_prefix(prefix) {
                if !rest.is_empty() {
                    if !target_is_agent(&api::url_decode(rest), agent_id) {
                        return forbidden("agent not shared");
                    }
                    return api::handle(method, path_with_query, body).await;
                }
            }
        }
    }

    // Steer (rw): a read-write share may drive THIS agent — send input, resize
    // its PTY, self-report presence. It still may NOT control it (kill/restart/
    // spawn are machine-admin) nor touch any other agent.
    if rw {
        if method == "POST" && path == "/api/send" {
            let kw = serde_json::from_str::<Value>(body)
                .ok()
                .and_then(|v| v.get("keyword").map(super::share::value_to_id));
            let Some(kw) = kw else {
                return forbidden("bad body");
            };
            if !target_is_agent(&kw, agent_id) {
                return forbidden("agent not shared");
            }
            return api::handle(method, path_with_query, body).await;
        }
        if method == "POST" {
            if let Some(rest) = path.strip_prefix("/api/resize/") {
                if !rest.is_empty() {
                    if !target_is_agent(&api::url_decode(rest), agent_id) {
                        return forbidden("agent not shared");
                    }
                    return api::handle(method, path_with_query, body).await;
                }
            }
        }
        if method == "POST" && path == "/api/presence" {
            return api::handle(method, path_with_query, body).await;
        }
    }

    // Everything else (kill, restart, spawn, notes, spawn-config, share*, …, and
    // — for a view-only share — send/resize/presence too) is denied.
    forbidden("read-only share")
}

fn with_share_flag(res: ApiResponse, agent_id: &str, rw: bool) -> ApiResponse {
    if res.status != 200 {
        return res;
    }
    let Body::Full(bytes) = res.body else {
        return res;
    };
    let mut obj = match serde_json::from_slice::<Value>(&bytes) {
        Ok(Value::Object(o)) => o,
        _ => {
            return ApiResponse {
                status: res.status,
                content_type: res.content_type,
                body: Body::Full(bytes),
            }
        }
    };
    obj.insert(
        "share".into(),
        json!({ "perm": if rw { "rw" } else { "r" }, "agent_id": agent_id, "readonly": !rw }),
    );
    ApiResponse {
        status: res.status,
        content_type: res.content_type,
        body: Body::Full(serde_json::to_vec(&Value::Object(obj)).unwrap_or_default()),
    }
}

fn filter_ls_json(res: ApiResponse, agent_id: &str) -> ApiResponse {
    if res.status != 200 {
        return res;
    }
    let Body::Full(bytes) = res.body else {
        return res;
    };
    let kept: Vec<Value> = match serde_json::from_slice::<Value>(&bytes) {
        Ok(Value::Array(rows)) => rows
            .into_iter()
            .filter(|r| r.get("agent_id").and_then(|a| a.as_str()) == Some(agent_id))
            .collect(),
        _ => Vec::new(),
    };
    ApiResponse {
        status: res.status,
        content_type: "application/json".into(),
        body: Body::Full(serde_json::to_vec(&Value::Array(kept)).unwrap_or_default()),
    }
}

/// Filter the /api/ls/subscribe SSE so only the shared agent's deltas cross the
/// channel. Buffers across chunk boundaries (events are blank-line separated)
/// and forwards removes only for pids it actually forwarded.
fn filter_ls_sse(res: ApiResponse, agent_id: String) -> ApiResponse {
    if res.status != 200 {
        return res;
    }
    let Body::Stream(mut rx) = res.body else {
        return res;
    };
    let (tx, out_rx) = mpsc::channel::<Vec<u8>>(16);
    tokio::spawn(async move {
        let mut buf = String::new();
        let mut forwarded: HashSet<i64> = HashSet::new();
        while let Some(chunk) = rx.recv().await {
            buf.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(sep) = buf.find("\n\n") {
                let raw_event = buf[..sep].to_string();
                buf.drain(..sep + 2);
                if let Some(out) = transform_event(&raw_event, &agent_id, &mut forwarded) {
                    if tx.send(format!("{out}\n\n").into_bytes()).await.is_err() {
                        return; // viewer gone — dropping rx cancels the upstream
                    }
                }
            }
        }
    });
    ApiResponse {
        status: 200,
        content_type: "text/event-stream".into(),
        body: Body::Stream(out_rx),
    }
}

/// Returns the rewritten SSE event text, or None to drop it entirely. Passes
/// through comment lines (": ping" heartbeats) and non-data frames unchanged.
fn transform_event(
    raw_event: &str,
    agent_id: &str,
    forwarded: &mut HashSet<i64>,
) -> Option<String> {
    let trimmed = raw_event.replace('\r', "");
    if trimmed.trim().is_empty() {
        return None;
    }
    if !trimmed.lines().any(|l| l.starts_with("data:")) {
        return Some(trimmed); // comments/heartbeats pass through
    }
    // Reassemble the `data:` payload (SSE allows multiple data: lines per event).
    let payload = trimmed
        .lines()
        .filter(|l| l.starts_with("data:"))
        .map(|l| l[5..].strip_prefix(' ').unwrap_or(&l[5..]))
        .collect::<Vec<_>>()
        .join("\n");
    let obj = serde_json::from_str::<Value>(&payload).ok()?; // malformed — drop, don't leak
    let full = obj.get("full").and_then(|f| f.as_bool()).unwrap_or(false);
    let upsert: Vec<Value> = obj
        .get("upsert")
        .and_then(|u| u.as_array())
        .map(|rows| {
            rows.iter()
                .filter(|r| r.get("agent_id").and_then(|a| a.as_str()) == Some(agent_id))
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    for r in &upsert {
        if let Some(pid) = r.get("pid").and_then(|p| p.as_i64()) {
            forwarded.insert(pid);
        }
    }
    let remove: Vec<i64> = obj
        .get("remove")
        .and_then(|r| r.as_array())
        .map(|pids| {
            pids.iter()
                .filter_map(|p| p.as_i64())
                .filter(|pid| forwarded.contains(pid))
                .collect()
        })
        .unwrap_or_default();
    for pid in &remove {
        forwarded.remove(pid);
    }
    // On the first snapshot always emit (even if empty) so the viewer knows it's
    // connected; later ticks only when something relevant changed.
    if !full && upsert.is_empty() && remove.is_empty() {
        return None;
    }
    let next = if full {
        json!({ "full": true, "upsert": upsert, "remove": remove })
    } else {
        json!({ "upsert": upsert, "remove": remove })
    };
    Some(format!("data: {next}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    // hashStr vectors pinned from ts/agentShare.ts (bun): the ids must be
    // bit-identical so a share minted by either daemon hashes the same way.
    #[test]
    fn hash_str_matches_js() {
        assert_eq!(hash_str(""), 0);
        assert_eq!(hash_str("a"), 97);
        assert_eq!(hash_str("日本語"), 25921943);
        let v = "rabc123deadbeef0011https://agent-yes.com/w/#rabc123:e1.ff";
        assert_eq!(hash_str(v), 17749077);
        assert_eq!(
            format!("s{}", to_base36(i64::from(hash_str(v)).unsigned_abs())),
            "sakf9x"
        );
    }

    fn agent_scope() -> Scope {
        Scope::Agent {
            agent_id: "aaaa0000bbbb".into(),
            rw: false,
        }
    }

    async fn status_of(method: &str, path: &str, body: &str) -> u16 {
        scoped_handle(&agent_scope(), method, path, body)
            .await
            .status
    }

    // The default-deny table from ts/agentShare.spec.ts: nothing outside the
    // allowlist may cross a view-only share, including the share-mint routes.
    #[tokio::test]
    async fn view_only_share_default_denies() {
        for (method, path) in [
            ("POST", "/api/kill"),
            ("POST", "/api/restart"),
            ("POST", "/api/spawn"),
            ("GET", "/api/notes"),
            ("GET", "/api/spawn-config"),
            ("GET", "/api/graph"),
            ("GET", "/api/search?q=x"),
            ("POST", "/api/share"),
            ("GET", "/api/shares"),
            ("DELETE", "/api/share/s123"),
            ("POST", "/api/send"),
            ("POST", "/api/resize/123"),
            ("POST", "/api/presence"),
            ("GET", "/api/tail/unknown-kw"),
        ] {
            assert_eq!(status_of(method, path, "{}").await, 403, "{method} {path}");
        }
    }

    #[tokio::test]
    async fn version_passes_through() {
        let res = scoped_handle(&agent_scope(), "GET", "/api/version", "").await;
        assert_eq!(res.status, 200);
    }

    #[tokio::test]
    async fn whoami_advertises_share_capability() {
        let res = scoped_handle(&agent_scope(), "GET", "/api/whoami", "").await;
        assert_eq!(res.status, 200);
        let Body::Full(bytes) = res.body else {
            panic!("expected full body")
        };
        let v: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["share"]["perm"], "r");
        assert_eq!(v["share"]["readonly"], true);
        assert_eq!(v["share"]["agent_id"], "aaaa0000bbbb");
    }

    #[test]
    fn transform_event_filters_and_tracks_removes() {
        let mut fwd = HashSet::new();
        // heartbeat comment passes through
        assert_eq!(
            transform_event(": ping", "id1", &mut fwd).as_deref(),
            Some(": ping")
        );
        // full snapshot: keep only ours, always emit
        let ev = r#"data: {"full":true,"upsert":[{"pid":1,"agent_id":"id1"},{"pid":2,"agent_id":"other"}],"remove":[]}"#;
        let out = transform_event(ev, "id1", &mut fwd).unwrap();
        assert!(out.contains(r#""full":true"#), "{out}");
        assert!(out.contains("id1"));
        assert!(!out.contains("other"));
        // delta touching only the sibling is dropped entirely
        let ev = r#"data: {"upsert":[{"pid":2,"agent_id":"other"}],"remove":[]}"#;
        assert!(transform_event(ev, "id1", &mut fwd).is_none());
        // sibling removal stays hidden; our forwarded pid's removal passes
        let ev = r#"data: {"upsert":[],"remove":[2]}"#;
        assert!(transform_event(ev, "id1", &mut fwd).is_none());
        let ev = r#"data: {"upsert":[],"remove":[1]}"#;
        let out = transform_event(ev, "id1", &mut fwd).unwrap();
        assert!(out.contains(r#""remove":[1]"#), "{out}");
        // a remove for a pid we never forwarded again drops (set was cleared)
        let ev = r#"data: {"upsert":[],"remove":[1]}"#;
        assert!(transform_event(ev, "id1", &mut fwd).is_none());
        // malformed JSON drops rather than leaks
        assert!(transform_event("data: {nope", "id1", &mut fwd).is_none());
    }
}
