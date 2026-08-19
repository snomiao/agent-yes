// `ayrs serve --port N` — the local HTTP listener, the second transport
// alongside the WebRTC share room. Same API surface (everything goes through
// serve::api::handle), plus the static console assets and the /api/mux
// WebSocket multiplexer.
//
// Binds loopback only: the daemon exposes an unauthenticated-by-network,
// token-authenticated API over every agent on this machine, so it must never be
// reachable from the LAN. Remote access is the share room's job, which is
// end-to-end encrypted.

use crate::serve::api::{self, ApiResponse, Body as ApiBody};
use anyhow::{Context, Result};
use http_body_util::{BodyExt, StreamBody};
use hyper::body::{Bytes, Frame, Incoming};
use hyper::{Request, Response, StatusCode};
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

type BoxBody = http_body_util::combinators::BoxBody<Bytes, Infallible>;
const DISCOVERY_FILE: &str = "ayrs-http.json";

fn spawn_spool_dir() -> std::path::PathBuf {
    #[cfg(unix)]
    let owner = unsafe { libc::getuid() }.to_string();
    #[cfg(not(unix))]
    let owner = std::env::var("USERNAME").unwrap_or_else(|_| "user".into());
    std::env::temp_dir()
        .join(format!("agent-yes-{owner}"))
        .join("spawn")
}

async fn run_spawn_spool(dir: std::path::PathBuf, token: Arc<String>) {
    loop {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                    continue;
                };
                if !name.ends_with(".request.json") {
                    continue;
                }
                let response_path =
                    path.with_file_name(name.replace(".request.json", ".response.json"));
                let response = match std::fs::read_to_string(&path)
                    .ok()
                    .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
                {
                    Some(value)
                        if value.get("token").and_then(|v| v.as_str()) == Some(token.as_str()) =>
                    {
                        let body = value
                            .get("request")
                            .cloned()
                            .unwrap_or(serde_json::Value::Null)
                            .to_string();
                        crate::serve::control::spawn(&body)
                    }
                    _ => ApiResponse {
                        status: 401,
                        content_type: "text/plain".into(),
                        body: ApiBody::Full(b"Unauthorized".to_vec()),
                    },
                };
                let _ = std::fs::remove_file(&path);
                let body = match response.body {
                    ApiBody::Full(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
                    ApiBody::Stream(_) => "stream response unsupported".into(),
                };
                let payload = serde_json::json!({ "status": response.status, "body": body });
                let _ = std::fs::write(
                    response_path,
                    serde_json::to_vec(&payload).unwrap_or_default(),
                );
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Defense-in-depth CSP for the console document (mirrors CONSOLE_CSP in
/// ts/serve.ts and lab/ui/cf/worker.ts — keep them in sync). The console renders
/// remote host-supplied agent metadata, so we constrain where an injection could
/// send data even though output is escaped.
const CONSOLE_CSP: &str = "default-src 'self'; base-uri 'none'; object-src 'none'; \
     frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; \
     font-src 'self' data:; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; \
     script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net; \
     connect-src 'self' https://s.agent-yes.com https://agent-yes.com wss:; \
     worker-src 'self'; manifest-src 'self'";

fn full(b: Vec<u8>) -> BoxBody {
    http_body_util::Full::new(Bytes::from(b)).boxed()
}

/// Constant-time token comparison — a length-independent early return would leak
/// the token prefix to a local attacker who can time requests.
fn token_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.bytes()
        .zip(b.bytes())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}

/// Directory holding the console assets, next to the installed binary or in the
/// source tree during development.
fn ui_dir() -> Option<std::path::PathBuf> {
    let mut roots: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        // installed: <prefix>/bin/ayrs → <prefix>/lab/ui
        if let Some(p) = exe.parent().and_then(|d| d.parent()) {
            roots.push(p.join("lab").join("ui"));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd.join("lab").join("ui"));
    }
    roots.into_iter().find(|p| p.is_dir())
}

fn content_type(name: &str) -> &'static str {
    match name.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "webmanifest" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "map" => "application/json",
        "png" => "image/png",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    }
}

fn serve_ui_file(name: &str) -> Response<BoxBody> {
    // Path traversal guard: the request path is attacker-controlled, and this
    // route is UNAUTHENTICATED (the page holds no secrets), so a "../" escape
    // would hand out arbitrary host files to anyone who can reach the port.
    if name.split('/').any(|seg| seg == ".." || seg.is_empty()) {
        return status(StatusCode::NOT_FOUND, "not found");
    }
    let Some(buf) = ui_dir().and_then(|d| std::fs::read(d.join(name)).ok()) else {
        return status(
            StatusCode::NOT_FOUND,
            "UI assets not found in this install — use the /api endpoints",
        );
    };
    let ct = content_type(name);
    let mut b = Response::builder().status(200).header("content-type", ct);
    if ct.starts_with("text/html") {
        b = b.header("content-security-policy", CONSOLE_CSP);
    }
    b.body(full(buf)).unwrap()
}

fn status(code: StatusCode, msg: &str) -> Response<BoxBody> {
    Response::builder()
        .status(code)
        .header("content-type", "text/plain")
        .body(full(msg.as_bytes().to_vec()))
        .unwrap()
}

/// Turn an ApiResponse into a hyper response, streaming SSE bodies as they
/// arrive rather than buffering (a tail stream never ends).
fn to_http(r: ApiResponse) -> Response<BoxBody> {
    let mut b = Response::builder()
        .status(r.status)
        .header("content-type", r.content_type.clone());
    match r.body {
        ApiBody::Full(v) => b.body(full(v)).unwrap(),
        ApiBody::Stream(rx) => {
            b = b
                .header("cache-control", "no-cache")
                .header("connection", "keep-alive");
            // Poll the channel straight into body frames — no intermediate
            // task, and the concrete stream type stays Sync (BoxBody requires
            // it, and a `dyn Stream + Send` box does not satisfy that).
            let mut rx = rx;
            let s = futures::stream::poll_fn(move |cx| {
                rx.poll_recv(cx)
                    .map(|o| o.map(|chunk| Ok::<_, Infallible>(Frame::data(Bytes::from(chunk)))))
            });
            b.body(BodyExt::boxed(StreamBody::new(s))).unwrap()
        }
    }
}

async fn handle(
    req: Request<Incoming>,
    token: Arc<String>,
) -> Result<Response<BoxBody>, Infallible> {
    let method = req.method().as_str().to_string();
    let path = req.uri().path().to_string();
    let query = req.uri().query().unwrap_or("").to_string();

    // ---- static console assets (unauthenticated: the page holds no secrets;
    // it carries the token in its #k= fragment and sends it on every /api call).
    if method == "GET" && !path.starts_with("/api/") {
        return Ok(match path.as_str() {
            "/" | "/index.html" => serve_ui_file("index.html"),
            "/favicon.ico" => status(StatusCode::NO_CONTENT, ""),
            p => serve_ui_file(p.trim_start_matches('/')),
        });
    }

    // ---- GET /api/mux — WebSocket request multiplexer.
    //
    // HTTP/1.1 gives a browser ~6 concurrent same-origin connections and no
    // multiplexing, so console bursts (a palette query fans out ~20 tail reads
    // plus a history search) queue behind each other for seconds. The mux
    // carries {id, method, path, body} frames over ONE socket and answers
    // {id, status, text}; each frame is dispatched through the SAME handler, so
    // there is exactly one API surface.
    if path == "/api/mux" && is_websocket_upgrade(req.headers()) {
        let tok = url_query_value(&query, "token").unwrap_or_default();
        if !token_eq(&tok, &token) {
            return Ok(status(StatusCode::UNAUTHORIZED, "Unauthorized"));
        }
        let Some(key) = req
            .headers()
            .get("sec-websocket-key")
            .and_then(|v| v.to_str().ok())
        else {
            return Ok(status(StatusCode::BAD_REQUEST, "missing Sec-WebSocket-Key"));
        };
        let accept = ws_accept(key);
        let upgrade = hyper::upgrade::on(req);
        tokio::spawn(async move {
            let Ok(upgraded) = upgrade.await else { return };
            let io = hyper_util::rt::TokioIo::new(upgraded);
            let ws = tokio_tungstenite::WebSocketStream::from_raw_socket(
                io,
                tokio_tungstenite::tungstenite::protocol::Role::Server,
                None,
            )
            .await;
            serve_mux(ws).await;
        });
        return Ok(Response::builder()
            .status(StatusCode::SWITCHING_PROTOCOLS)
            .header("upgrade", "websocket")
            .header("connection", "Upgrade")
            .header("sec-websocket-accept", accept)
            .body(full(vec![]))
            .unwrap());
    }

    // ---- auth gate for everything under /api/
    let provided = req
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::to_string)
        .or_else(|| url_query_value(&query, "token"))
        .unwrap_or_default();
    if !token_eq(&provided, &token) {
        return Ok(status(StatusCode::UNAUTHORIZED, "Unauthorized"));
    }

    let body = req
        .into_body()
        .collect()
        .await
        .map(|c| String::from_utf8_lossy(&c.to_bytes()).into_owned())
        .unwrap_or_default();
    let with_query = if query.is_empty() {
        path.clone()
    } else {
        format!("{path}?{query}")
    };
    Ok(to_http(api::handle(&method, &with_query, &body).await))
}

fn is_websocket_upgrade(h: &hyper::HeaderMap) -> bool {
    h.get("upgrade")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.eq_ignore_ascii_case("websocket"))
        == Some(true)
}

/// RFC 6455 handshake response value: base64(SHA1(key + GUID)). Uses
/// tungstenite's own implementation so the client and server agree by
/// construction.
fn ws_accept(key: &str) -> String {
    tokio_tungstenite::tungstenite::handshake::derive_accept_key(key.as_bytes())
}

/// Dispatch mux frames until the socket closes. Each frame is answered
/// independently and concurrently — the whole point is to stop a slow request
/// from blocking the ones behind it.
async fn serve_mux<S>(ws: tokio_tungstenite::WebSocketStream<S>)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    use futures::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    let (mut tx, mut rx) = ws.split();
    let (out_tx, mut out_rx) = tokio::sync::mpsc::channel::<String>(64);
    let writer = tokio::spawn(async move {
        while let Some(s) = out_rx.recv().await {
            if tx.send(Message::Text(s.into())).await.is_err() {
                break;
            }
        }
    });
    while let Some(Ok(msg)) = rx.next().await {
        let Message::Text(raw) = msg else { continue };
        let Ok(m) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        let (Some(id), Some(path)) = (m.get("id").cloned(), m.get("path").and_then(|p| p.as_str()))
        else {
            continue;
        };
        if id.is_null() || !path.starts_with("/api/") {
            continue;
        }
        let path = path.to_string();
        let method = m
            .get("method")
            .and_then(|v| v.as_str())
            .unwrap_or("GET")
            .to_string();
        let body = match m.get("body") {
            Some(b) if !b.is_null() => b.to_string(),
            _ => String::new(),
        };
        let out_tx = out_tx.clone();
        tokio::spawn(async move {
            let res = api::handle(&method, &path, &body).await;
            // Streams can't ride a req/res frame — refuse instead of buffering
            // an endless SSE body (subscribe stays on EventSource client-side).
            let reply = if res.content_type.contains("text/event-stream") {
                serde_json::json!({ "id": id, "status": 501, "text": "streams not supported over mux" })
            } else {
                let text = match res.body {
                    ApiBody::Full(v) => String::from_utf8_lossy(&v).into_owned(),
                    ApiBody::Stream(_) => String::new(),
                };
                serde_json::json!({ "id": id, "status": res.status, "text": text })
            };
            let _ = out_tx.send(reply.to_string()).await;
        });
    }
    drop(out_tx);
    let _ = writer.await;
}

fn url_query_value(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        (k == key).then(|| v.replace('+', " "))
    })
}

/// Bind the listener and serve until the process exits. Returns the bound
/// address (port 0 resolves to a real port, which the caller prints).
pub async fn run(port: u16) -> Result<()> {
    let token = Arc::new(api::load_or_create_token().context("serve token")?);
    // Loopback only — see the module header.
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .with_context(|| format!("bind {addr}"))?;
    let local = listener.local_addr()?;
    let spool = spawn_spool_dir();
    std::fs::create_dir_all(&spool)
        .with_context(|| format!("create spawn spool {}", spool.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&spool, std::fs::Permissions::from_mode(0o700));
    }
    tokio::spawn(run_spawn_spool(spool.clone(), token.clone()));
    // Publish only the loopback endpoint, never the bearer token. Sandboxed
    // nested `ay <cli>` launchers can usually read ~/.agent-yes but cannot write
    // its PID/FIFO registry; they use this endpoint to ask the unsandboxed
    // service to spawn on their behalf. The client reads the existing 0600
    // .serve-token separately and verifies /api/host before using the endpoint.
    let discovery = dirs::home_dir()
        .map(|h| h.join(".agent-yes"))
        .unwrap_or_else(|| std::path::PathBuf::from(".agent-yes"))
        .join(DISCOVERY_FILE);
    if let Some(parent) = discovery.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let discovery_body = serde_json::json!({
        "pid": std::process::id(),
        "port": local.port(),
        "spool": spool,
    });
    std::fs::write(&discovery, serde_json::to_vec(&discovery_body)?)
        .with_context(|| format!("write {}", discovery.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&discovery, std::fs::Permissions::from_mode(0o600));
    }
    println!("http://127.0.0.1:{}/#k={}", local.port(), token);
    loop {
        let (stream, _) = listener.accept().await?;
        let token = token.clone();
        tokio::spawn(async move {
            let io = hyper_util::rt::TokioIo::new(stream);
            let svc = hyper::service::service_fn(move |req| handle(req, token.clone()));
            // Keep-alive matters: the console holds several long-lived SSE
            // streams plus short API calls on the same origin.
            // .with_upgrades() is REQUIRED for hyper::upgrade::on to ever
            // resolve — without it the 101 goes out and the socket is then
            // dropped, so /api/mux connects and answers nothing.
            let _ = hyper::server::conn::http1::Builder::new()
                .serve_connection(io, svc)
                .with_upgrades()
                .await;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_eq_is_exact() {
        assert!(token_eq("abc", "abc"));
        assert!(!token_eq("abc", "abd"));
        assert!(!token_eq("abc", "ab"));
        assert!(!token_eq("", "x"));
    }

    #[test]
    fn traversal_attempts_404_instead_of_reading_the_host() {
        for p in ["../../etc/passwd", "a/../../b", "..", "foo//bar"] {
            assert_eq!(serve_ui_file(p).status(), StatusCode::NOT_FOUND, "{p}");
        }
    }

    #[test]
    fn html_carries_the_console_csp() {
        // Only assert the header policy itself; whether assets exist is
        // install-dependent.
        assert!(CONSOLE_CSP.contains("frame-ancestors 'none'"));
        assert!(CONSOLE_CSP.contains("default-src 'self'"));
    }

    #[test]
    fn query_values_parse() {
        assert_eq!(
            url_query_value("a=1&token=xy", "token").as_deref(),
            Some("xy")
        );
        assert_eq!(url_query_value("a=1", "token"), None);
    }

    #[test]
    fn content_types_cover_the_console_assets() {
        assert_eq!(content_type("index.html"), "text/html; charset=utf-8");
        assert_eq!(content_type("main.js"), "text/javascript; charset=utf-8");
        assert_eq!(
            content_type("manifest.webmanifest"),
            "application/json; charset=utf-8"
        );
        assert_eq!(content_type("icon.svg"), "image/svg+xml");
    }
}
