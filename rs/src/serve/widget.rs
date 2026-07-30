// Widget sensor broker (`ay widget`) — port of the in-memory broker in
// ts/serve.ts. A browser page embedding the widget registers itself, holds an
// SSE poll open for commands, and POSTs results back; a CLI read enqueues a
// command and awaits the matching result. All state is per-process, exactly
// like the TS daemon: one broker per running daemon, nothing on disk.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tokio::sync::{mpsc, oneshot};

/// A viewer with no poll heartbeat for this long is offline.
const TTL_MS: i64 = 30_000;
const HEARTBEAT_MS: u64 = 15_000;

#[derive(Clone)]
struct Viewer {
    id: String,
    url: String,
    title: String,
    caps: Vec<String>,
    last_seen: i64,
}

#[derive(Default)]
struct Broker {
    viewers: HashMap<String, Viewer>,
    /// viewerId → the active poll stream's sender.
    pushers: HashMap<String, mpsc::Sender<Vec<u8>>>,
    /// cmdId → the read call waiting for its result.
    waiters: HashMap<String, oneshot::Sender<Value>>,
    cmd_seq: u64,
}

fn broker() -> &'static Mutex<Broker> {
    static B: OnceLock<Mutex<Broker>> = OnceLock::new();
    B.get_or_init(Default::default)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn new_id() -> String {
    use rand::RngCore;
    let mut b = [0u8; 4];
    rand::thread_rng().fill_bytes(&mut b);
    format!("v_{}", b.iter().map(|x| format!("{x:02x}")).collect::<String>())
}

/// Drop expired viewers and return what's left, newest registration order-agnostic
/// (the TS side iterates insertion order; callers here only match/list).
fn live(b: &mut Broker) -> Vec<Viewer> {
    let now = now_ms();
    b.viewers.retain(|_, v| now - v.last_seen < TTL_MS);
    let mut out: Vec<Viewer> = b.viewers.values().cloned().collect();
    out.sort_by(|a, c| a.id.cmp(&c.id));
    out
}

/// Resolve a `<viewer>` selector: exact id, then id-prefix / url / title substring.
fn resolve(b: &mut Broker, sel: &str) -> Option<String> {
    if let Some(v) = b.viewers.get(sel) {
        if now_ms() - v.last_seen < TTL_MS {
            return Some(sel.to_string());
        }
    }
    live(b)
        .into_iter()
        .find(|v| v.id.starts_with(sel) || v.url.contains(sel) || v.title.contains(sel))
        .map(|v| v.id)
}

/// POST /api/widget/register — `pinned` is the scoped token's subject, which
/// forces the id so a page can't register as another viewer.
pub fn register(body: &Value, pinned: Option<&str>) -> Value {
    let id = match pinned {
        Some(s) if s != "*" => s.to_string(),
        _ => match body.get("id").and_then(|v| v.as_str()) {
            Some(s) if !s.is_empty() => s.to_string(),
            _ => new_id(),
        },
    };
    let caps = body
        .get("caps")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|c| c.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let v = Viewer {
        id: id.clone(),
        url: body.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        title: body.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        caps,
        last_seen: now_ms(),
    };
    broker().lock().unwrap().viewers.insert(id.clone(), v);
    json!({ "viewerId": id })
}

/// GET /api/widget/list
pub fn list() -> Value {
    let now = now_ms();
    let mut b = broker().lock().unwrap();
    Value::Array(
        live(&mut b)
            .into_iter()
            .map(|v| {
                json!({
                    "id": v.id, "url": v.url, "title": v.title, "caps": v.caps,
                    "age": ((now - v.last_seen) as f64 / 1000.0).round() as i64,
                })
            })
            .collect(),
    )
}

/// True when a scoped token (subject `sub`) may act on viewer `vid`.
pub fn bound_ok(sub: Option<&str>, vid: &str) -> bool {
    match sub {
        None => true,
        Some("*") => true,
        Some(s) => s == vid,
    }
}

/// GET /api/widget/poll/:viewerId — the SSE command channel. Registers the
/// pusher and heartbeats every 15s; the heartbeat also refreshes `last_seen`,
/// so an open poll IS the liveness signal (same as the TS daemon).
pub fn poll(vid: String) -> mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel::<Vec<u8>>(16);
    {
        let mut b = broker().lock().unwrap();
        if let Some(v) = b.viewers.get_mut(&vid) {
            v.last_seen = now_ms();
        }
        b.pushers.insert(vid.clone(), tx.clone());
    }
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(HEARTBEAT_MS)).await;
            if tx.send(b": ping\n\n".to_vec()).await.is_err() {
                break;
            }
            let mut b = broker().lock().unwrap();
            if let Some(v) = b.viewers.get_mut(&vid) {
                v.last_seen = now_ms();
            }
        }
        // Only clear the pusher if it's still ours — a reconnect may have
        // replaced it while this heartbeat was in flight.
        let mut b = broker().lock().unwrap();
        if b.pushers.get(&vid).map(|p| p.same_channel(&tx)).unwrap_or(false) {
            b.pushers.remove(&vid);
        }
    });
    rx
}

/// POST /api/widget/result — the widget answering a command.
pub fn result(body: &Value) -> Value {
    if let Some(cmd_id) = body.get("cmdId").and_then(|v| v.as_str()) {
        let waiter = broker().lock().unwrap().waiters.remove(cmd_id);
        if let Some(tx) = waiter {
            let _ = tx.send(json!({
                "ok": body.get("ok") == Some(&Value::Bool(true)),
                "data": body.get("data").cloned().unwrap_or(Value::Null),
                "error": body.get("error").cloned().unwrap_or(Value::Null),
            }));
        }
    }
    json!({ "ok": true })
}

/// POST /api/widget/read — issue a command to a viewer and await its result.
/// `caps` is the scoped token's cap list (None for the master token).
pub async fn read(body: &Value, sub: Option<&str>, caps: Option<&[String]>) -> Result<Value, (u16, String)> {
    let viewer = body.get("viewer").and_then(|v| v.as_str()).unwrap_or("");
    let kind = body.get("kind").and_then(|v| v.as_str()).unwrap_or("");
    if viewer.is_empty() || kind.is_empty() {
        return Err((400, "missing viewer/kind".into()));
    }
    // Screenshot is the one cap gated beyond 'read'; the master token is unrestricted.
    if let Some(caps) = caps {
        if kind == "screenshot" && !caps.iter().any(|c| c == "screenshot") {
            return Err((403, "scoped token lacks 'screenshot'".into()));
        }
    }
    let (vid, push, cmd_id, url) = {
        let mut b = broker().lock().unwrap();
        let Some(vid) = resolve(&mut b, viewer) else {
            return Err((404, format!("no online viewer matching \"{viewer}\"")));
        };
        if !bound_ok(sub, &vid) {
            return Err((403, "token not bound to this viewer".into()));
        }
        let Some(push) = b.pushers.get(&vid).cloned() else {
            return Err((409, "viewer offline".into()));
        };
        b.cmd_seq += 1;
        let cmd_id = format!("c{}_{}", b.cmd_seq, now_ms());
        let url = b.viewers.get(&vid).map(|v| v.url.clone()).unwrap_or_default();
        (vid, push, cmd_id, url)
    };

    let (tx, rx) = oneshot::channel();
    broker().lock().unwrap().waiters.insert(cmd_id.clone(), tx);
    let cmd = json!({ "cmdId": cmd_id, "kind": kind, "args": body.get("args").cloned().unwrap_or(json!({})) });
    let _ = push.send(format!("data: {cmd}\n\n").into_bytes()).await;

    // Screenshot waits on a human one-time consent, so it gets a longer window.
    let timeout = std::time::Duration::from_millis(if kind == "screenshot" { 30_000 } else { 10_000 });
    let res = match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(v)) => v,
        _ => {
            broker().lock().unwrap().waiters.remove(&cmd_id);
            json!({ "ok": false, "error": "timeout" })
        }
    };

    let mut out = json!({ "viewer": vid, "url": url, "ts": now_ms() / 1000, "kind": kind });
    let map = out.as_object_mut().unwrap();
    if res["ok"] == Value::Bool(true) {
        map.insert("data".into(), res["data"].clone());
    } else {
        let e = res["error"].as_str().unwrap_or("failed").to_string();
        map.insert("error".into(), Value::String(if e.is_empty() { "failed".into() } else { e }));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The broker is process-global, so tests that clear it must not overlap.
    fn reset() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: Mutex<()> = Mutex::new(());
        let g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        *broker().lock().unwrap() = Broker::default();
        g
    }

    #[test]
    fn a_scoped_subject_pins_the_registered_id() {
        let _g = reset();
        let v = register(&json!({ "id": "chosen", "url": "http://x" }), Some("pinned"));
        assert_eq!(v["viewerId"], json!("pinned"));
        // "*" and the master token let the widget pick.
        let v = register(&json!({ "id": "chosen" }), Some("*"));
        assert_eq!(v["viewerId"], json!("chosen"));
    }

    #[test]
    fn expired_viewers_drop_out_of_list_and_resolve() {
        let _g = reset();
        register(&json!({ "id": "stale", "url": "http://x" }), None);
        broker().lock().unwrap().viewers.get_mut("stale").unwrap().last_seen = now_ms() - TTL_MS - 1;
        assert_eq!(list().as_array().unwrap().len(), 0);
        assert_eq!(resolve(&mut broker().lock().unwrap(), "stale"), None);
    }

    #[test]
    fn resolve_falls_back_to_prefix_url_and_title() {
        let _g = reset();
        register(&json!({ "id": "v_abcd", "url": "https://example.com/app", "title": "Dash" }), None);
        let mut b = broker().lock().unwrap();
        assert_eq!(resolve(&mut b, "v_ab").as_deref(), Some("v_abcd"));
        assert_eq!(resolve(&mut b, "example.com").as_deref(), Some("v_abcd"));
        assert_eq!(resolve(&mut b, "Dash").as_deref(), Some("v_abcd"));
        assert_eq!(resolve(&mut b, "nope"), None);
    }

    #[test]
    fn bound_ok_only_blocks_a_mismatched_subject() {
        assert!(bound_ok(None, "v1"));
        assert!(bound_ok(Some("*"), "v1"));
        assert!(bound_ok(Some("v1"), "v1"));
        assert!(!bound_ok(Some("v2"), "v1"));
    }

    #[tokio::test]
    async fn read_404s_an_unknown_viewer_and_409s_one_with_no_poll() {
        let _g = reset();
        let err = read(&json!({ "viewer": "ghost", "kind": "dom" }), None, None).await.unwrap_err();
        assert_eq!(err.0, 404);
        register(&json!({ "id": "v1" }), None);
        let err = read(&json!({ "viewer": "v1", "kind": "dom" }), None, None).await.unwrap_err();
        assert_eq!(err.0, 409);
    }

    #[tokio::test]
    async fn a_polling_viewer_receives_the_command_and_its_result_returns() {
        let _g = reset();
        register(&json!({ "id": "v1", "url": "http://u" }), None);
        let mut rx = poll("v1".into());
        let handle = tokio::spawn(async move {
            read(&json!({ "viewer": "v1", "kind": "dom" }), None, None).await
        });
        let frame = String::from_utf8(rx.recv().await.unwrap()).unwrap();
        let cmd: Value = serde_json::from_str(frame.trim_start_matches("data: ").trim()).unwrap();
        assert_eq!(cmd["kind"], json!("dom"));
        result(&json!({ "cmdId": cmd["cmdId"], "ok": true, "data": "<html>" }));
        let out = handle.await.unwrap().unwrap();
        assert_eq!(out["data"], json!("<html>"));
        assert_eq!(out["url"], json!("http://u"));
    }

    #[tokio::test]
    async fn a_screenshot_read_needs_the_screenshot_cap() {
        let _g = reset();
        register(&json!({ "id": "v1" }), None);
        let err = read(&json!({ "viewer": "v1", "kind": "screenshot" }), None, Some(&[]))
            .await
            .unwrap_err();
        assert_eq!(err.0, 403);
    }
}
