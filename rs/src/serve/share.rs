// `ayrs serve --webrtc` host peer — Rust port of ts/share.ts. Connects to the
// signaling server as a room host and bridges each browser peer's WebRTC
// DataChannel to the native API handler (serve/api.rs), no HTTP port needed.
//
// Coexistence: the room persists in `~/.agent-yes/.share-room-ayrs` — a
// DIFFERENT file from the TS daemon's `.share-room` — so the Rust host never
// steals the signaling room out from under a running `ay serve --webrtc`.
use super::agent_share::Scope;
use super::api;
use super::e2e;
use anyhow::{anyhow, bail, Context, Result};
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, watch, Mutex};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;
use webrtc::api::APIBuilder;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::data_channel::RTCDataChannel;
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;

const SUB: &str = "ay-signal-1";
pub const DEFAULT_SIGHOST: &str = "s.agent-yes.com";
const HOST_HEARTBEAT_MS: u64 = 20_000;
const SIG_REFRESH_MS: u64 = 4 * 60_000;
const STUN_URL: &str = "stun:stun.l.google.com:19302";
const MAX_ROTATES: u32 = 5;

fn global_dir() -> PathBuf {
    if let Ok(h) = std::env::var("AGENT_YES_HOME") {
        return PathBuf::from(h);
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".agent-yes")
}

fn share_room_path() -> PathBuf {
    global_dir().join(".share-room-ayrs")
}

pub struct RoomUrl {
    pub room: String,
    pub token: String, // "e1.<64hex>"
    pub host: String,
}

pub fn format_room_url(room: &RoomUrl) -> String {
    format!("webrtc://{}:{}@{}", room.room, room.token, room.host)
}

pub fn parse_share_url(s: &str) -> Result<RoomUrl> {
    // webrtc://room:token@host
    let rest = s
        .strip_prefix("webrtc://")
        .ok_or_else(|| anyhow!("bad --webrtc url: {s} (want webrtc://room:token@host)"))?;
    let (roomtok, host) = rest
        .rsplit_once('@')
        .ok_or_else(|| anyhow!("bad --webrtc url: missing @host"))?;
    let (room, token) = roomtok
        .split_once(':')
        .ok_or_else(|| anyhow!("bad --webrtc url: missing :token"))?;
    if room.is_empty() || token.is_empty() || host.is_empty() {
        bail!("bad --webrtc url: {s}");
    }
    Ok(RoomUrl {
        room: room.into(),
        token: token.into(),
        host: host.into(),
    })
}

pub(super) fn mint_room(host: &str) -> RoomUrl {
    RoomUrl {
        room: format!("r{}", e2e::random_hex(6)),
        token: format!("{}{}", e2e::MARKER, e2e::random_hex(32)),
        host: host.to_string(),
    }
}

fn persist_room(r: &RoomUrl) {
    let _ = std::fs::create_dir_all(global_dir());
    let url = format_room_url(r);
    let _ = std::fs::write(share_room_path(), &url);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(share_room_path(), std::fs::Permissions::from_mode(0o600));
    }
}

pub fn load_or_create_room(sighost: &str) -> RoomUrl {
    if let Ok(url) = std::fs::read_to_string(share_room_path()) {
        if let Ok(r) = parse_share_url(url.trim()) {
            if r.token.starts_with(e2e::MARKER) {
                return r;
            }
        }
    }
    let r = mint_room(sighost);
    persist_room(&r);
    r
}

/// The browser console URL for a room (mirrors ts/share.ts formatShareLink).
pub fn format_share_link(room: &str, s: &str, host: &str) -> String {
    if host == DEFAULT_SIGHOST {
        format!("https://agent-yes.com/w/#{room}:{}{s}", e2e::MARKER)
    } else {
        format!("http://localhost:7778/w/#{room}:{}{s}@{host}", e2e::MARKER)
    }
}

/// Resolve the exact room and browser link an installed service will use.
pub fn resolve_share_urls(url: Option<&str>, sighost: &str) -> Result<(String, String)> {
    let room = match url {
        Some(url) if !url.is_empty() => parse_share_url(url)?,
        _ => load_or_create_room(sighost),
    };
    let (secret, encrypted) = e2e::parse_secret(&room.token)?;
    if !encrypted {
        bail!("refusing to host an unencrypted room");
    }
    let browser_url = format_share_link(&room.room, &secret, &room.host);
    Ok((format_room_url(&room), browser_url))
}

// ---- per-peer state ----------------------------------------------------------

struct Peer {
    pc: Arc<RTCPeerConnection>,
    /// Sealed-frame sender task input: (flags, envelope). Sealing is serialized
    /// by the single sender task so wire order == counter order.
    out_tx: mpsc::UnboundedSender<(u8, Value)>,
    /// Raw offer SDP as sent to the browser (transcript-hash input).
    offer_sdp: String,
    /// In-flight request tasks by envelope id, for {t:"abort"}.
    reqs: HashMap<String, tokio::task::JoinHandle<()>>,
    crypto: Option<Arc<PeerCrypto>>,
    recv: e2e::RecvState,
    my_nonce: String,
    confirmed_in: bool,
    confirmed_out: bool,
    confirmed: bool,
}

struct PeerCrypto {
    keys: e2e::DirKeys,
    th: [u8; 32],
}

type Peers = Arc<Mutex<HashMap<String, Peer>>>;

/// Messages from callbacks/tasks back to the signaling writer.
enum SigOut {
    Send(String),
}

pub struct ShareConfig {
    pub url: Option<String>,
    pub sighost: String,
}

/// Path of the advisory lock recording which pid is hosting a given room.
fn room_lock_path(room: &str) -> std::path::PathBuf {
    global_dir().join(format!(".share-host-{room}.pid"))
}

/// Two `ayrs` hosts in the same signaling room both answer every `peer-join`,
/// so each viewer's answer reaches the host that did *not* originate the offer
/// and blows up with "invalid proposed signaling state transition from stable".
/// Nothing recovers from that — the room just stops accepting viewers — so
/// refuse to start rather than degrade the room that's already working.
fn claim_room(room: &str) -> Result<()> {
    claim_room_at(&room_lock_path(room), room)
}

fn claim_room_at(path: &std::path::Path, room: &str) -> Result<()> {
    if let Ok(txt) = std::fs::read_to_string(path) {
        if let Ok(pid) = txt.trim().parse::<i32>() {
            if pid != std::process::id() as i32 && crate::pid_store::is_process_alive(pid as u32) {
                bail!(
                    "another ayrs host (pid {pid}) is already serving room {room}\n\
                     running two hosts in one room breaks WebRTC answering for every viewer.\n\
                     stop it first (`ayrs serve uninstall`, or kill {pid}), or host a different room."
                );
            }
        }
    }
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p).ok();
    }
    std::fs::write(path, std::process::id().to_string()).ok();
    Ok(())
}

#[cfg(test)]
mod claim_tests {
    use super::*;

    #[test]
    fn claims_a_free_room_and_records_our_pid() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("lock.pid");
        claim_room_at(&p, "r1").unwrap();
        assert_eq!(
            std::fs::read_to_string(&p).unwrap(),
            std::process::id().to_string()
        );
    }

    #[test]
    fn takes_over_a_room_held_by_a_dead_pid() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("lock.pid");
        // pid 1 is alive but is not us; use an implausibly high dead pid instead.
        std::fs::write(&p, "4194303").unwrap();
        claim_room_at(&p, "r1").unwrap();
        assert_eq!(
            std::fs::read_to_string(&p).unwrap(),
            std::process::id().to_string()
        );
    }

    #[test]
    fn refuses_a_room_held_by_a_live_pid() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("lock.pid");
        // A real live process that isn't us (pid 1 is unusable: kill(1,0) is
        // EPERM for a normal user, which reads as "dead").
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .unwrap();
        std::fs::write(&p, child.id().to_string()).unwrap();
        let err = claim_room_at(&p, "r1").unwrap_err().to_string();
        let _ = child.kill();
        assert!(err.contains("already serving room r1"), "{err}");
    }

    #[test]
    fn reclaiming_our_own_room_is_a_no_op() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("lock.pid");
        claim_room_at(&p, "r1").unwrap();
        claim_room_at(&p, "r1").unwrap();
    }
}

pub async fn run_share(cfg: ShareConfig) -> Result<()> {
    let explicit = cfg.url.is_some();
    let mut room = match &cfg.url {
        Some(u) => parse_share_url(u)?,
        None => load_or_create_room(&cfg.sighost),
    };
    let (s, v2) = e2e::parse_secret(&room.token)?;
    if !v2 {
        bail!(
            "refusing to host an unencrypted room — delete ~/.agent-yes/.share-room-ayrs to rotate"
        );
    }
    let mut secret = s;
    claim_room(&room.room)?;
    let api_token = api::load_or_create_token().context("serve token")?;

    let peers: Peers = Arc::new(Mutex::new(HashMap::new()));
    let mut rotates = 0u32;

    let link = format_share_link(&room.room, &secret, &room.host);
    eprintln!("[ayrs share] room {} via {}", room.room, room.host);
    println!("{link}");

    // The master room never cancels; the dummy sender stays alive for the loop.
    let (_cancel_tx, cancel_rx) = watch::channel(false);
    let scope = Arc::new(Scope::Full);
    loop {
        match connect_once(
            &room,
            &secret,
            &api_token,
            peers.clone(),
            scope.clone(),
            cancel_rx.clone(),
        )
        .await
        {
            Ok(SessionEnd::Refresh) => {
                // periodic re-hello (see ts/share.ts SIG_REFRESH_MS rationale)
                continue;
            }
            Ok(SessionEnd::Rejected) => {
                if explicit || rotates >= MAX_ROTATES {
                    bail!("room rejected by signaling server (1008) — delete ~/.agent-yes/.share-room-ayrs to rotate");
                }
                rotates += 1;
                room = mint_room(&room.host);
                secret = e2e::parse_secret(&room.token)?.0;
                persist_room(&room);
                claim_room(&room.room)?;
                let link = format_share_link(&room.room, &secret, &room.host);
                eprintln!("[ayrs share] room rotated: {link}");
            }
            Ok(SessionEnd::Cancelled) => unreachable!("master room has no canceller"),
            Ok(SessionEnd::Dropped) => {
                tokio::time::sleep(Duration::from_millis(1000)).await;
            }
            Err(e) => {
                eprintln!("[ayrs share] signaling error: {e:#}");
                tokio::time::sleep(Duration::from_millis(2000)).await;
            }
        }
    }
}

/// One scoped-share room (ts/agentShare.ts createScopedShare's startShare call):
/// fresh unpersisted room, no claim lock, no rotation — a 1008 reject is fatal
/// for the share rather than rotated, since the link was already handed out.
/// Runs until `cancel` flips (revoke / TTL expiry), then closes every peer so
/// browsers see an immediate DataChannel close.
pub async fn run_scoped_session(
    room: String,
    secret: String,
    sighost: String,
    scope: Arc<Scope>,
    mut cancel: watch::Receiver<bool>,
) {
    let room = RoomUrl {
        room,
        token: String::new(), // auth derives from the secret; token is unused here
        host: sighost,
    };
    let peers: Peers = Arc::new(Mutex::new(HashMap::new()));
    loop {
        if *cancel.borrow() {
            break;
        }
        match connect_once(
            &room,
            &secret,
            "",
            peers.clone(),
            scope.clone(),
            cancel.clone(),
        )
        .await
        {
            Ok(SessionEnd::Refresh) => continue,
            Ok(SessionEnd::Cancelled) => break,
            Ok(SessionEnd::Rejected) => {
                eprintln!("[ayrs share] scoped room {} rejected by signaling server — share is dead until revoked/re-minted", room.room);
                break;
            }
            Ok(SessionEnd::Dropped) => {
                tokio::select! {
                    _ = cancel.changed() => {}
                    _ = tokio::time::sleep(Duration::from_millis(1000)) => {}
                }
            }
            Err(e) => {
                eprintln!("[ayrs share] scoped signaling error: {e:#}");
                tokio::select! {
                    _ = cancel.changed() => {}
                    _ = tokio::time::sleep(Duration::from_millis(2000)) => {}
                }
            }
        }
    }
    let ids: Vec<String> = peers.lock().await.keys().cloned().collect();
    for id in ids {
        close_peer(&peers, &id).await;
    }
}

enum SessionEnd {
    Refresh,
    Rejected,
    Dropped,
    Cancelled,
}

async fn connect_once(
    room: &RoomUrl,
    secret: &str,
    api_token: &str,
    peers: Peers,
    scope: Arc<Scope>,
    mut cancel: watch::Receiver<bool>,
) -> Result<SessionEnd> {
    let scheme = if room.host.starts_with("localhost") || room.host.starts_with("127.") {
        "ws"
    } else {
        "wss"
    };
    let url = format!("{scheme}://{}/{}", room.host, room.room);
    let mut req = url.clone().into_client_request()?;
    req.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        SUB.parse().expect("static subprotocol header"),
    );
    let (ws, _resp) = tokio_tungstenite::connect_async(req)
        .await
        .context("ws connect")?;
    let (mut sink, mut stream) = ws.split();

    let auth_token = e2e::derive_auth_token(secret, &room.room, &room.host)?;
    sink.send(Message::Text(
        json!({"type": "hello", "role": "host", "v": 2, "token": auth_token})
            .to_string()
            .into(),
    ))
    .await?;

    // signaling writer fan-in: peer tasks (ICE candidates, offers) → socket
    let (sig_tx, mut sig_rx) = mpsc::unbounded_channel::<SigOut>();

    let mut hb = tokio::time::interval(Duration::from_millis(HOST_HEARTBEAT_MS));
    hb.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let refresh = tokio::time::sleep(Duration::from_millis(SIG_REFRESH_MS));
    tokio::pin!(refresh);
    let mut last_recv = std::time::Instant::now();

    loop {
        tokio::select! {
            _ = cancel.changed() => {
                if *cancel.borrow() {
                    let _ = sink.close().await;
                    return Ok(SessionEnd::Cancelled);
                }
            }
            _ = &mut refresh => {
                let _ = sink.close().await;
                return Ok(SessionEnd::Refresh);
            }
            _ = hb.tick() => {
                if last_recv.elapsed() > Duration::from_millis(HOST_HEARTBEAT_MS * 2 + 5000) {
                    let _ = sink.close().await;
                    return Ok(SessionEnd::Dropped);
                }
                let _ = sink.send(Message::Text(json!({"type":"ping"}).to_string().into())).await;
            }
            Some(out) = sig_rx.recv() => {
                match out {
                    SigOut::Send(text) => { let _ = sink.send(Message::Text(text.into())).await; }
                }
            }
            msg = stream.next() => {
                let Some(msg) = msg else { return Ok(SessionEnd::Dropped) };
                let msg = match msg {
                    Ok(m) => m,
                    Err(_) => return Ok(SessionEnd::Dropped),
                };
                last_recv = std::time::Instant::now();
                match msg {
                    Message::Close(frame) => {
                        if frame.map(|f| u16::from(f.code) == 1008).unwrap_or(false) {
                            return Ok(SessionEnd::Rejected);
                        }
                        return Ok(SessionEnd::Dropped);
                    }
                    Message::Text(t) => {
                        let Ok(m) = serde_json::from_str::<Value>(&t) else { continue };
                        handle_signal(m, secret, api_token, &peers, &sig_tx, &scope).await;
                    }
                    _ => {}
                }
            }
        }
    }
}

async fn handle_signal(
    m: Value,
    secret: &str,
    api_token: &str,
    peers: &Peers,
    sig_tx: &mpsc::UnboundedSender<SigOut>,
    scope: &Arc<Scope>,
) {
    match m.get("type").and_then(|t| t.as_str()) {
        Some("pong") | Some("welcome") => {}
        Some("peer-join") => {
            let Some(peer_id) = m.get("peer").map(value_to_id) else {
                return;
            };
            if peers.lock().await.contains_key(&peer_id) {
                return;
            }
            eprintln!("[ayrs share] peer-join {peer_id}");
            if let Err(e) =
                start_peer(peer_id.clone(), api_token, peers, sig_tx, scope.clone()).await
            {
                eprintln!("[ayrs share] peer setup failed: {e:#}");
                close_peer(peers, &peer_id).await;
            }
        }
        Some("answer") => {
            let Some(from) = m.get("from").map(value_to_id) else {
                return;
            };
            let sdp = m
                .get("sdp")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string();
            if let Err(e) = on_answer(&from, sdp, secret, peers).await {
                eprintln!("[ayrs share] answer failed for {from}: {e:#}");
                close_peer(peers, &from).await;
            }
        }
        Some("candidate") => {
            let Some(from) = m.get("from").map(value_to_id) else {
                return;
            };
            let Some(cand) = m.get("candidate") else {
                return;
            };
            let init: RTCIceCandidateInit = match serde_json::from_value(cand.clone()) {
                Ok(c) => c,
                Err(_) => return,
            };
            let pc = {
                let map = peers.lock().await;
                map.get(&from).map(|p| p.pc.clone())
            };
            if let Some(pc) = pc {
                let _ = pc.add_ice_candidate(init).await;
            }
        }
        Some("peer-leave") => {
            if let Some(peer) = m.get("peer").map(value_to_id) {
                close_peer(peers, &peer).await;
            }
        }
        _ => {}
    }
}

pub(super) fn value_to_id(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

async fn close_peer(peers: &Peers, peer_id: &str) {
    let removed = peers.lock().await.remove(peer_id);
    if let Some(p) = removed {
        for (_, h) in p.reqs {
            h.abort();
        }
        let _ = p.pc.close().await;
    }
}

async fn start_peer(
    peer_id: String,
    api_token: &str,
    peers: &Peers,
    sig_tx: &mpsc::UnboundedSender<SigOut>,
    scope: Arc<Scope>,
) -> Result<()> {
    let api = APIBuilder::new().build();
    let config = RTCConfiguration {
        ice_servers: vec![RTCIceServer {
            urls: vec![STUN_URL.to_string()],
            ..Default::default()
        }],
        ..Default::default()
    };
    let pc = Arc::new(api.new_peer_connection(config).await?);

    // trickle ICE → signaling writer
    {
        let sig_tx = sig_tx.clone();
        let peer_id = peer_id.clone();
        pc.on_ice_candidate(Box::new(move |c| {
            let sig_tx = sig_tx.clone();
            let peer_id = peer_id.clone();
            Box::pin(async move {
                if let Some(c) = c {
                    if let Ok(init) = c.to_json() {
                        if let Ok(cand) = serde_json::to_value(&init) {
                            let _ = sig_tx.send(SigOut::Send(
                                json!({"type":"candidate","to":peer_id,"candidate":cand})
                                    .to_string(),
                            ));
                        }
                    }
                }
            })
        }));
    }

    // dead-peer cleanup
    {
        let peers2 = peers.clone();
        let peer_id = peer_id.clone();
        pc.on_peer_connection_state_change(Box::new(move |st| {
            let peers2 = peers2.clone();
            let peer_id = peer_id.clone();
            Box::pin(async move {
                if matches!(
                    st,
                    RTCPeerConnectionState::Failed
                        | RTCPeerConnectionState::Closed
                        | RTCPeerConnectionState::Disconnected
                ) {
                    close_peer(&peers2, &peer_id).await;
                }
            })
        }));
    }

    let dc = pc.create_data_channel("api", None).await?;

    // sealed-frame sender task: (flags, envelope) → seal in order → dc.send
    let (out_tx, out_rx) = mpsc::unbounded_channel::<(u8, Value)>();
    spawn_sender(dc.clone(), out_rx, peers.clone(), peer_id.clone());

    // inbound frames → per-peer handler (serialized by the channel)
    let (in_tx, in_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    {
        let in_tx = in_tx.clone();
        dc.on_message(Box::new(move |msg: DataChannelMessage| {
            let in_tx = in_tx.clone();
            Box::pin(async move {
                if !msg.is_string {
                    let _ = in_tx.send(msg.data.to_vec());
                }
            })
        }));
    }
    spawn_receiver(
        peers.clone(),
        peer_id.clone(),
        in_rx,
        api_token.to_string(),
        scope,
    );

    // on open: start the mandatory key-confirmation handshake
    {
        let peers2 = peers.clone();
        let peer_id2 = peer_id.clone();
        dc.on_open(Box::new(move || {
            let peers2 = peers2.clone();
            let peer_id2 = peer_id2.clone();
            Box::pin(async move {
                let mut map = peers2.lock().await;
                if let Some(p) = map.get_mut(&peer_id2) {
                    let nonce = p.my_nonce.clone();
                    let _ = p
                        .out_tx
                        .send((e2e::FLAG_CONFIRM, json!({"t":"confirm","nonce":nonce})));
                }
                drop(map);
                // confirm deadline: close the peer if the handshake stalls
                tokio::time::sleep(Duration::from_millis(e2e::CONFIRM_TIMEOUT_MS)).await;
                let confirmed = peers2
                    .lock()
                    .await
                    .get(&peer_id2)
                    .map(|p| p.confirmed)
                    .unwrap_or(true);
                if !confirmed {
                    close_peer(&peers2, &peer_id2).await;
                }
            })
        }));
    }

    let offer = pc.create_offer(None).await?;
    let offer_sdp = offer.sdp.clone();
    pc.set_local_description(offer).await?;

    peers.lock().await.insert(
        peer_id.clone(),
        Peer {
            pc: pc.clone(),
            out_tx,
            offer_sdp: offer_sdp.clone(),
            reqs: HashMap::new(),
            crypto: None,
            recv: e2e::RecvState { last_seen: None },
            my_nonce: e2e::random_hex(16),
            confirmed_in: false,
            confirmed_out: false,
            confirmed: false,
        },
    );

    let ice_servers = json!([{ "urls": STUN_URL }]);
    let _ = sig_tx.send(SigOut::Send(
        json!({"type":"offer","to":peer_id,"sdp":offer_sdp,"iceServers":ice_servers}).to_string(),
    ));
    Ok(())
}

async fn on_answer(peer_id: &str, sdp: String, secret: &str, peers: &Peers) -> Result<()> {
    let (pc, offer_sdp) = {
        let map = peers.lock().await;
        let p = map.get(peer_id).ok_or_else(|| anyhow!("unknown peer"))?;
        (p.pc.clone(), p.offer_sdp.clone())
    };
    let answer = RTCSessionDescription::answer(sdp.clone())?;
    pc.set_remote_description(answer).await?;
    // Host's offer is local, the browser's answer is remote.
    let th = e2e::compute_transcript_hash(&offer_sdp, &sdp)?;
    let keys = e2e::derive_dir_keys(secret, &th)?;
    let mut map = peers.lock().await;
    if let Some(p) = map.get_mut(peer_id) {
        p.crypto = Some(Arc::new(PeerCrypto { keys, th }));
    }
    Ok(())
}

/// The sealing sender: owns the send counter so wire order == counter order.
fn spawn_sender(
    dc: Arc<RTCDataChannel>,
    mut out_rx: mpsc::UnboundedReceiver<(u8, Value)>,
    peers: Peers,
    peer_id: String,
) {
    tokio::spawn(async move {
        let mut send = e2e::SendState { send_ctr: 0 };
        while let Some((flags, env)) = out_rx.recv().await {
            let crypto = {
                let map = peers.lock().await;
                match map.get(&peer_id).and_then(|p| p.crypto.clone()) {
                    Some(c) => c,
                    None => continue, // keys not derived yet — drop (mirrors TS guard)
                }
            };
            let plaintext = env.to_string().into_bytes();
            let frame = match e2e::seal(&crypto.keys.h2c, &mut send, flags, &crypto.th, &plaintext)
            {
                Ok(f) => f,
                Err(_) => {
                    close_peer(&peers, &peer_id).await; // counter overflow — fail closed
                    return;
                }
            };
            if dc.send(&frame.into()).await.is_err() {
                // peer vanished mid-send; dropping the frame is correct
            }
        }
    });
}

/// The decrypting receiver: opens frames in arrival order (replay counter),
/// runs the confirm handshake, then dispatches req/abort envelopes.
fn spawn_receiver(
    peers: Peers,
    peer_id: String,
    mut in_rx: mpsc::UnboundedReceiver<Vec<u8>>,
    api_token: String,
    scope: Arc<Scope>,
) {
    tokio::spawn(async move {
        while let Some(frame) = in_rx.recv().await {
            let crypto = {
                let map = peers.lock().await;
                match map.get(&peer_id).and_then(|p| p.crypto.clone()) {
                    Some(c) => c,
                    None => {
                        close_peer(&peers, &peer_id).await;
                        return;
                    }
                }
            };
            let opened = {
                let mut map = peers.lock().await;
                let Some(p) = map.get_mut(&peer_id) else {
                    return;
                };
                match e2e::open(&crypto.keys.c2h, &frame, &crypto.th, &mut p.recv) {
                    Ok(o) => o,
                    Err(_) => {
                        drop(map);
                        close_peer(&peers, &peer_id).await; // fail closed
                        return;
                    }
                }
            };
            let Ok(env) = serde_json::from_slice::<Value>(&opened.plaintext) else {
                close_peer(&peers, &peer_id).await;
                return;
            };
            let t = env.get("t").and_then(|t| t.as_str()).unwrap_or("");
            let confirmed = {
                let map = peers.lock().await;
                map.get(&peer_id).map(|p| p.confirmed).unwrap_or(false)
            };
            if !confirmed {
                if t != "confirm" {
                    close_peer(&peers, &peer_id).await;
                    return;
                }
                let mut map = peers.lock().await;
                let Some(p) = map.get_mut(&peer_id) else {
                    return;
                };
                if let Some(nonce) = env.get("nonce").and_then(|n| n.as_str()) {
                    if !p.confirmed_out {
                        let my = p.my_nonce.clone();
                        let _ = p.out_tx.send((
                            e2e::FLAG_CONFIRM,
                            json!({"t":"confirm","nonce":my,"echo":nonce}),
                        ));
                        p.confirmed_out = true;
                    }
                }
                if env.get("echo").and_then(|e| e.as_str()) == Some(p.my_nonce.as_str()) {
                    p.confirmed_in = true;
                }
                if p.confirmed_in && p.confirmed_out {
                    p.confirmed = true;
                    eprintln!("[ayrs share] peer {peer_id} key-confirmed");
                }
                continue;
            }
            match t {
                "confirm" => {} // stray confirm after handshake — ignore
                "abort" => {
                    if let Some(id) = env.get("id").and_then(|i| i.as_str()) {
                        let mut map = peers.lock().await;
                        if let Some(p) = map.get_mut(&peer_id) {
                            if let Some(h) = p.reqs.remove(id) {
                                h.abort();
                            }
                        }
                    }
                }
                "req" => {
                    let id = env.get("id").map(value_to_id).unwrap_or_default();
                    if std::env::var("AYRS_SHARE_LOG").is_ok() {
                        eprintln!(
                            "[ayrs share] req {} {}",
                            env.get("method").and_then(|m| m.as_str()).unwrap_or("GET"),
                            env.get("path").and_then(|p| p.as_str()).unwrap_or("/"),
                        );
                    }
                    let method = env
                        .get("method")
                        .and_then(|m| m.as_str())
                        .unwrap_or("GET")
                        .to_string();
                    let path = env
                        .get("path")
                        .and_then(|p| p.as_str())
                        .unwrap_or("/")
                        .to_string();
                    let body = env
                        .get("body")
                        .and_then(|b| b.as_str())
                        .unwrap_or("")
                        .to_string();
                    let out_tx = {
                        let map = peers.lock().await;
                        match map.get(&peer_id) {
                            Some(p) => p.out_tx.clone(),
                            None => return,
                        }
                    };
                    let _ = api_token; // auth is implicit: the bridge IS the local API
                    let peers2 = peers.clone();
                    let peer_id2 = peer_id.clone();
                    let id2 = id.clone();
                    let scope2 = scope.clone();
                    let handle = tokio::spawn(async move {
                        serve_request(out_tx, id2.clone(), method, path, body, scope2).await;
                        // done — drop our own abort registration
                        let mut map = peers2.lock().await;
                        if let Some(p) = map.get_mut(&peer_id2) {
                            p.reqs.remove(&id2);
                        }
                    });
                    let mut map = peers.lock().await;
                    if let Some(p) = map.get_mut(&peer_id) {
                        p.reqs.insert(id, handle);
                    } else {
                        handle.abort();
                    }
                }
                _ => {}
            }
        }
    });
}

/// Run one bridged request against the native API and stream the response back
/// as {t:"res"} / {t:"data"} / {t:"end"} envelopes.
async fn serve_request(
    out_tx: mpsc::UnboundedSender<(u8, Value)>,
    id: String,
    method: String,
    path: String,
    body: String,
    scope: Arc<Scope>,
) {
    let res = super::agent_share::scoped_handle(&scope, &method, &path, &body).await;
    let _ = out_tx.send((
        0,
        json!({"t":"res","id":id,"status":res.status,"ct":res.content_type}),
    ));
    let mut seq: u64 = 0;
    let send_text = |text: &str, seq: &mut u64| -> bool {
        // Slice to MAX_CHUNK units; receiver reassembles by seq-order concat.
        let mut rest = text;
        while !rest.is_empty() {
            let mut end = rest.len().min(e2e::MAX_CHUNK);
            while !rest.is_char_boundary(end) {
                end -= 1;
            }
            let (chunk, tail) = rest.split_at(end);
            if out_tx
                .send((0, json!({"t":"data","id":id,"seq":*seq,"chunk":chunk})))
                .is_err()
            {
                return false;
            }
            *seq += 1;
            rest = tail;
        }
        true
    };
    match res.body {
        api::Body::Full(bytes) => {
            let text = String::from_utf8_lossy(&bytes);
            if !text.is_empty() {
                send_text(&text, &mut seq);
            }
        }
        api::Body::Stream(mut rx) => {
            while let Some(chunk) = rx.recv().await {
                let text = String::from_utf8_lossy(&chunk);
                if !send_text(&text, &mut seq) {
                    return;
                }
            }
        }
    }
    let _ = out_tx.send((0, json!({"t":"end","id":id,"seq":seq})));
}
