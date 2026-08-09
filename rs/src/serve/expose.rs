// `ay expose <port>` relay client — Rust port of ts/expose.ts + the host half
// of codehost's tunnel protocol (node_modules/codehost/src/tunnel/{protocol,host}.ts).
//
// https://<id>.agent-yes.com/* ⇄ Exposure DO ⇄ this daemon ⇄ 127.0.0.1:<port>.
// The daemon dials OUT (wss://<relay>/_ay/tunnel/<id>), so it works behind any
// NAT. Private by default: visitors need a single-use claim link (it swaps for
// an 8h HttpOnly cookie at the edge; unauthenticated requests never reach this
// machine). See lab/ui/cf/exposure.ts for the edge.
//
// `exposures.json` keeps the TS path/format byte-compatible (slot key
// "<relayHost>:<port>", 0600, tmp+rename) so a port keeps its stable URL when
// the user switches daemons.
use anyhow::{anyhow, bail, Context, Result};
use futures::{SinkExt, StreamExt};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, watch, Mutex};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

const DEFAULT_RELAY: &str = "https://agent-yes.com";
const PING_MS: u64 = 25_000;
const RECONNECT_MIN_MS: u64 = 1_000;
const RECONNECT_MAX_MS: u64 = 30_000;

// ---- tunnel protocol framing (codehost/src/tunnel/protocol.ts) --------------

const FRAME_HEADER: usize = 5;
const MAX_FRAME: usize = 64 * 1024;
/// Max payload bytes per frame; larger bodies/messages split across frames.
const MAX_CHUNK: usize = MAX_FRAME - FRAME_HEADER;

#[derive(Clone, Copy, PartialEq, Debug)]
#[repr(u8)]
enum Op {
    HttpReq = 1,
    HttpReqBody = 2,
    HttpReqEnd = 3,
    HttpResHead = 4,
    HttpResBody = 5,
    HttpResEnd = 6,
    WsOpen = 7,
    WsOpenAck = 8,
    WsText = 9,
    WsBin = 10,
    WsClose = 11,
    Error = 12,
    WsCont = 13,
}

impl Op {
    fn from_u8(b: u8) -> Option<Op> {
        Some(match b {
            1 => Op::HttpReq,
            2 => Op::HttpReqBody,
            3 => Op::HttpReqEnd,
            4 => Op::HttpResHead,
            5 => Op::HttpResBody,
            6 => Op::HttpResEnd,
            7 => Op::WsOpen,
            8 => Op::WsOpenAck,
            9 => Op::WsText,
            10 => Op::WsBin,
            11 => Op::WsClose,
            12 => Op::Error,
            13 => Op::WsCont,
            _ => return None,
        })
    }
}

fn encode_frame(op: Op, stream_id: u32, payload: &[u8]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(FRAME_HEADER + payload.len());
    buf.push(op as u8);
    buf.extend_from_slice(&stream_id.to_be_bytes());
    buf.extend_from_slice(payload);
    buf
}

fn encode_json(op: Op, stream_id: u32, v: &Value) -> Vec<u8> {
    encode_frame(op, stream_id, v.to_string().as_bytes())
}

struct DecodedFrame<'a> {
    op: Op,
    stream_id: u32,
    payload: &'a [u8],
}

fn decode_frame(data: &[u8]) -> Option<DecodedFrame<'_>> {
    if data.len() < FRAME_HEADER {
        return None;
    }
    Some(DecodedFrame {
        op: Op::from_u8(data[0])?,
        stream_id: u32::from_be_bytes([data[1], data[2], data[3], data[4]]),
        payload: &data[FRAME_HEADER..],
    })
}

/// Frames for one WebSocket message: WsCont carrying the leading bytes,
/// terminated by the WsText/WsBin frame with the final bytes.
fn ws_message_frames(terminal: Op, stream_id: u32, payload: &[u8]) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    let mut off = 0;
    while payload.len() - off > MAX_CHUNK {
        out.push(encode_frame(
            Op::WsCont,
            stream_id,
            &payload[off..off + MAX_CHUNK],
        ));
        off += MAX_CHUNK;
    }
    out.push(encode_frame(terminal, stream_id, &payload[off..]));
    out
}

// ---- exposures.json (stable id+key per relay:port slot) ---------------------

fn global_dir() -> PathBuf {
    if let Ok(h) = std::env::var("AGENT_YES_HOME") {
        return PathBuf::from(h);
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".agent-yes")
}

fn exposures_path() -> PathBuf {
    let home = global_dir();
    let _ = std::fs::create_dir_all(&home);
    home.join("exposures.json")
}

fn random_hex(bytes: usize) -> String {
    use rand::RngCore;
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    hex::encode(buf)
}

const B64URL: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

fn base64url(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(B64URL[(n >> 18) as usize & 63] as char);
        out.push(B64URL[(n >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(B64URL[(n >> 6) as usize & 63] as char);
        }
        if chunk.len() > 2 {
            out.push(B64URL[n as usize & 63] as char);
        }
    }
    out
}

/// Stable id+key per (relayHost, port): re-exposing a port keeps its URL.
fn load_or_create_exposure(relay_host: &str, port: u16) -> (String, String) {
    load_or_create_exposure_at(&exposures_path(), relay_host, port)
}

fn load_or_create_exposure_at(
    file: &std::path::Path,
    relay_host: &str,
    port: u16,
) -> (String, String) {
    let mut all: serde_json::Map<String, Value> = std::fs::read_to_string(file)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    let slot = format!("{relay_host}:{port}");
    if let Some(rec) = all.get(&slot) {
        if let (Some(id), Some(key)) = (
            rec.get("id")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty()),
            rec.get("key")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty()),
        ) {
            return (id.to_string(), key.to_string());
        }
    }
    // "x" prefix: exposure hostnames can never collide with named subdomains.
    let id = format!("x{}", &random_hex(8)[..15]);
    let key = random_hex(32);
    all.insert(slot, json!({ "id": id, "key": key }));
    let tmp = file.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(&Value::Object(all)).unwrap_or_default() + "\n";
    if std::fs::write(&tmp, body).is_ok() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
        }
        let _ = std::fs::rename(&tmp, file);
    }
    (id, key)
}

// ---- the tunnel host: frames ⇄ 127.0.0.1:<port> -----------------------------

// Hop-by-hop headers that must not be forwarded across the tunnel.
const HOP_BY_HOP: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "content-length",
    "host",
];

struct HttpStream {
    head: Value,
    body: Vec<Vec<u8>>,
}

/// Per-relay-connection tunnel state. Dropped (and with it every local WS/HTTP
/// stream) when the relay socket closes; the browser retries via the edge.
struct TunnelHost {
    port: u16,
    /// Binary frames back to the relay (serialized by the connection writer).
    /// Bounded: awaiting send() is the tunnel's backpressure — a slow relay
    /// pauses body pumps instead of buffering whole downloads in RAM
    /// (TS pairs HIGH_WATER/LOW_WATER on bufferedAmount for the same effect).
    out: mpsc::Sender<Message>,
    http_streams: Mutex<HashMap<u32, HttpStream>>,
    /// Client→host WS message reassembly buffers (WsCont chains).
    ws_rx_bufs: Mutex<HashMap<u32, Vec<Vec<u8>>>>,
    /// Open local WebSocket writers by streamId.
    ws_conns: Mutex<HashMap<u32, mpsc::UnboundedSender<Message>>>,
}

impl TunnelHost {
    fn new(port: u16, out: mpsc::Sender<Message>) -> Arc<Self> {
        Arc::new(TunnelHost {
            port,
            out,
            http_streams: Mutex::new(HashMap::new()),
            ws_rx_bufs: Mutex::new(HashMap::new()),
            ws_conns: Mutex::new(HashMap::new()),
        })
    }

    async fn send_frame(&self, frame: Vec<u8>) {
        let _ = self.out.send(Message::Binary(frame.into())).await;
    }

    /// Close every bridged local WebSocket (host.ts closeAll): run when the
    /// relay socket dies so reconnects don't leak zombie local connections.
    async fn close_all(&self) {
        for (_, tx) in self.ws_conns.lock().await.drain() {
            let _ = tx.send(Message::Close(None));
        }
        self.ws_rx_bufs.lock().await.clear();
        self.http_streams.lock().await.clear();
    }

    async fn on_frame(self: &Arc<Self>, data: &[u8]) {
        let Some(f) = decode_frame(data) else { return };
        match f.op {
            Op::HttpReq => {
                if let Ok(head) = serde_json::from_slice::<Value>(f.payload) {
                    self.http_streams.lock().await.insert(
                        f.stream_id,
                        HttpStream {
                            head,
                            body: Vec::new(),
                        },
                    );
                }
            }
            Op::HttpReqBody => {
                if let Some(s) = self.http_streams.lock().await.get_mut(&f.stream_id) {
                    s.body.push(f.payload.to_vec());
                }
            }
            Op::HttpReqEnd => {
                let Some(stream) = self.http_streams.lock().await.remove(&f.stream_id) else {
                    return;
                };
                let this = self.clone();
                let stream_id = f.stream_id;
                tokio::spawn(async move {
                    if let Err(e) = this.do_http(stream_id, stream).await {
                        this.send_frame(encode_json(
                            Op::Error,
                            stream_id,
                            &json!({ "message": format!("proxy error: {e}") }),
                        ))
                        .await;
                    }
                });
            }
            Op::WsOpen => {
                let Ok(info) = serde_json::from_slice::<Value>(f.payload) else {
                    return;
                };
                let this = self.clone();
                let stream_id = f.stream_id;
                tokio::spawn(async move { this.open_ws(stream_id, info).await });
            }
            Op::WsCont => {
                self.ws_rx_bufs
                    .lock()
                    .await
                    .entry(f.stream_id)
                    .or_default()
                    .push(f.payload.to_vec());
            }
            Op::WsText | Op::WsBin => {
                let mut whole = self
                    .ws_rx_bufs
                    .lock()
                    .await
                    .remove(&f.stream_id)
                    .unwrap_or_default();
                whole.push(f.payload.to_vec());
                let bytes: Vec<u8> = whole.concat();
                let msg = if f.op == Op::WsText {
                    Message::Text(String::from_utf8_lossy(&bytes).into_owned().into())
                } else {
                    Message::Binary(bytes.into())
                };
                if let Some(tx) = self.ws_conns.lock().await.get(&f.stream_id) {
                    let _ = tx.send(msg);
                }
            }
            Op::WsClose => {
                self.ws_rx_bufs.lock().await.remove(&f.stream_id);
                if let Some(tx) = self.ws_conns.lock().await.remove(&f.stream_id) {
                    let _ = tx.send(Message::Close(None));
                }
            }
            _ => {}
        }
    }

    // -- HTTP: one loopback connection per request (mirrors TS fetch) --
    async fn do_http(self: &Arc<Self>, stream_id: u32, stream: HttpStream) -> Result<()> {
        let method = stream
            .head
            .get("method")
            .and_then(|v| v.as_str())
            .unwrap_or("GET")
            .to_string();
        let path = stream
            .head
            .get("path")
            .and_then(|v| v.as_str())
            .unwrap_or("/")
            .to_string();

        let mut req = hyper::Request::builder().method(method.as_str()).uri(&path);
        let mut forwarded_host = String::new();
        let mut wants_gzip = false;
        if let Some(headers) = stream.head.get("headers").and_then(|h| h.as_object()) {
            for (k, v) in headers {
                let Some(v) = v.as_str() else { continue };
                let lk = k.to_lowercase();
                if lk == "x-forwarded-host" {
                    forwarded_host = v.to_string();
                    continue;
                }
                if lk == "x-codehost-accept-gzip" {
                    wants_gzip = v == "1";
                    continue;
                }
                if !HOP_BY_HOP.contains(&lk.as_str()) {
                    req = req.header(k, v);
                }
            }
        }
        // Present the browser's public host to the local server so client-side
        // absolute URLs route back through the tunnel.
        let host = if forwarded_host.is_empty() {
            format!("127.0.0.1:{}", self.port)
        } else {
            forwarded_host
        };
        req = req.header("host", host);
        if wants_gzip {
            // Pass the upstream's gzip bytes through UNTOUCHED (hyper never
            // auto-inflates, so setting the header is all it takes).
            req = req.header("accept-encoding", "gzip");
        }

        let has_body = method != "GET" && method != "HEAD" && !stream.body.is_empty();
        let body_bytes: Vec<u8> = if has_body {
            stream.body.concat()
        } else {
            Vec::new()
        };
        if has_body {
            req = req.header("content-length", body_bytes.len());
        }
        let req = req
            .body(http_body_util::Full::new(hyper::body::Bytes::from(
                body_bytes,
            )))
            .context("build request")?;

        let tcp = tokio::net::TcpStream::connect(("127.0.0.1", self.port))
            .await
            .context("connect local port")?;
        let io = hyper_util::rt::TokioIo::new(tcp);
        let (mut sender, conn) = hyper::client::conn::http1::handshake(io).await?;
        tokio::spawn(async move {
            let _ = conn.await;
        });
        let res = sender.send_request(req).await.context("local request")?;

        let mut headers = serde_json::Map::new();
        for (k, v) in res.headers() {
            let lk = k.as_str().to_lowercase();
            if !HOP_BY_HOP.contains(&lk.as_str()) {
                if let Ok(v) = v.to_str() {
                    headers.insert(k.as_str().to_string(), Value::String(v.to_string()));
                }
            }
        }
        let status = res.status();
        self.send_frame(encode_json(
            Op::HttpResHead,
            stream_id,
            &json!({
                "status": status.as_u16(),
                "statusText": status.canonical_reason().unwrap_or(""),
                "headers": headers,
            }),
        ))
        .await;

        let mut body = res.into_body();
        while let Some(next) = body.frame().await {
            let frame = next.context("read local body")?;
            if let Some(data) = frame.data_ref() {
                for part in data.chunks(MAX_CHUNK) {
                    self.send_frame(encode_frame(Op::HttpResBody, stream_id, part))
                        .await;
                }
            }
        }
        self.send_frame(encode_frame(Op::HttpResEnd, stream_id, &[]))
            .await;
        Ok(())
    }

    // -- WebSocket bridge --
    async fn open_ws(self: &Arc<Self>, stream_id: u32, info: Value) {
        let path = info.get("path").and_then(|v| v.as_str()).unwrap_or("/");
        let url = format!("ws://127.0.0.1:{}{}", self.port, path);
        let mut req = match url.clone().into_client_request() {
            Ok(r) => r,
            Err(e) => {
                self.send_frame(encode_json(
                    Op::WsOpenAck,
                    stream_id,
                    &json!({ "ok": false, "error": e.to_string() }),
                ))
                .await;
                return;
            }
        };
        if let Some(protocols) = info.get("protocols").and_then(|p| p.as_array()) {
            let joined = protocols
                .iter()
                .filter_map(|p| p.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            if !joined.is_empty() {
                if let Ok(v) = joined.parse() {
                    req.headers_mut().insert("Sec-WebSocket-Protocol", v);
                }
            }
        }
        let (ws, resp) = match tokio_tungstenite::connect_async(req).await {
            Ok(ok) => ok,
            Err(e) => {
                self.send_frame(encode_json(
                    Op::WsOpenAck,
                    stream_id,
                    &json!({ "ok": false, "error": e.to_string() }),
                ))
                .await;
                return;
            }
        };
        let protocol = resp
            .headers()
            .get("Sec-WebSocket-Protocol")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let (mut sink, mut stream) = ws.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
        self.ws_conns.lock().await.insert(stream_id, tx);
        self.send_frame(encode_json(
            Op::WsOpenAck,
            stream_id,
            &json!({ "ok": true, "protocol": protocol }),
        ))
        .await;

        // writer: tunnel → local ws
        tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                let closing = matches!(msg, Message::Close(_));
                if sink.send(msg).await.is_err() || closing {
                    break;
                }
            }
        });
        // reader: local ws → tunnel
        let this = self.clone();
        tokio::spawn(async move {
            let mut close_sent = false;
            while let Some(msg) = stream.next().await {
                match msg {
                    Ok(Message::Text(t)) => {
                        for frame in ws_message_frames(Op::WsText, stream_id, t.as_bytes()) {
                            this.send_frame(frame).await;
                        }
                    }
                    Ok(Message::Binary(b)) => {
                        for frame in ws_message_frames(Op::WsBin, stream_id, &b) {
                            this.send_frame(frame).await;
                        }
                    }
                    Ok(Message::Close(frame)) => {
                        let (code, reason) = frame
                            .map(|f| (u16::from(f.code), f.reason.to_string()))
                            .unwrap_or((1005, String::new()));
                        this.send_frame(encode_json(
                            Op::WsClose,
                            stream_id,
                            &json!({ "code": code, "reason": reason }),
                        ))
                        .await;
                        close_sent = true;
                        break;
                    }
                    Err(_) => {
                        this.send_frame(encode_json(
                            Op::WsClose,
                            stream_id,
                            &json!({ "code": 1006, "reason": "error" }),
                        ))
                        .await;
                        close_sent = true;
                        break;
                    }
                    _ => {}
                }
            }
            if !close_sent {
                this.send_frame(encode_json(
                    Op::WsClose,
                    stream_id,
                    &json!({ "code": 1006, "reason": "error" }),
                ))
                .await;
            }
            this.ws_conns.lock().await.remove(&stream_id);
        });
    }
}

// ---- one exposure: relay dial-out + reconnect loop --------------------------

struct Exposure {
    id: String,
    port: u16,
    url: String,
    public_host: String,
    created_at: i64,
    /// Control-JSON sender on the LIVE relay socket (None between reconnects).
    ctl: Arc<StdMutex<Option<mpsc::UnboundedSender<Message>>>>,
    cancel: watch::Sender<bool>,
}

impl Exposure {
    /// Mint a fresh single-use claim link and register its hash with the relay.
    fn mint_claim(&self) -> String {
        use rand::RngCore;
        let mut token_bytes = [0u8; 18];
        rand::thread_rng().fill_bytes(&mut token_bytes);
        let token = base64url(&token_bytes);
        let hash = hex::encode(Sha256::digest(token.as_bytes()));
        if let Some(tx) = self.ctl.lock().unwrap().as_ref() {
            let _ = tx.send(Message::Text(
                json!({ "t": "claim", "claims": [hash] }).to_string().into(),
            ));
        }
        format!("https://{}/_ay/claim?t={token}", self.public_host)
    }

    fn info_json(&self) -> Value {
        json!({ "id": self.id, "port": self.port, "url": self.url, "createdAt": self.created_at })
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Split a relay URL into (ws scheme, host[:port]).
fn relay_parts(relay: &str) -> Result<(&'static str, String)> {
    let (scheme, rest) = relay
        .split_once("://")
        .ok_or_else(|| anyhow!("bad relay url: {relay}"))?;
    let host = rest.split('/').next().unwrap_or("").to_string();
    if host.is_empty() {
        bail!("bad relay url: {relay}");
    }
    Ok((if scheme == "http" { "ws" } else { "wss" }, host))
}

#[allow(clippy::too_many_arguments)] // one call site; a params struct would just rename these
async fn connect_relay(
    ws_scheme: &str,
    relay_host: &str,
    id: &str,
    key: &str,
    port: u16,
    ctl: &Arc<StdMutex<Option<mpsc::UnboundedSender<Message>>>>,
    cancel: &mut watch::Receiver<bool>,
    on_ready: &mut Option<oneshot::Sender<Result<()>>>,
) -> Result<RelayEnd> {
    let url = format!("{ws_scheme}://{relay_host}/_ay/tunnel/{id}");
    let req = url.into_client_request()?;
    let (ws, _resp) = tokio_tungstenite::connect_async(req)
        .await
        .context("relay connect")?;
    let (mut sink, mut stream) = ws.split();

    // Control JSON (hello/ping/claim) stays unbounded so sync mint_claim never
    // blocks; tunnel data frames ride a bounded queue (~4MB) for backpressure.
    let (ctl_tx, mut ctl_rx) = mpsc::unbounded_channel::<Message>();
    let (data_tx, mut data_rx) = mpsc::channel::<Message>(64);
    let _ = ctl_tx.send(Message::Text(
        json!({ "t": "hello", "key": key, "port": port, "v": 1 })
            .to_string()
            .into(),
    ));

    let host = TunnelHost::new(port, data_tx.clone());
    let mut ping = tokio::time::interval(Duration::from_millis(PING_MS));
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ping.tick().await; // fires immediately; skip
    let mut ready = false;

    let end = loop {
        tokio::select! {
            _ = cancel.changed() => {
                if *cancel.borrow() {
                    let _ = sink.close().await;
                    break RelayEnd::Cancelled;
                }
            }
            _ = ping.tick() => {
                let _ = ctl_tx.send(Message::Text("ping".into()));
            }
            Some(msg) = ctl_rx.recv() => {
                if sink.send(msg).await.is_err() {
                    break RelayEnd::Dropped { ready };
                }
            }
            Some(msg) = data_rx.recv() => {
                if sink.send(msg).await.is_err() {
                    break RelayEnd::Dropped { ready };
                }
            }
            msg = stream.next() => {
                let Some(msg) = msg else { break RelayEnd::Dropped { ready } };
                match msg {
                    Ok(Message::Text(t)) => {
                        // The tunnel only accepts binary frames; text is control JSON.
                        if let Ok(v) = serde_json::from_str::<Value>(&t) {
                            if v.get("t").and_then(|t| t.as_str()) == Some("ready") && !ready {
                                ready = true;
                                // Only NOW is the socket usable for claims — and only
                                // now may the caller consider the exposure live.
                                *ctl.lock().unwrap() = Some(ctl_tx.clone());
                                if let Some(tx) = on_ready.take() {
                                    let _ = tx.send(Ok(()));
                                }
                            }
                        }
                    }
                    Ok(Message::Binary(b)) => host.on_frame(&b).await,
                    Ok(Message::Close(frame)) => {
                        if frame.map(|f| u16::from(f.code) == 1008).unwrap_or(false) {
                            break RelayEnd::Refused;
                        }
                        break RelayEnd::Dropped { ready };
                    }
                    Err(_) => break RelayEnd::Dropped { ready },
                    _ => {}
                }
            }
        }
    };
    *ctl.lock().unwrap() = None;
    // host.ts closeAll: tear down every bridged local socket so the next relay
    // connection starts clean instead of leaking the previous generation.
    host.close_all().await;
    Ok(end)
}

enum RelayEnd {
    /// Relay refused (1008) — bad key; fatal.
    Refused,
    Dropped {
        ready: bool,
    },
    Cancelled,
}

// ---- in-process manager (POST /api/expose) ----------------------------------

fn manager() -> &'static Mutex<HashMap<u16, Arc<Exposure>>> {
    static ACTIVE: std::sync::OnceLock<Mutex<HashMap<u16, Arc<Exposure>>>> =
        std::sync::OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Start an exposure for `port` (or reuse a running one). Resolves once the
/// relay has accepted the daemon; errors if the relay refuses (bad key).
pub async fn ensure(port: u16, relay: Option<&str>) -> Result<Value> {
    let active = manager().lock().await;
    if let Some(h) = active.get(&port) {
        let mut v = h.info_json();
        v["claim"] = Value::String(h.mint_claim());
        return Ok(v);
    }

    let relay = relay.unwrap_or(DEFAULT_RELAY);
    let (ws_scheme, relay_host) = relay_parts(relay)?;
    let (id, key) = load_or_create_exposure(&relay_host, port);
    // Public hostname: <id>.<zone> on the real relay; the relay host itself
    // (Host-header spoof) when pointing at a dev relay.
    let public_host = if relay_host == "agent-yes.com" {
        format!("{id}.agent-yes.com")
    } else {
        relay_host.clone()
    };
    let (cancel_tx, mut cancel_rx) = watch::channel(false);
    let ctl = Arc::new(StdMutex::new(None));
    let exposure = Arc::new(Exposure {
        id: id.clone(),
        port,
        url: format!("https://{public_host}/"),
        public_host,
        created_at: now_ms(),
        ctl: ctl.clone(),
        cancel: cancel_tx,
    });

    let (ready_tx, ready_rx) = oneshot::channel::<Result<()>>();
    {
        let key = key.clone();
        let ctl = ctl.clone();
        let relay_host = relay_host.clone();
        tokio::spawn(async move {
            let mut ready_tx: Option<oneshot::Sender<Result<()>>> = Some(ready_tx);
            let mut backoff = RECONNECT_MIN_MS;
            loop {
                if *cancel_rx.borrow() {
                    break;
                }
                match connect_relay(
                    ws_scheme,
                    &relay_host,
                    &id,
                    &key,
                    port,
                    &ctl,
                    &mut cancel_rx,
                    &mut ready_tx,
                )
                .await
                {
                    Ok(RelayEnd::Cancelled) => break,
                    Ok(RelayEnd::Refused) => {
                        if let Some(tx) = ready_tx.take() {
                            let _ = tx.send(Err(anyhow!("relay refused exposure (forbidden)")));
                        } else {
                            eprintln!("[ayrs expose] relay refused exposure {id} — stopping");
                        }
                        break;
                    }
                    Ok(RelayEnd::Dropped { ready }) => {
                        if ready {
                            backoff = RECONNECT_MIN_MS;
                        }
                        tokio::select! {
                            _ = cancel_rx.changed() => {}
                            _ = tokio::time::sleep(Duration::from_millis(backoff)) => {}
                        }
                        backoff = (backoff * 2).min(RECONNECT_MAX_MS);
                    }
                    Err(e) => {
                        eprintln!("[ayrs expose] relay connect failed: {e:#}");
                        tokio::select! {
                            _ = cancel_rx.changed() => {}
                            _ = tokio::time::sleep(Duration::from_millis(backoff)) => {}
                        }
                        backoff = (backoff * 2).min(RECONNECT_MAX_MS);
                    }
                }
            }
            *ctl.lock().unwrap() = None;
        });
    }
    // NOTE: connect_relay only returns after Ready when the connection later
    // ends, so "first Ready" is signalled by the ctl slot being live. Wait for
    // either the oneshot (refused / first drop-after-ready) or the ctl slot.
    drop(active); // don't hold the manager lock across the await
    let ok = wait_ready(ready_rx).await;
    match ok {
        Ok(()) => {
            let mut v = exposure.info_json();
            v["claim"] = Value::String(exposure.mint_claim());
            manager().lock().await.insert(port, exposure);
            Ok(v)
        }
        Err(e) => {
            let _ = exposure.cancel.send(true);
            Err(e)
        }
    }
}

/// Resolve once the relay accepted us (connect_relay fires the oneshot on the
/// "ready" control message) or the dial task reported a fatal refuse; time-box
/// it so a black-holed relay can't hang the HTTP route forever.
async fn wait_ready(mut ready_rx: oneshot::Receiver<Result<()>>) -> Result<()> {
    match tokio::time::timeout(Duration::from_secs(15), &mut ready_rx).await {
        Ok(Ok(r)) => r,
        Ok(Err(_)) => bail!("expose task exited before ready"),
        Err(_) => bail!("relay did not accept within 15s"),
    }
}

pub async fn list() -> Value {
    let active = manager().lock().await;
    let mut rows: Vec<&Arc<Exposure>> = active.values().collect();
    rows.sort_by_key(|h| -h.created_at);
    Value::Array(rows.into_iter().map(|h| h.info_json()).collect())
}

pub async fn stop(port: u16) -> bool {
    match manager().lock().await.remove(&port) {
        Some(h) => {
            let _ = h.cancel.send(true);
            true
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_roundtrip() {
        let f = encode_frame(Op::HttpResBody, 0xdead_beef, b"hello");
        let d = decode_frame(&f).unwrap();
        assert_eq!(d.op, Op::HttpResBody);
        assert_eq!(d.stream_id, 0xdead_beef);
        assert_eq!(d.payload, b"hello");
    }

    #[test]
    fn ws_frames_split_and_terminate() {
        let big = vec![7u8; MAX_CHUNK * 2 + 10];
        let frames = ws_message_frames(Op::WsBin, 3, &big);
        assert_eq!(frames.len(), 3);
        let ops: Vec<Op> = frames.iter().map(|f| decode_frame(f).unwrap().op).collect();
        assert_eq!(ops, vec![Op::WsCont, Op::WsCont, Op::WsBin]);
        let total: usize = frames
            .iter()
            .map(|f| decode_frame(f).unwrap().payload.len())
            .sum();
        assert_eq!(total, big.len());
        // small messages stay a single terminal frame (back-compatible)
        let small = ws_message_frames(Op::WsText, 4, b"hi");
        assert_eq!(small.len(), 1);
        assert_eq!(decode_frame(&small[0]).unwrap().op, Op::WsText);
    }

    // base64url vectors pinned from node Buffer.toString("base64url").
    #[test]
    fn base64url_matches_node() {
        assert_eq!(base64url(b""), "");
        assert_eq!(base64url(b"f"), "Zg");
        assert_eq!(base64url(b"fo"), "Zm8");
        assert_eq!(base64url(b"foo"), "Zm9v");
        assert_eq!(base64url(&[0xfb, 0xff, 0xfe]), "-__-");
    }

    #[test]
    fn exposure_slot_is_stable() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("exposures.json");
        let (id1, key1) = load_or_create_exposure_at(&file, "agent-yes.com", 3000);
        let (id2, key2) = load_or_create_exposure_at(&file, "agent-yes.com", 3000);
        assert_eq!(id1, id2);
        assert_eq!(key1, key2);
        assert!(id1.starts_with('x') && id1.len() == 16, "{id1}");
        assert_eq!(key1.len(), 64);
        let (id3, _) = load_or_create_exposure_at(&file, "agent-yes.com", 3001);
        assert_ne!(id1, id3);
    }

    #[test]
    fn relay_parts_schemes() {
        assert_eq!(
            relay_parts("https://agent-yes.com").unwrap(),
            ("wss", "agent-yes.com".into())
        );
        assert_eq!(
            relay_parts("http://localhost:8788").unwrap(),
            ("ws", "localhost:8788".into())
        );
        assert!(relay_parts("agent-yes.com").is_err());
    }
}
