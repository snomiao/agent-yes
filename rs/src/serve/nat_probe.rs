//! Startup NAT check for the share host: does this machine's NAT give one
//! UDP socket the same public port toward every destination?
//!
//! WebRTC's direct path (a server-reflexive candidate) only works when it
//! does. Behind an endpoint-dependent ("symmetric") NAT the port a STUN
//! server reports is not the port a viewer would see, so no direct pair ever
//! succeeds: the share needs a TURN relay or a forwarded port. Docker Desktop on
//! macOS is one: its user-space network stack maps each destination to a new
//! port, so a container's share signals fine and then never opens a data
//! channel. This probe sends one STUN Binding request from a single socket to
//! two servers and compares the mapped ports, so the host can say so in its
//! log instead of failing silently per viewer.

use anyhow::{bail, Context, Result};
use std::net::{SocketAddr, ToSocketAddrs, UdpSocket};
use std::time::Duration;

const SERVERS: [&str; 2] = ["stun.l.google.com:19302", "stun.cloudflare.com:3478"];
const MAGIC_COOKIE: u32 = 0x2112_A442;
const ATTR_MAPPED_ADDRESS: u16 = 0x0001;
const ATTR_XOR_MAPPED_ADDRESS: u16 = 0x0020;

#[derive(Debug, PartialEq, Eq)]
pub enum NatKind {
    /// Every server saw the same public address: direct connections can work.
    Consistent(SocketAddr),
    /// The servers saw different public ports for the same socket.
    Symmetric(SocketAddr, SocketAddr),
}

pub fn classify(a: SocketAddr, b: SocketAddr) -> NatKind {
    if a == b {
        NatKind::Consistent(a)
    } else {
        NatKind::Symmetric(a, b)
    }
}

/// The public address the first server saw.
pub fn public_addr(kind: &NatKind) -> SocketAddr {
    match kind {
        NatKind::Consistent(a) | NatKind::Symmetric(a, _) => *a,
    }
}

/// Blocking; a few seconds at most. Run it off the async runtime.
pub fn probe() -> Result<NatKind> {
    let sock = UdpSocket::bind("0.0.0.0:0").context("bind a UDP socket")?;
    sock.set_read_timeout(Some(Duration::from_millis(1500)))?;
    let mut mapped = Vec::with_capacity(SERVERS.len());
    for server in SERVERS {
        let addr = server
            .to_socket_addrs()
            .with_context(|| format!("resolve {server}"))?
            .find(SocketAddr::is_ipv4)
            .with_context(|| format!("no IPv4 address for {server}"))?;
        mapped.push(binding(&sock, addr).with_context(|| format!("STUN {server}"))?);
    }
    Ok(classify(mapped[0], mapped[1]))
}

/// One Binding request, retried once on timeout (UDP may drop the first).
fn binding(sock: &UdpSocket, server: SocketAddr) -> Result<SocketAddr> {
    let txid: [u8; 12] = rand::random();
    let mut req = Vec::with_capacity(20);
    req.extend_from_slice(&0x0001u16.to_be_bytes()); // Binding request
    req.extend_from_slice(&0u16.to_be_bytes()); // no attributes
    req.extend_from_slice(&MAGIC_COOKIE.to_be_bytes());
    req.extend_from_slice(&txid);
    let mut buf = [0u8; 512];
    for _ in 0..2 {
        sock.send_to(&req, server)?;
        loop {
            match sock.recv_from(&mut buf) {
                Ok((n, from)) if from == server => {
                    if let Ok(addr) = parse_binding_response(&buf[..n], &txid) {
                        return Ok(addr);
                    }
                }
                Ok(_) => continue,
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
                {
                    break
                }
                Err(e) => return Err(e.into()),
            }
        }
    }
    bail!("no response")
}

/// The public address in a Binding success response: XOR-MAPPED-ADDRESS, or
/// the older MAPPED-ADDRESS. IPv4 only, like the socket that asked.
pub fn parse_binding_response(msg: &[u8], txid: &[u8; 12]) -> Result<SocketAddr> {
    if msg.len() < 20 || msg[0..2] != [0x01, 0x01] {
        bail!("not a Binding success response");
    }
    if msg[4..8] != MAGIC_COOKIE.to_be_bytes() || &msg[8..20] != txid {
        bail!("not our transaction");
    }
    let end = (20 + u16::from_be_bytes([msg[2], msg[3]]) as usize).min(msg.len());
    let mut at = 20;
    let mut plain = None;
    while at + 4 <= end {
        let ty = u16::from_be_bytes([msg[at], msg[at + 1]]);
        let len = u16::from_be_bytes([msg[at + 2], msg[at + 3]]) as usize;
        let val = &msg[at + 4..(at + 4 + len).min(end)];
        if val.len() >= 8 && val[1] == 0x01 {
            let port = u16::from_be_bytes([val[2], val[3]]);
            let ip = [val[4], val[5], val[6], val[7]];
            if ty == ATTR_XOR_MAPPED_ADDRESS {
                let c = MAGIC_COOKIE.to_be_bytes();
                let port = port ^ (MAGIC_COOKIE >> 16) as u16;
                let ip = [ip[0] ^ c[0], ip[1] ^ c[1], ip[2] ^ c[2], ip[3] ^ c[3]];
                return Ok(SocketAddr::from((ip, port)));
            }
            if ty == ATTR_MAPPED_ADDRESS {
                plain = Some(SocketAddr::from((ip, port)));
            }
        }
        at += 4 + len.div_ceil(4) * 4;
    }
    plain.context("no mapped address in the response")
}

/// What the share host logs at startup, or None when there is nothing to say.
/// `ice_configured`: AGENT_YES_ICE_UDP_PORT / AGENT_YES_ICE_PUBLIC_IPS are set,
/// which is the no-relay way out, so only a note is due.
pub fn startup_warning(kind: &NatKind, ice_configured: bool) -> Option<String> {
    match kind {
        NatKind::Consistent(_) => None,
        NatKind::Symmetric(a, b) if ice_configured => Some(format!(
            "this host is behind a symmetric NAT (two STUN servers saw {a} and {b}); \
             relying on AGENT_YES_ICE_UDP_PORT / AGENT_YES_ICE_PUBLIC_IPS being reachable from viewers."
        )),
        NatKind::Symmetric(a, b) => Some(format!(
            "this host is behind a symmetric NAT (two STUN servers saw {a} and {b}), \
             e.g. Docker Desktop's network: viewers cannot reach it directly. \
             Either publish one UDP port and set AGENT_YES_ICE_UDP_PORT + AGENT_YES_ICE_PUBLIC_IPS, \
             give it a TURN relay (CF_TURN_KEY_ID + CF_TURN_API_TOKEN), \
             or set AGENT_YES_SIGNAL_RELAY=1 here and on the viewers to relay through signaling."
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TXID: [u8; 12] = [7; 12];

    fn response(attr_type: u16, value: &[u8]) -> Vec<u8> {
        let mut m = vec![0x01, 0x01];
        m.extend_from_slice(&((4 + value.len()) as u16).to_be_bytes());
        m.extend_from_slice(&MAGIC_COOKIE.to_be_bytes());
        m.extend_from_slice(&TXID);
        m.extend_from_slice(&attr_type.to_be_bytes());
        m.extend_from_slice(&(value.len() as u16).to_be_bytes());
        m.extend_from_slice(value);
        m
    }

    #[test]
    fn reads_the_xor_mapped_address() {
        // 203.0.113.5:50000 XORed with the magic cookie (RFC 5389 §15.2).
        let port = 50000u16 ^ 0x2112;
        let c = MAGIC_COOKIE.to_be_bytes();
        let ip = [203 ^ c[0], 0 ^ c[1], 113 ^ c[2], 5 ^ c[3]];
        let mut v = vec![0, 1];
        v.extend_from_slice(&port.to_be_bytes());
        v.extend_from_slice(&ip);
        let addr = parse_binding_response(&response(ATTR_XOR_MAPPED_ADDRESS, &v), &TXID).unwrap();
        assert_eq!(addr, "203.0.113.5:50000".parse::<SocketAddr>().unwrap());
    }

    #[test]
    fn falls_back_to_the_plain_mapped_address() {
        let v = [0, 1, 0xC3, 0x50, 198, 51, 100, 7];
        let addr = parse_binding_response(&response(ATTR_MAPPED_ADDRESS, &v), &TXID).unwrap();
        assert_eq!(addr, "198.51.100.7:50000".parse::<SocketAddr>().unwrap());
    }

    #[test]
    fn rejects_someone_elses_transaction() {
        let v = [0, 1, 0xC3, 0x50, 198, 51, 100, 7];
        assert!(parse_binding_response(&response(ATTR_MAPPED_ADDRESS, &v), &[8; 12]).is_err());
        assert!(parse_binding_response(&[0x01, 0x01, 0, 0], &TXID).is_err());
    }

    #[test]
    fn only_a_changing_mapping_warns() {
        let a: SocketAddr = "203.0.113.5:50000".parse::<SocketAddr>().unwrap();
        let b: SocketAddr = "203.0.113.5:50001".parse::<SocketAddr>().unwrap();
        assert_eq!(startup_warning(&classify(a, a), false), None);
        let w = startup_warning(&classify(a, b), false).unwrap();
        assert!(w.contains("symmetric NAT") && w.contains(":50001"), "{w}");
        assert!(w.contains("TURN relay"), "{w}");
        let w = startup_warning(&classify(a, b), true).unwrap();
        assert!(!w.contains("TURN relay"), "{w}");
    }
}
