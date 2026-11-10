//! One UDP socket shared by every share peer connection
//! (`AGENT_YES_ICE_UDP_PORT`), routing each packet to its ICE session.
//!
//! Replaces webrtc-ice's `UDPMuxDefault`, which routes by source address
//! first and only falls back to the STUN USERNAME for addresses it has not
//! seen. Its address table also outlives the sessions: a closing connection
//! clears its own address list before the mux reads it to clean up, so every
//! address a finished peer ever talked to stays mapped to that dead
//! connection. Behind Docker Desktop's port forwarder every viewer arrives
//! from the same rewritten source IP, so a viewer whose forwarded port was
//! used before has its connectivity checks swallowed by a closed session and
//! never gets an answer: inbound checks, no outbound packets at all.
//!
//! Here a STUN message that names a session (USERNAME = `<our ufrag>:…`) is
//! always routed by that name, and re-binds its source address to it. Other
//! packets (DTLS, SCTP, STUN responses) follow the address table, whose
//! entries are dropped by session key when a session goes away.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex as StdMutex, Weak};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use tokio::net::UdpSocket;
use tokio::sync::watch;
use webrtc::ice::udp_mux::{UDPMux, UDPMuxConn, UDPMuxConnParams, UDPMuxWriter};
use webrtc::stun::attributes::ATTR_USERNAME;
use webrtc::stun::message::{is_message as is_stun_message, Message as StunMessage};
use webrtc::util::{Conn, Error};

/// Large enough for any packet a peer connection receives (webrtc-ice's
/// RECEIVE_MTU).
const RECEIVE_MTU: usize = 8192;

pub struct IceMux {
    socket: Arc<UdpSocket>,
    local_addr: SocketAddr,
    /// Live sessions by our local ufrag.
    conns: StdMutex<HashMap<String, UDPMuxConn>>,
    /// Remote address → the ufrag of the session that last used it.
    addrs: StdMutex<HashMap<SocketAddr, String>>,
    closed: watch::Sender<bool>,
    /// Rate limit for the "unknown session" log line.
    last_unknown_log: StdMutex<Option<Instant>>,
}

impl IceMux {
    pub fn new(socket: UdpSocket) -> std::io::Result<Arc<Self>> {
        let local_addr = socket.local_addr()?;
        let (closed, _) = watch::channel(false);
        let mux = Arc::new(IceMux {
            socket: Arc::new(socket),
            local_addr,
            conns: StdMutex::default(),
            addrs: StdMutex::default(),
            closed,
            last_unknown_log: StdMutex::new(None),
        });
        mux.clone().spawn_reader();
        Ok(mux)
    }

    fn spawn_reader(self: Arc<Self>) {
        let mut closed = self.closed.subscribe();
        let weak = Arc::downgrade(&self);
        let socket = self.socket.clone();
        drop(self);
        tokio::spawn(async move {
            let mut buf = vec![0u8; RECEIVE_MTU];
            loop {
                let (len, addr) = tokio::select! {
                    r = socket.recv_from(&mut buf) => match r {
                        Ok(v) => v,
                        // ICMP port unreachable from an earlier send shows up
                        // here on some platforms; it is not fatal.
                        Err(_) => continue,
                    },
                    _ = closed.changed() => return,
                };
                let Some(mux) = weak.upgrade() else { return };
                if let Some(conn) = mux.route(&buf[..len], addr) {
                    let _ = conn.write_packet(&buf[..len], addr).await;
                }
            }
        });
    }

    /// The session a packet belongs to, or None to drop it.
    fn route(&self, pkt: &[u8], addr: SocketAddr) -> Option<UDPMuxConn> {
        if is_stun_message(pkt) {
            if let Some(ufrag) = stun_target_ufrag(pkt) {
                let conn = self.live_conn(&ufrag);
                match &conn {
                    Some(_) => {
                        self.addrs.lock().unwrap().insert(addr, ufrag);
                    }
                    None => self.log_unknown(&ufrag, addr),
                }
                return conn;
            }
        }
        let ufrag = self.addrs.lock().unwrap().get(&addr).cloned()?;
        self.live_conn(&ufrag)
    }

    fn live_conn(&self, ufrag: &str) -> Option<UDPMuxConn> {
        self.conns
            .lock()
            .unwrap()
            .get(ufrag)
            .filter(|c| !c.is_closed())
            .cloned()
    }

    fn log_unknown(&self, ufrag: &str, addr: SocketAddr) {
        let mut last = self.last_unknown_log.lock().unwrap();
        if last.is_some_and(|t| t.elapsed() < Duration::from_secs(10)) {
            return;
        }
        *last = Some(Instant::now());
        eprintln!(
            "[ayrs share] ICE check from {addr} for session {ufrag}, which this host no longer has (a viewer still retrying an old offer?)"
        );
    }

    fn forget(&self, ufrag: &str) {
        self.conns.lock().unwrap().remove(ufrag);
        self.addrs.lock().unwrap().retain(|_, k| k != ufrag);
    }
}

/// Our ufrag from a STUN request's USERNAME (`<receiver ufrag>:<sender ufrag>`).
/// None for messages without one, such as Binding responses.
fn stun_target_ufrag(pkt: &[u8]) -> Option<String> {
    let mut m = StunMessage::new();
    m.unmarshal_binary(pkt).ok()?;
    let (attr, found) = m.attributes.get(ATTR_USERNAME);
    if !found {
        return None;
    }
    let s = String::from_utf8(attr.value).ok()?;
    let ufrag = s.split(':').next()?.to_string();
    (!ufrag.is_empty()).then_some(ufrag)
}

#[async_trait]
impl UDPMux for IceMux {
    async fn close(&self) -> Result<(), Error> {
        let _ = self.closed.send(true);
        let conns: Vec<UDPMuxConn> = self.conns.lock().unwrap().drain().map(|(_, c)| c).collect();
        for c in conns {
            c.close();
        }
        self.addrs.lock().unwrap().clear();
        Ok(())
    }

    async fn get_conn(self: Arc<Self>, ufrag: &str) -> Result<Arc<dyn Conn + Send + Sync>, Error> {
        if *self.closed.borrow() {
            return Err(Error::ErrUseClosedNetworkConn);
        }
        if let Some(c) = self.live_conn(ufrag) {
            return Ok(Arc::new(c));
        }
        let writer: Weak<dyn UDPMuxWriter + Send + Sync> =
            Arc::downgrade(&self) as Weak<dyn UDPMuxWriter + Send + Sync>;
        let conn = UDPMuxConn::new(UDPMuxConnParams {
            local_addr: self.local_addr,
            key: ufrag.to_string(),
            udp_mux: writer,
        });
        self.conns
            .lock()
            .unwrap()
            .insert(ufrag.to_string(), conn.clone());
        // Forget the session, and every address it used, when it closes.
        let mut close_rx = conn.close_rx();
        let weak = Arc::downgrade(&self);
        let key = ufrag.to_string();
        tokio::spawn(async move {
            let _ = close_rx.changed().await;
            if let Some(mux) = weak.upgrade() {
                mux.forget(&key);
            }
        });
        Ok(Arc::new(conn))
    }

    async fn remove_conn_by_ufrag(&self, ufrag: &str) {
        let conn = self.conns.lock().unwrap().get(ufrag).cloned();
        self.forget(ufrag);
        if let Some(c) = conn {
            c.close();
        }
    }
}

#[async_trait]
impl UDPMuxWriter for IceMux {
    async fn register_conn_for_address(&self, conn: &UDPMuxConn, addr: SocketAddr) {
        self.addrs
            .lock()
            .unwrap()
            .insert(addr, conn.key().to_string());
    }

    async fn send_to(&self, buf: &[u8], target: &SocketAddr) -> Result<usize, Error> {
        Ok(self.socket.send_to(buf, target).await?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use webrtc::stun::agent::TransactionId;
    use webrtc::stun::message::{Setter, BINDING_REQUEST};
    use webrtc::stun::textattrs::Username;

    fn binding_request(username: &str) -> Vec<u8> {
        let mut m = StunMessage::new();
        let setters: Vec<Box<dyn Setter>> = vec![
            Box::new(BINDING_REQUEST),
            Box::new(TransactionId::new()),
            Box::new(Username::new(ATTR_USERNAME, username.to_string())),
        ];
        m.build(&setters).unwrap();
        m.raw
    }

    async fn mux() -> Arc<IceMux> {
        IceMux::new(UdpSocket::bind("127.0.0.1:0").await.unwrap()).unwrap()
    }

    #[test]
    fn reads_our_ufrag_from_the_username() {
        assert_eq!(
            stun_target_ufrag(&binding_request("hostUfrag:viewerUfrag")).as_deref(),
            Some("hostUfrag")
        );
        assert_eq!(stun_target_ufrag(b"not stun at all, just bytes"), None);
    }

    /// The Docker case: a viewer arrives from an address a finished session
    /// used. Its checks must reach the live session that they name.
    #[tokio::test]
    async fn a_check_follows_its_username_not_a_stale_address() {
        let m = mux().await;
        let addr: SocketAddr = "192.0.2.7:40000".parse().unwrap();
        let old = m.clone().get_conn("old").await.unwrap();
        let _new = m.clone().get_conn("new").await.unwrap();
        m.addrs.lock().unwrap().insert(addr, "old".into());
        old.close().await.unwrap();

        let routed = m.route(&binding_request("new:viewer"), addr).unwrap();
        assert_eq!(routed.key(), "new");
        // ...and the address now belongs to the live session for DTLS/SCTP.
        assert_eq!(m.route(b"\x16\xfe\xfd dtls", addr).unwrap().key(), "new");
    }

    #[tokio::test]
    async fn a_closed_session_leaves_nothing_behind() {
        let m = mux().await;
        let addr: SocketAddr = "192.0.2.7:40001".parse().unwrap();
        let c = m.clone().get_conn("gone").await.unwrap();
        m.route(&binding_request("gone:viewer"), addr).unwrap();
        c.close().await.unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while m.addrs.lock().unwrap().contains_key(&addr) {
            assert!(Instant::now() < deadline, "address outlived its session");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(m.route(&binding_request("gone:viewer"), addr).is_none());
        assert!(m.route(b"\x16\xfe\xfd dtls", addr).is_none());
    }
}
