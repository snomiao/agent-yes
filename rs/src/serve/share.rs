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
/// Ceiling on one peer's WebRTC setup / answer handling. webrtc-rs can block
/// indefinitely on its internal locks; without a ceiling a single stuck peer
/// leaks its task and its UDP sockets forever. Generous — this is a crash
/// barrier, not a latency budget.
const PEER_OP_TIMEOUT_MS: u64 = 30_000;
/// Ceiling on tearing one peer down, for the same reason.
const PEER_CLOSE_TIMEOUT_MS: u64 = 10_000;
/// How long a peer may sit between `peer-join` and key-confirmed before it is
/// torn down. This is the leak the two timeouts above do NOT cover: a browser
/// that closes its tab mid-handshake, or vanishes across the 4-minute signaling
/// refresh so no `peer-leave` ever arrives, leaves a peer whose every webrtc-rs
/// call has returned promptly — and whose task then waits in `rx.recv()` for a
/// command that never comes. Its RTCPeerConnection never leaves `New`, so the
/// Failed/Disconnected callback never fires, and `Mailboxes` deliberately
/// outlives signaling sessions, so nothing prunes it. Each such peer keeps its
/// ICE UDP sockets for the life of the process. Measured on one host: 501
/// `peer-join` against 234 `key-confirmed` over the log's lifetime, and a
/// launchd-supervised `ayrs serve` that ran out of file descriptors (256 soft)
/// after ~a day, at which point even DNS lookups failed and the share was dead.
/// A real handshake completes in a few seconds; this is a crash barrier.
const PEER_SETUP_DEADLINE_MS: u64 = 60_000;
const STUN_URL: &str = "stun:stun.l.google.com:19302";
const MAX_ROTATES: u32 = 5;
/// How long to wait between re-checks while parked behind a live room holder.
///
/// The only thing this poll does is one `kill(pid, 0)`, so the cost of a short
/// interval is nil; what sets the floor is the OS supervisor. Under launchd
/// (`KeepAlive = true`) a daemon that exits immediately is relaunched
/// immediately, and the old fail-fast claim turned that into a fork/exec storm:
/// tens of thousands of spawn→refuse→exit cycles, each one a fresh Gatekeeper
/// exec evaluation, which shows up as sustained system-wide CPU burn in
/// `syspolicyd` plus a multi-megabyte error log of the same refusal line.
/// Parking in-process removes the churn entirely, so the interval only trades
/// takeover latency after the holder dies. 5s keeps that handoff well under the
/// signaling server's host-heartbeat window while polling ~12x/min.
const CLAIM_RETRY_INTERVAL: Duration = Duration::from_secs(5);

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

/// One peer's serialized work queue. The signaling loop only ever *sends* these
/// — it never awaits WebRTC work itself (see `dispatch_signal`).
enum PeerCmd {
    /// Build the RTCPeerConnection and send the offer (`peer-join`).
    Start,
    /// Apply the browser's answer SDP and derive the direction keys.
    Answer(String),
    /// Trickle-ICE candidate from the browser.
    Candidate(Box<RTCIceCandidateInit>),
}

/// Per-peer command channels, keyed by peer id. Lives in `run_share` (NOT in
/// `connect_once`) so peer tasks survive the 4-minute signaling refresh.
///
/// LOCK RULE: this mutex is held for map operations only — insert, get+clone,
/// remove — and NEVER across a WebRTC await. That invariant is what keeps the
/// signaling loop unwedgeable: every path that touches it completes promptly.
type Mailboxes = Arc<Mutex<HashMap<String, mpsc::UnboundedSender<PeerCmd>>>>;

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

/// Result of one non-blocking attempt at the room's advisory lock.
#[derive(Debug, PartialEq, Eq)]
enum ClaimOutcome {
    /// The lock file now records our pid; we are the room's host.
    Claimed,
    /// A different, still-live pid holds the room. Carries the holder so the
    /// caller can wait on it without re-parsing an error string.
    HeldBy(i32),
}

/// Two `ayrs` hosts in the same signaling room both answer every `peer-join`,
/// so each viewer's answer reaches the host that did *not* originate the offer
/// and blows up with "invalid proposed signaling state transition from stable".
/// Nothing recovers from that — the room just stops accepting viewers — so
/// never start a second host on a room that's already working.
///
/// This is the whole invariant, and none of the wrappers below relax it: they
/// only differ in what happens *after* a refusal (bail vs. park and retry).
fn try_claim_room_at(path: &std::path::Path) -> ClaimOutcome {
    if let Ok(txt) = std::fs::read_to_string(path) {
        if let Ok(pid) = txt.trim().parse::<i32>() {
            if pid != std::process::id() as i32 && crate::pid_store::is_process_alive(pid as u32) {
                return ClaimOutcome::HeldBy(pid);
            }
        }
    }
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p).ok();
    }
    std::fs::write(path, std::process::id().to_string()).ok();
    ClaimOutcome::Claimed
}

fn held_by_error(pid: i32, room: &str) -> anyhow::Error {
    anyhow!(
        "another ayrs host (pid {pid}) is already serving room {room}\n\
         running two hosts in one room breaks WebRTC answering for every viewer.\n\
         stop it first (`ayrs serve uninstall`, or kill {pid}), or host a different room."
    )
}

/// Fail-fast claim: refuse immediately if the room is held by a live pid.
/// For callers that must not block (see the rotation path in `run_share`).
fn claim_room_at(path: &std::path::Path, room: &str) -> Result<()> {
    match try_claim_room_at(path) {
        ClaimOutcome::Claimed => Ok(()),
        ClaimOutcome::HeldBy(pid) => Err(held_by_error(pid, room)),
    }
}

/// Parking claim: wait for the incumbent host to go away, then take over.
///
/// Returning an error here would hand control back to the OS supervisor, which
/// (launchd `KeepAlive = true`, and equivalently under the other managers) just
/// relaunches us — spawn, refuse, exit, repeat, forever. That fork/exec storm is
/// far more damaging than the wait it was avoiding, so the daemon startup path
/// parks in-process instead: the invariant is still "exactly one host per room",
/// we simply queue for it rather than thrashing on it.
///
/// The banner is printed ONCE per distinct holder, not once per poll — the
/// per-attempt log line is precisely what grew the daemon's stderr log into
/// millions of identical rows.
///
/// Interruptibility: this awaits `tokio::time::sleep`, so a foreground run stays
/// killable with Ctrl-C under SIGINT's default disposition. Deliberately NOT a
/// `select!` on `tokio::signal::ctrl_c()` — awaiting that installs a
/// process-wide handler that outlives this loop and would silently make Ctrl-C
/// a no-op for the rest of the daemon's life (the `ayrs` binary installs no
/// signal handler of its own; see `rs/src/bin/ayrs.rs`).
async fn claim_room_blocking_at(
    path: &std::path::Path,
    room: &str,
    interval: Duration,
) -> Result<()> {
    let mut announced: Option<i32> = None;
    loop {
        match try_claim_room_at(path) {
            ClaimOutcome::Claimed => {
                if announced.is_some() {
                    eprintln!("[ayrs share] room {room} released — taking over as host");
                }
                return Ok(());
            }
            ClaimOutcome::HeldBy(pid) => {
                if announced != Some(pid) {
                    announced = Some(pid);
                    eprintln!(
                        "[ayrs share] {}\nwaiting for pid {pid} to exit (re-checking every {}s); \
                         this message is not repeated.",
                        held_by_error(pid, room),
                        interval.as_secs().max(1)
                    );
                }
                tokio::time::sleep(interval).await;
            }
        }
    }
}

/// Daemon startup claim on the real lock path, with the production interval.
async fn claim_room_blocking(room: &str) -> Result<()> {
    claim_room_blocking_at(&room_lock_path(room), room, CLAIM_RETRY_INTERVAL).await
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

    #[tokio::test]
    async fn blocking_claim_returns_immediately_for_a_free_room() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("lock.pid");
        // A free room must not sleep even once, so a tiny timeout is a real
        // assertion here rather than just a CI guard.
        tokio::time::timeout(
            Duration::from_secs(5),
            claim_room_blocking_at(&p, "r1", Duration::from_secs(3600)),
        )
        .await
        .expect("free room must not park")
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(&p).unwrap(),
            std::process::id().to_string()
        );
    }

    #[tokio::test]
    async fn blocking_claim_parks_then_takes_over_when_the_holder_exits() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("lock.pid");
        // Same live-process trick as `refuses_a_room_held_by_a_live_pid`: a real
        // short-lived child, never pid 1 (kill(1,0) is EPERM for a normal user,
        // which reads as "dead" and would make this test vacuous).
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .unwrap();
        std::fs::write(&p, child.id().to_string()).unwrap();

        // The reap is load-bearing: a killed-but-unwaited child stays a zombie,
        // and `kill(zombie, 0)` keeps returning 0 — i.e. "alive" — so without
        // `wait()` the park loop would spin forever.
        let holder = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            let _ = child.kill();
            let _ = child.wait();
        });

        // Injected interval keeps the test at ~0.1s of real time; the outer
        // timeout turns any regression into a fast failure instead of a hung CI.
        tokio::time::timeout(
            Duration::from_secs(10),
            claim_room_blocking_at(&p, "r1", Duration::from_millis(25)),
        )
        .await
        .expect("park must take over once the holder exits")
        .unwrap();

        holder.join().unwrap();
        assert_eq!(
            std::fs::read_to_string(&p).unwrap(),
            std::process::id().to_string()
        );
    }

    #[test]
    fn fail_fast_and_parking_claims_disagree_on_a_live_holder() {
        // The rotation call site depends on the fail-fast wrapper staying
        // fail-fast: same lock file, same live holder, but it returns an error
        // where `claim_room_blocking_at` would park. (It is a plain sync `fn`,
        // so "does not block" is enforced by its type, not by a timeout.)
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("lock.pid");
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .unwrap();
        std::fs::write(&p, child.id().to_string()).unwrap();
        let err = claim_room_at(&p, "r1").unwrap_err().to_string();
        assert_eq!(
            try_claim_room_at(&p),
            ClaimOutcome::HeldBy(child.id() as i32)
        );
        let _ = child.kill();
        let _ = child.wait();
        assert!(err.contains("already serving room r1"), "{err}");
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
    // Startup claim → PARK. This is the path the OS supervisor re-runs, so
    // exiting here is what produced the relaunch storm. Waiting costs nothing:
    // the room is already being served correctly by the incumbent, and we take
    // over the moment it dies.
    claim_room_blocking(&room.room).await?;
    let api_token = api::load_or_create_token().context("serve token")?;

    let peers: Peers = Arc::new(Mutex::new(HashMap::new()));
    // Outlives connect_once so a peer keeps its serialized task across the
    // 4-minute signaling refresh.
    let mailboxes: Mailboxes = Arc::new(Mutex::new(HashMap::new()));
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
            mailboxes.clone(),
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
                // Rotation claim → FAIL FAST. `mint_room` just generated a
                // fresh random room id, so a live foreign holder here is a
                // collision or a bug, not the normal "the box already has a
                // host" case; parking would wait on something that will never
                // be released and hide the fault. Bailing does not resurrect
                // the relaunch storm either: `persist_room` above already
                // wrote the new room, so the supervisor's relaunch loads it
                // and lands on the PARKING startup claim instead.
                claim_room_at(&room_lock_path(&room.room), &room.room)?;
                let link = format_share_link(&room.room, &secret, &room.host);
                eprintln!("[ayrs share] room rotated: {link}");
            }
            Ok(SessionEnd::Cancelled) => unreachable!("master room has no canceller"),
            Ok(SessionEnd::Dropped) => {
                tokio::time::sleep(Duration::from_millis(1000)).await;
            }
            Err(e) => {
                // The held-peer count is the gauge for the fd leak this loop
                // is most likely to be reporting: a `getaddrinfo` failure with
                // DNS otherwise fine means the process is out of descriptors.
                let held = peers.lock().await.len();
                eprintln!("[ayrs share] signaling error: {e:#} ({held} peers held)");
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
    let mailboxes: Mailboxes = Arc::new(Mutex::new(HashMap::new()));
    loop {
        if *cancel.borrow() {
            break;
        }
        match connect_once(
            &room,
            &secret,
            "",
            peers.clone(),
            mailboxes.clone(),
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
    // Dropping every mailbox ends each peer task, which closes its own peer
    // connection; the sweep below is the backstop for a peer whose task had
    // already exited. Both halves are idempotent.
    mailboxes.lock().await.clear();
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
    mailboxes: Mailboxes,
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
                        dispatch_signal(
                            m,
                            &peers,
                            &mailboxes,
                            secret,
                            api_token,
                            &sig_tx,
                            &scope,
                        )
                        .await;
                    }
                    _ => {}
                }
            }
        }
    }
}

/// Route one signaling message to the peer it belongs to — and nothing else.
///
/// This runs INSIDE `connect_once`'s `tokio::select!`, alongside the heartbeat,
/// the dead-socket detector, the periodic refresh and (via the loop above it)
/// reconnection. Every one of those recovery mechanisms is starved for as long
/// as this function is awaiting, so it must never await anything of unbounded
/// duration. It previously awaited `start_peer` / `on_answer` / `close_peer`
/// directly — all of which await into webrtc-rs, which can block indefinitely on
/// its internal locks. One such block deafened the host permanently: peer-joins
/// piled up unread in the socket's receive queue (measured: 6875 bytes) while
/// the heartbeat that was supposed to notice the dead session never ran again.
///
/// So: per-peer work goes to that peer's own task via `PeerCmd`, and the sends
/// are non-blocking. A peer that wedges now wedges only itself.
async fn dispatch_signal(
    m: Value,
    peers: &Peers,
    mailboxes: &Mailboxes,
    secret: &str,
    api_token: &str,
    sig_tx: &mpsc::UnboundedSender<SigOut>,
    scope: &Arc<Scope>,
) {
    match m.get("type").and_then(|t| t.as_str()) {
        Some("pong") | Some("welcome") => {}
        Some("peer-join") => {
            let Some(peer_id) = m.get("peer").map(value_to_id) else {
                return;
            };
            let tx = {
                let mut map = mailboxes.lock().await;
                if map.contains_key(&peer_id) {
                    return; // duplicate join for a peer we're already serving
                }
                let (tx, rx) = mpsc::unbounded_channel();
                map.insert(peer_id.clone(), tx.clone());
                spawn_peer_task(
                    peer_id.clone(),
                    rx,
                    peers.clone(),
                    mailboxes.clone(),
                    secret.to_string(),
                    api_token.to_string(),
                    sig_tx.clone(),
                    scope.clone(),
                );
                tx
            };
            eprintln!("[ayrs share] peer-join {peer_id}");
            let _ = tx.send(PeerCmd::Start);
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
            send_cmd(mailboxes, &from, PeerCmd::Answer(sdp)).await;
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
            send_cmd(mailboxes, &from, PeerCmd::Candidate(Box::new(init))).await;
        }
        Some("peer-leave") => {
            if let Some(peer) = m.get("peer").map(value_to_id) {
                request_close(mailboxes, &peer).await;
            }
        }
        _ => {}
    }
}

/// Hand one command to a peer's task. Unbounded send → never blocks.
async fn send_cmd(mailboxes: &Mailboxes, peer_id: &str, cmd: PeerCmd) {
    let tx = mailboxes.lock().await.get(peer_id).cloned();
    if let Some(tx) = tx {
        let _ = tx.send(cmd);
    }
}

/// Ask a peer to tear down. Dropping the mailbox closes the command channel,
/// which ends that peer's task, and the task itself performs the actual
/// `close()`. Nothing outside the peer task ever closes an RTCPeerConnection —
/// that is what keeps `close()` off webrtc-rs callback stacks (see `close_peer`).
async fn request_close(mailboxes: &Mailboxes, peer_id: &str) {
    mailboxes.lock().await.remove(peer_id);
}

#[cfg(test)]
mod dispatch_tests {
    use super::*;

    /// A mailbox whose receiver is never drained — stands in for a peer stuck
    /// inside webrtc-rs. The receiver is returned so the channel stays open.
    fn wedged_peer(id: &str) -> (Mailboxes, mpsc::UnboundedReceiver<PeerCmd>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let mut map = HashMap::new();
        map.insert(id.to_string(), tx);
        (Arc::new(Mutex::new(map)), rx)
    }

    fn empty_peers() -> Peers {
        Arc::new(Mutex::new(HashMap::new()))
    }

    /// The property the wedge cost us: routing a signaling message must never
    /// wait on the peer it is routed to. Before the mailbox split, `answer`
    /// awaited `set_remote_description` right here in the signaling `select!`,
    /// so one peer blocking inside webrtc-rs stopped the heartbeat, the
    /// dead-socket detector and reconnection for every other peer too.
    #[tokio::test]
    async fn routing_never_waits_on_the_peer_it_routes_to() {
        let (mailboxes, _rx) = wedged_peer("stuck");
        let peers = empty_peers();
        let (sig_tx, _sig_rx) = mpsc::unbounded_channel();
        let scope = Arc::new(Scope::Full);

        for msg in [
            json!({"type":"answer","from":"stuck","sdp":"v=0\r\n"}),
            json!({"type":"candidate","from":"stuck","candidate":{"candidate":"","sdpMid":"0"}}),
            json!({"type":"peer-leave","peer":"stuck"}),
        ] {
            tokio::time::timeout(
                Duration::from_secs(5),
                dispatch_signal(
                    msg.clone(),
                    &peers,
                    &mailboxes,
                    "secret",
                    "token",
                    &sig_tx,
                    &scope,
                ),
            )
            .await
            .unwrap_or_else(|_| panic!("dispatch blocked on a wedged peer: {msg}"));
        }
    }

    /// Commands reach a peer in signaling order. This is what a bare
    /// `tokio::spawn` per message would lose — an answer could then be applied
    /// before the offer that produced it, or a candidate before the answer.
    #[tokio::test]
    async fn commands_keep_their_signaling_order() {
        let (mailboxes, mut rx) = wedged_peer("p");
        let peers = empty_peers();
        let (sig_tx, _sig_rx) = mpsc::unbounded_channel();
        let scope = Arc::new(Scope::Full);

        dispatch_signal(
            json!({"type":"answer","from":"p","sdp":"SDP-1"}),
            &peers,
            &mailboxes,
            "secret",
            "token",
            &sig_tx,
            &scope,
        )
        .await;
        dispatch_signal(
            json!({"type":"candidate","from":"p","candidate":{"candidate":"c","sdpMid":"0"}}),
            &peers,
            &mailboxes,
            "secret",
            "token",
            &sig_tx,
            &scope,
        )
        .await;

        match rx.recv().await {
            Some(PeerCmd::Answer(sdp)) => assert_eq!(sdp, "SDP-1"),
            _ => panic!("expected the answer first"),
        }
        assert!(matches!(rx.recv().await, Some(PeerCmd::Candidate(_))));
    }

    /// `peer-leave` drops the mailbox, which is what ends the peer's task — and
    /// it must not run the close itself (that is the callback-stack trap).
    #[tokio::test]
    async fn leaving_drops_the_mailbox() {
        let (mailboxes, _rx) = wedged_peer("gone");
        let peers = empty_peers();
        let (sig_tx, _sig_rx) = mpsc::unbounded_channel();
        let scope = Arc::new(Scope::Full);

        dispatch_signal(
            json!({"type":"peer-leave","peer":"gone"}),
            &peers,
            &mailboxes,
            "secret",
            "token",
            &sig_tx,
            &scope,
        )
        .await;
        assert!(mailboxes.lock().await.is_empty());
    }

    /// A duplicate `peer-join` must not spawn a second task for the same peer —
    /// two tasks racing one RTCPeerConnection is how the signaling state machine
    /// gets into "invalid proposed signaling state transition from stable".
    #[tokio::test]
    async fn a_duplicate_join_is_ignored() {
        let (mailboxes, _rx) = wedged_peer("dup");
        let peers = empty_peers();
        let (sig_tx, _sig_rx) = mpsc::unbounded_channel();
        let scope = Arc::new(Scope::Full);

        dispatch_signal(
            json!({"type":"peer-join","peer":"dup"}),
            &peers,
            &mailboxes,
            "secret",
            "token",
            &sig_tx,
            &scope,
        )
        .await;
        assert_eq!(mailboxes.lock().await.len(), 1);
    }

    /// A peer whose handshake never completes must not live forever. This is
    /// the browser that closed its tab between `peer-join` and its answer, or
    /// that vanished across a signaling refresh so no `peer-leave` ever came:
    /// no command fails, no state-change callback fires, and before the
    /// deadline the task simply waited in `rx.recv()` holding its ICE sockets.
    #[tokio::test]
    async fn an_unconfirmed_peer_is_torn_down_at_the_setup_deadline() {
        let peers = empty_peers();
        let mailboxes: Mailboxes = Arc::new(Mutex::new(HashMap::new()));
        let (tx, rx) = mpsc::unbounded_channel();
        mailboxes
            .lock()
            .await
            .insert("ghost".to_string(), tx.clone());
        let (sig_tx, _sig_rx) = mpsc::unbounded_channel();
        spawn_peer_task_with_deadline(
            "ghost".to_string(),
            rx,
            peers,
            mailboxes.clone(),
            "secret".to_string(),
            "token".to_string(),
            sig_tx,
            Arc::new(Scope::Full),
            Duration::from_millis(50),
        );
        // `tx` is deliberately kept alive: the mailbox must be removed by the
        // deadline, not by the channel closing.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !mailboxes.lock().await.is_empty() {
            assert!(
                std::time::Instant::now() < deadline,
                "unconfirmed peer was not torn down at its setup deadline"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        drop(tx);
    }

    /// The control: the deadline is a check, not a kill switch. A peer that
    /// HAS confirmed by the time it fires keeps its task and its mailbox.
    #[tokio::test]
    async fn a_confirmed_peer_survives_the_setup_deadline() {
        let peers = empty_peers();
        let mailboxes: Mailboxes = Arc::new(Mutex::new(HashMap::new()));
        let (tx, rx) = mpsc::unbounded_channel();
        mailboxes
            .lock()
            .await
            .insert("live".to_string(), tx.clone());
        let (sig_tx, _sig_rx) = mpsc::unbounded_channel();
        let (out_tx, _out_rx) = mpsc::unbounded_channel();
        let pc = APIBuilder::new()
            .build()
            .new_peer_connection(RTCConfiguration::default())
            .await
            .expect("offline RTCPeerConnection");
        peers.lock().await.insert(
            "live".to_string(),
            Peer {
                pc: Arc::new(pc),
                out_tx,
                offer_sdp: String::new(),
                reqs: HashMap::new(),
                crypto: None,
                recv: e2e::RecvState { last_seen: None },
                my_nonce: String::new(),
                confirmed_in: true,
                confirmed_out: true,
                confirmed: true,
            },
        );
        spawn_peer_task_with_deadline(
            "live".to_string(),
            rx,
            peers.clone(),
            mailboxes.clone(),
            "secret".to_string(),
            "token".to_string(),
            sig_tx,
            Arc::new(Scope::Full),
            Duration::from_millis(50),
        );
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(
            mailboxes.lock().await.len(),
            1,
            "confirmed peer was torn down"
        );
        // Ending the channel is what tears it down, as before.
        drop(tx);
        mailboxes.lock().await.clear();
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        while peers.lock().await.contains_key("live") {
            assert!(
                std::time::Instant::now() < deadline,
                "peer not closed after leave"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// `start_peer` now registers the connection before it builds the offer, so
    /// a setup that stalls is still reachable by `close_peer`. The normal path
    /// must be unchanged by that: the registered peer ends up holding the offer
    /// it sent, and exactly one offer goes out on signaling.
    #[tokio::test]
    async fn a_started_peer_is_registered_with_the_offer_it_sent() {
        let peers = empty_peers();
        let mailboxes: Mailboxes = Arc::new(Mutex::new(HashMap::new()));
        let (sig_tx, mut sig_rx) = mpsc::unbounded_channel();
        tokio::time::timeout(
            Duration::from_secs(10),
            start_peer(
                "fresh".to_string(),
                "token",
                &peers,
                &mailboxes,
                &sig_tx,
                Arc::new(Scope::Full),
            ),
        )
        .await
        .expect("start_peer stalled")
        .expect("offline start_peer");

        // Trickle-ICE candidates share this channel and may land before the
        // offer, so look at everything that went out, not just the first frame.
        let mut offers = Vec::new();
        while let Ok(SigOut::Send(text)) = sig_rx.try_recv() {
            let m: Value = serde_json::from_str(&text).unwrap();
            if m["type"] == "offer" {
                offers.push(m);
            }
        }
        assert_eq!(
            offers.len(),
            1,
            "expected exactly one offer, got {offers:?}"
        );
        assert_eq!(offers[0]["to"], "fresh");
        let offer_sdp = offers[0]["sdp"].as_str().unwrap_or("").to_string();
        assert!(
            offer_sdp.contains("v=0"),
            "offer is not an SDP: {offer_sdp:?}"
        );

        {
            let map = peers.lock().await;
            let p = map.get("fresh").expect("peer not registered");
            assert_eq!(
                p.offer_sdp, offer_sdp,
                "registered peer holds a different offer"
            );
            assert!(!p.confirmed);
        }
        // And it is closable through the ordinary path.
        close_peer(&peers, "fresh").await;
        assert!(!peers.lock().await.contains_key("fresh"));
    }
}

/// One peer's serialized worker. Commands are processed strictly in arrival
/// order, so the offer is always sent before the answer is applied and
/// candidates never overtake the remote description — the ordering guarantee a
/// bare `tokio::spawn` per signaling message would have thrown away.
#[allow(clippy::too_many_arguments)]
fn spawn_peer_task(
    peer_id: String,
    rx: mpsc::UnboundedReceiver<PeerCmd>,
    peers: Peers,
    mailboxes: Mailboxes,
    secret: String,
    api_token: String,
    sig_tx: mpsc::UnboundedSender<SigOut>,
    scope: Arc<Scope>,
) {
    spawn_peer_task_with_deadline(
        peer_id,
        rx,
        peers,
        mailboxes,
        secret,
        api_token,
        sig_tx,
        scope,
        Duration::from_millis(PEER_SETUP_DEADLINE_MS),
    );
}

/// `spawn_peer_task` with the setup deadline injectable, so a test can watch a
/// peer that never completes its handshake get torn down without waiting a
/// minute for it.
#[allow(clippy::too_many_arguments)]
fn spawn_peer_task_with_deadline(
    peer_id: String,
    mut rx: mpsc::UnboundedReceiver<PeerCmd>,
    peers: Peers,
    mailboxes: Mailboxes,
    secret: String,
    api_token: String,
    sig_tx: mpsc::UnboundedSender<SigOut>,
    scope: Arc<Scope>,
    setup_deadline: Duration,
) {
    tokio::spawn(async move {
        // Armed from the moment the peer joins; checked, not tracked — when it
        // fires, a peer that has key-confirmed is left alone and the timer is
        // disarmed, anything else is torn down. See PEER_SETUP_DEADLINE_MS.
        let deadline = tokio::time::sleep(setup_deadline);
        tokio::pin!(deadline);
        let mut deadline_armed = true;
        loop {
            let cmd = tokio::select! {
                cmd = rx.recv() => match cmd {
                    Some(cmd) => cmd,
                    None => break, // peer-leave / connection died
                },
                _ = &mut deadline, if deadline_armed => {
                    deadline_armed = false;
                    let confirmed = peers
                        .lock()
                        .await
                        .get(&peer_id)
                        .map(|p| p.confirmed)
                        .unwrap_or(false);
                    if confirmed {
                        continue;
                    }
                    eprintln!(
                        "[ayrs share] peer {peer_id} never completed its handshake within {}ms — closing it",
                        setup_deadline.as_millis()
                    );
                    break;
                }
            };
            // Every webrtc-rs call gets a ceiling: a stuck one must kill its own
            // peer, not linger holding sockets and a task forever.
            let timeout = Duration::from_millis(PEER_OP_TIMEOUT_MS);
            let outcome: Result<()> = match cmd {
                PeerCmd::Start => {
                    match tokio::time::timeout(
                        timeout,
                        start_peer(
                            peer_id.clone(),
                            &api_token,
                            &peers,
                            &mailboxes,
                            &sig_tx,
                            scope.clone(),
                        ),
                    )
                    .await
                    {
                        Ok(r) => r,
                        Err(_) => Err(anyhow!("setup timed out after {PEER_OP_TIMEOUT_MS}ms")),
                    }
                }
                PeerCmd::Answer(sdp) => {
                    match tokio::time::timeout(timeout, on_answer(&peer_id, sdp, &secret, &peers))
                        .await
                    {
                        Ok(r) => r,
                        Err(_) => Err(anyhow!("answer timed out after {PEER_OP_TIMEOUT_MS}ms")),
                    }
                }
                PeerCmd::Candidate(init) => {
                    let pc = {
                        let map = peers.lock().await;
                        map.get(&peer_id).map(|p| p.pc.clone())
                    };
                    match pc {
                        Some(pc) => {
                            match tokio::time::timeout(timeout, pc.add_ice_candidate(*init)).await {
                                Ok(r) => r.map_err(|e| anyhow!(e)),
                                Err(_) => Err(anyhow!("add_ice_candidate timed out")),
                            }
                        }
                        None => Ok(()), // candidate for a peer that already went away
                    }
                }
            };
            if let Err(e) = outcome {
                eprintln!("[ayrs share] peer {peer_id} failed: {e:#}");
                break;
            }
        }
        // Channel closed (peer-leave / connection died), a command failed, or
        // the setup deadline passed without a confirmed handshake.
        close_peer(&peers, &peer_id).await;
        mailboxes.lock().await.remove(&peer_id);
    });
}

pub(super) fn value_to_id(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// Tear one peer down. ONLY the peer's own task may call this.
///
/// `RTCPeerConnection::close()` must never run on a webrtc-rs callback stack.
/// webrtc-rs invokes our handlers while holding the handler's `Mutex`
/// (`do_peer_connection_state_change`: `let mut f = handler.lock().await;
/// f(cs).await;`), and `close()` re-locks that same non-reentrant mutex on its
/// way out (step #11 → `update_connection_state`). Closing from inside a state
/// change handler is therefore a guaranteed self-deadlock: the task hangs
/// forever holding the handler lock, and the peer's ICE sockets are never
/// released. Callbacks call `request_close` instead, which only drops a channel.
async fn close_peer(peers: &Peers, peer_id: &str) {
    let removed = peers.lock().await.remove(peer_id);
    if let Some(p) = removed {
        for (_, h) in p.reqs {
            h.abort();
        }
        // Bounded wait, but the close itself is detached. Dropping a slow
        // `close()` future mid-way used to be how a wedged close was handled —
        // and it freed nothing: webrtc-rs's internal tasks hold their own Arcs
        // to the connection, so an abandoned RTCPeerConnection kept its ICE UDP
        // sockets for the life of the process. Let the close run to completion
        // on its own task; only this caller stops waiting for it.
        let pc = p.pc;
        let id = peer_id.to_string();
        let close = tokio::spawn(async move {
            if let Err(e) = pc.close().await {
                eprintln!("[ayrs share] peer {id} close failed: {e}");
            }
        });
        if tokio::time::timeout(Duration::from_millis(PEER_CLOSE_TIMEOUT_MS), close)
            .await
            .is_err()
        {
            eprintln!(
                "[ayrs share] peer {peer_id} close still running after {PEER_CLOSE_TIMEOUT_MS}ms — left to finish in the background"
            );
        }
    }
}

async fn start_peer(
    peer_id: String,
    api_token: &str,
    peers: &Peers,
    mailboxes: &Mailboxes,
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

    // sealed-frame sender task input: (flags, envelope) → seal in order → dc.send
    let (out_tx, out_rx) = mpsc::unbounded_channel::<(u8, Value)>();

    // Register the connection BEFORE any further webrtc-rs await. The caller
    // bounds this whole function with PEER_OP_TIMEOUT and tears the peer down
    // via `close_peer` afterwards — which can only close what it finds in
    // `peers`. With the insert at the end (after create_offer /
    // set_local_description), a setup that timed out or errored part-way had
    // already bound its ICE sockets but was never registered, so nothing ever
    // closed it. `offer_sdp` is filled in once the offer exists; nothing reads
    // it before the browser's answer, which can only follow the offer.
    peers.lock().await.insert(
        peer_id.clone(),
        Peer {
            pc: pc.clone(),
            out_tx,
            offer_sdp: String::new(),
            reqs: HashMap::new(),
            crypto: None,
            recv: e2e::RecvState { last_seen: None },
            my_nonce: e2e::random_hex(16),
            confirmed_in: false,
            confirmed_out: false,
            confirmed: false,
        },
    );

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

    // dead-peer cleanup. This handler runs with webrtc-rs holding the
    // state-change handler mutex, so it must NOT close the peer connection here
    // — close() re-locks that mutex and deadlocks (see close_peer). Drop the
    // mailbox instead; the peer's own task does the closing once it is off this
    // stack.
    {
        let mailboxes2 = mailboxes.clone();
        let peer_id = peer_id.clone();
        pc.on_peer_connection_state_change(Box::new(move |st| {
            let mailboxes2 = mailboxes2.clone();
            let peer_id = peer_id.clone();
            Box::pin(async move {
                if matches!(
                    st,
                    RTCPeerConnectionState::Failed
                        | RTCPeerConnectionState::Closed
                        | RTCPeerConnectionState::Disconnected
                ) {
                    request_close(&mailboxes2, &peer_id).await;
                }
            })
        }));
    }

    let dc = pc.create_data_channel("api", None).await?;

    // sealed-frame sender task (its input channel was created with the peer)
    spawn_sender(
        dc.clone(),
        out_rx,
        peers.clone(),
        mailboxes.clone(),
        peer_id.clone(),
    );

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
        mailboxes.clone(),
        peer_id.clone(),
        in_rx,
        api_token.to_string(),
        scope,
    );

    // on open: start the mandatory key-confirmation handshake.
    //
    // The handler itself only sends the nonce and returns. The confirm deadline
    // used to be a `sleep` in this very callback, which pinned the data
    // channel's on_open handler mutex for the whole timeout and then closed the
    // peer from a callback stack — the same re-entrancy trap as the state-change
    // handler. It runs as its own task now.
    {
        let peers2 = peers.clone();
        let mailboxes2 = mailboxes.clone();
        let peer_id2 = peer_id.clone();
        dc.on_open(Box::new(move || {
            let peers2 = peers2.clone();
            let mailboxes2 = mailboxes2.clone();
            let peer_id2 = peer_id2.clone();
            Box::pin(async move {
                {
                    let mut map = peers2.lock().await;
                    if let Some(p) = map.get_mut(&peer_id2) {
                        let nonce = p.my_nonce.clone();
                        let _ = p
                            .out_tx
                            .send((e2e::FLAG_CONFIRM, json!({"t":"confirm","nonce":nonce})));
                    }
                }
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(e2e::CONFIRM_TIMEOUT_MS)).await;
                    let confirmed = peers2
                        .lock()
                        .await
                        .get(&peer_id2)
                        .map(|p| p.confirmed)
                        .unwrap_or(true);
                    if !confirmed {
                        request_close(&mailboxes2, &peer_id2).await;
                    }
                });
            })
        }));
    }

    let offer = pc.create_offer(None).await?;
    let offer_sdp = offer.sdp.clone();
    pc.set_local_description(offer).await?;

    // The peer was torn down while we were setting up (leave / deadline).
    // Don't send an offer for a connection that is already being closed.
    match peers.lock().await.get_mut(&peer_id) {
        Some(p) => p.offer_sdp = offer_sdp.clone(),
        None => return Ok(()),
    }

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
        if p.offer_sdp.is_empty() {
            bail!("answer arrived before the offer was sent");
        }
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
    mailboxes: Mailboxes,
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
                    request_close(&mailboxes, &peer_id).await; // counter overflow — fail closed
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
    mailboxes: Mailboxes,
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
                        request_close(&mailboxes, &peer_id).await;
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
                        request_close(&mailboxes, &peer_id).await; // fail closed
                        return;
                    }
                }
            };
            let Ok(env) = serde_json::from_slice::<Value>(&opened.plaintext) else {
                request_close(&mailboxes, &peer_id).await;
                return;
            };
            let t = env.get("t").and_then(|t| t.as_str()).unwrap_or("");
            let confirmed = {
                let map = peers.lock().await;
                map.get(&peer_id).map(|p| p.confirmed).unwrap_or(false)
            };
            if !confirmed {
                if t != "confirm" {
                    request_close(&mailboxes, &peer_id).await;
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
                "stdin" => {
                    // Fast path for interactive terminal input. The receiver
                    // loop is serialized, so writes preserve DataChannel order
                    // without spawning one Tokio task per key. Keep the scoped
                    // API boundary: read-only/agent-scoped shares must enforce
                    // exactly the same permissions as POST /api/send.
                    let seq = env.get("seq").and_then(Value::as_u64).unwrap_or(0);
                    let pid = env.get("pid").and_then(Value::as_str).unwrap_or("");
                    let msg = env.get("msg").and_then(Value::as_str).unwrap_or("");
                    let body = json!({"keyword": pid, "msg": msg, "code": "none"}).to_string();
                    let res =
                        super::agent_share::scoped_handle(&scope, "POST", "/api/send", &body).await;
                    let mut ack = json!({"t":"stdin_ack","seq":seq,"status":res.status});
                    if !(200..300).contains(&res.status) {
                        if let api::Body::Full(bytes) = res.body {
                            ack["error"] = Value::String(
                                String::from_utf8_lossy(&bytes).chars().take(256).collect(),
                            );
                        }
                    }
                    let out_tx = {
                        let map = peers.lock().await;
                        match map.get(&peer_id) {
                            Some(p) => p.out_tx.clone(),
                            None => return,
                        }
                    };
                    let _ = out_tx.send((0, ack));
                }
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
                    let trace_span = request_trace_span(&env);
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
                        serve_request(out_tx, id2.clone(), method, path, body, trace_span, scope2)
                            .await;
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
    trace: Option<String>,
    scope: Arc<Scope>,
) {
    let request_started = std::time::Instant::now();
    let res = super::agent_share::scoped_handle(&scope, &method, &path, &body).await;
    let host_api_ms = request_started.elapsed().as_secs_f64() * 1000.0;
    let trace_for = |seq: u64| {
        trace.as_ref().map(|span| {
            json!({
                "span": span,
                "seq": seq,
                "hostQueuedMs": unix_time_ms(),
                "hostApiMs": host_api_ms,
            })
        })
    };
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
            let trace = trace_for(*seq);
            let mut envelope = json!({"t":"data","id":id,"seq":*seq,"chunk":chunk});
            if let Some(trace) = trace {
                envelope["trace"] = trace;
            }
            if out_tx.send((0, envelope)).is_err() {
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

fn unix_time_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn request_trace_span(env: &Value) -> Option<String> {
    env.get("trace")
        .and_then(|t| t.get("span"))
        .and_then(|s| s.as_str())
        .filter(|s| s.len() <= 96)
        .map(str::to_owned)
}

#[cfg(test)]
mod latency_trace_tests {
    use super::*;

    #[test]
    fn trace_span_is_bounded_and_optional() {
        assert_eq!(
            request_trace_span(&json!({"trace":{"span":"room:42"}})).as_deref(),
            Some("room:42")
        );
        assert_eq!(request_trace_span(&json!({})), None);
        assert_eq!(
            request_trace_span(&json!({"trace":{"span":"x".repeat(97)}})),
            None
        );
    }
}
