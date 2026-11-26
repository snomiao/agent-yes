//! Where the share host's ICE listens and what address it advertises.
//!
//! By default every peer connection gathers on fresh ephemeral UDP ports and
//! learns its public address from STUN. Behind a symmetric NAT (Docker
//! Desktop's network, see nat_probe.rs) neither works: the ports are not
//! reachable from outside and the STUN-mapped port is not the one a viewer
//! would see. Two settings make the host reachable through one forwarded port
//! instead, with no relay:
//!
//! - `AGENT_YES_ICE_UDP_PORT=47000`: all peer connections share one UDP socket
//!   on that port (ICE UDP mux), so one port mapping (`-p 47000:47000/udp`)
//!   covers every viewer.
//! - `AGENT_YES_ICE_PUBLIC_IPS=192.0.2.10[,…]`: advertise these addresses in
//!   place of the container's own (1:1 NAT), e.g. the Docker host's LAN IP.
//!   `auto` asks a STUN server for this host's public IP, which only helps
//!   when that port is forwarded on the router too. `auto` may sit in the
//!   list next to plain addresses (`auto,100.64.0.7`).
//!
//! webrtc-rs maps each local address to ONE external address, so only the
//! first address per IP family becomes the 1:1 NAT address. Every further one
//! (e.g. the host's tailnet IP next to its public IP) is offered as an extra
//! copy of each host candidate: same port, other address. That is what lets a
//! container on a userspace-networking tailnet be reached on its tailnet IP,
//! which no local interface carries.
//!
//! The socket is shared through ice_mux.rs. A muxed socket gathers host candidates only (no server-reflexive ones);
//! TURN relay candidates are unaffected.

use anyhow::{bail, Context, Result};
use std::sync::Arc;
use tokio::sync::OnceCell;
use webrtc::api::setting_engine::SettingEngine;
use webrtc::api::{APIBuilder, API};
use webrtc::ice::network_type::NetworkType;
use webrtc::ice::udp_network::UDPNetwork;
use webrtc::ice_transport::ice_candidate_type::RTCIceCandidateType;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct IceNetConfig {
    pub udp_port: Option<u16>,
    /// None: advertise the real interface addresses. `auto` is resolved by
    /// `resolve` before use.
    pub public_ips: Option<PublicIps>,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct PublicIps {
    /// Also advertise the public IP a STUN server sees.
    pub auto: bool,
    pub ips: Vec<String>,
}

pub fn parse(udp_port: Option<&str>, public_ips: Option<&str>) -> Result<IceNetConfig> {
    let udp_port = match udp_port.map(str::trim).filter(|s| !s.is_empty()) {
        None => None,
        Some(s) => match s.parse::<u16>() {
            Ok(p) if p > 0 => Some(p),
            _ => bail!("AGENT_YES_ICE_UDP_PORT must be a port number 1-65535, got {s:?}"),
        },
    };
    let public_ips = match public_ips.map(str::trim).filter(|s| !s.is_empty()) {
        None => None,
        Some(s) => {
            let mut auto = false;
            let mut ips: Vec<String> = Vec::new();
            for x in s.split(',').map(str::trim).filter(|x| !x.is_empty()) {
                if x.eq_ignore_ascii_case("auto") {
                    auto = true;
                } else {
                    ips.push(x.to_string());
                }
            }
            for ip in &ips {
                // webrtc-rs also takes "external/local" pairs.
                for part in ip.split('/') {
                    part.parse::<std::net::IpAddr>().with_context(|| {
                        format!("AGENT_YES_ICE_PUBLIC_IPS: {ip:?} is not an IP address")
                    })?;
                }
            }
            Some(PublicIps { auto, ips })
        }
    };
    Ok(IceNetConfig {
        udp_port,
        public_ips,
    })
}

/// The settings every share peer connection is built with, read once.
struct IceNet {
    mux: Option<Arc<super::ice_mux::IceMux>>,
    public_ips: Vec<String>,
    /// Advertised as extra host-candidate copies (see the module doc).
    extra_ips: Vec<std::net::IpAddr>,
}

static ICE_NET: OnceCell<IceNet> = OnceCell::const_new();

async fn ice_net() -> Result<&'static IceNet> {
    ICE_NET
        .get_or_try_init(|| async {
            let cfg = parse(
                std::env::var("AGENT_YES_ICE_UDP_PORT").ok().as_deref(),
                std::env::var("AGENT_YES_ICE_PUBLIC_IPS").ok().as_deref(),
            )?;
            let mux = match cfg.udp_port {
                None => None,
                Some(port) => {
                    let sock = tokio::net::UdpSocket::bind(("0.0.0.0", port))
                        .await
                        .with_context(|| format!("bind ICE UDP port {port}"))?;
                    Some(super::ice_mux::IceMux::new(sock)?)
                }
            };
            let mut all = vec![];
            if let Some(p) = cfg.public_ips {
                if p.auto {
                    let kind = tokio::task::spawn_blocking(super::nat_probe::probe)
                        .await?
                        .context("AGENT_YES_ICE_PUBLIC_IPS=auto: STUN lookup")?;
                    all.push(super::nat_probe::public_addr(&kind).ip().to_string());
                }
                for ip in p.ips {
                    if !all.contains(&ip) {
                        all.push(ip);
                    }
                }
            }
            let (public_ips, extra_ips) = split_primary(all);
            let public_ips = pin_to_local(public_ips, primary_local_ipv4());
            Ok(IceNet {
                mux,
                public_ips,
                extra_ips,
            })
        })
        .await
}

/// The address this host sends from by default (the interface of its default
/// route). `connect` on a UDP socket only picks the route; nothing is sent.
fn primary_local_ipv4() -> Option<std::net::IpAddr> {
    let s = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("192.0.2.1:9").ok()?;
    Some(s.local_addr().ok()?.ip())
}

/// The first bare address per IP family (and every explicit `ext/local`
/// pair) is a 1:1 NAT address; the remaining bare ones are extra addresses.
fn split_primary(ips: Vec<String>) -> (Vec<String>, Vec<std::net::IpAddr>) {
    let (mut primary, mut extra) = (Vec::new(), Vec::new());
    let (mut v4, mut v6) = (false, false);
    for ip in ips {
        let Ok(addr) = ip.parse::<std::net::IpAddr>() else {
            primary.push(ip); // an `ext/local` pair
            continue;
        };
        let seen = if addr.is_ipv4() { &mut v4 } else { &mut v6 };
        if *seen {
            extra.push(addr);
        } else {
            *seen = true;
            primary.push(ip);
        }
    }
    (primary, extra)
}

/// Copies of a gathered host candidate (`candidate:…` line) at each extra
/// address of the same family: same port, priority one lower so the real
/// address stays preferred when both work. Not a UDP host candidate: none.
pub fn extra_candidates(candidate: &str) -> Vec<String> {
    match ICE_NET.get() {
        Some(n) if !n.extra_ips.is_empty() => copies_at(candidate, &n.extra_ips),
        _ => vec![],
    }
}

fn copies_at(candidate: &str, extra: &[std::net::IpAddr]) -> Vec<String> {
    // candidate:<foundation> <component> <transport> <priority> <address> <port> typ <type> …
    let f: Vec<&str> = candidate.split(' ').collect();
    if f.len() < 8 || !f[2].eq_ignore_ascii_case("udp") || f[6] != "typ" || f[7] != "host" {
        return vec![];
    }
    let Ok(addr) = f[4].parse::<std::net::IpAddr>() else {
        return vec![];
    };
    let Ok(prio) = f[3].parse::<u32>() else {
        return vec![];
    };
    extra
        .iter()
        .filter(|e| e.is_ipv4() == addr.is_ipv4() && **e != addr)
        .map(|e| {
            let mut g: Vec<String> = f.iter().map(|x| x.to_string()).collect();
            g[3] = prio.saturating_sub(1).to_string();
            g[4] = e.to_string();
            g.join(" ")
        })
        .collect()
}

/// Pin each bare external IP to one local address (`external/local`).
///
/// A bare IP is applied to EVERY local interface, so a host with two (eth0
/// plus tailscale0 in a container) gathers two identical candidates. webrtc-rs
/// then closes the duplicate, and on a muxed port that closes the socket the
/// whole session shares: the session is gone before the viewer's first
/// check arrives. Pinning to the default-route address yields one candidate.
/// Pairs the user wrote (`ext/local`) are kept as they are.
fn pin_to_local(ips: Vec<String>, local: Option<std::net::IpAddr>) -> Vec<String> {
    let Some(local) = local else { return ips };
    ips.into_iter()
        .map(|ip| {
            let same_family = ip
                .parse::<std::net::IpAddr>()
                .is_ok_and(|e| e.is_ipv4() == local.is_ipv4());
            if same_family {
                format!("{ip}/{local}")
            } else {
                ip
            }
        })
        .collect()
}

/// Called once at share startup so a bad value or a busy port shows up in
/// the log right away rather than as a failed peer. Returns a line to log
/// when anything is configured.
pub async fn init() -> Result<Option<String>> {
    let n = ice_net().await?;
    let port = n.mux.as_ref().map(|_| {
        std::env::var("AGENT_YES_ICE_UDP_PORT")
            .unwrap_or_default()
            .trim()
            .to_string()
    });
    let mut shown: Vec<String> = n.public_ips.clone();
    shown.extend(n.extra_ips.iter().map(|ip| ip.to_string()));
    Ok(match (port, shown.is_empty()) {
        (None, true) => None,
        (port, _) => Some(format!(
            "ICE {}{}",
            port.map(|p| format!("on one UDP port {p}"))
                .unwrap_or_else(|| "on ephemeral UDP ports".into()),
            if shown.is_empty() {
                String::new()
            } else {
                format!(", advertising {}", shown.join(", "))
            }
        )),
    })
}

pub fn is_configured() -> bool {
    ICE_NET
        .get()
        .is_some_and(|n| n.mux.is_some() || !n.public_ips.is_empty() || !n.extra_ips.is_empty())
}

/// The webrtc API for one share peer connection.
pub async fn api() -> Result<API> {
    let n = ice_net().await?;
    let mut s = SettingEngine::default();
    if let Some(mux) = &n.mux {
        s.set_udp_network(UDPNetwork::Muxed(mux.clone()));
        // The muxed socket is IPv4; an IPv6 host candidate on it would never work.
        s.set_network_types(vec![NetworkType::Udp4]);
    }
    if !n.public_ips.is_empty() {
        s.set_nat_1to1_ips(n.public_ips.clone(), RTCIceCandidateType::Host);
    }
    Ok(APIBuilder::new().with_setting_engine(s).build())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_port_and_public_ips() {
        assert_eq!(parse(None, None).unwrap(), IceNetConfig::default());
        assert_eq!(parse(Some(" "), Some("")).unwrap(), IceNetConfig::default());
        let c = parse(Some("47000"), Some("192.0.2.10, 198.51.100.7/172.17.0.2")).unwrap();
        assert_eq!(c.udp_port, Some(47000));
        assert_eq!(
            c.public_ips,
            Some(PublicIps {
                auto: false,
                ips: vec!["192.0.2.10".into(), "198.51.100.7/172.17.0.2".into()]
            })
        );
        assert_eq!(
            parse(None, Some("AUTO")).unwrap().public_ips,
            Some(PublicIps {
                auto: true,
                ips: vec![]
            })
        );
        assert_eq!(
            parse(None, Some("auto, 100.64.0.7")).unwrap().public_ips,
            Some(PublicIps {
                auto: true,
                ips: vec!["100.64.0.7".into()]
            })
        );
    }

    #[test]
    fn only_the_first_address_per_family_is_the_nat_address() {
        let (primary, extra) = split_primary(vec![
            "192.0.2.10".into(),
            "100.64.0.7".into(),
            "198.51.100.7/172.17.0.2".into(),
            "2001:db8::1".into(),
        ]);
        assert_eq!(
            primary,
            vec!["192.0.2.10", "198.51.100.7/172.17.0.2", "2001:db8::1"]
        );
        assert_eq!(
            extra,
            vec!["100.64.0.7".parse::<std::net::IpAddr>().unwrap()]
        );
    }

    #[test]
    fn extra_addresses_copy_udp_host_candidates_only() {
        let extra = [
            "100.64.0.7".parse().unwrap(),
            "2001:db8::1".parse().unwrap(),
        ];
        assert_eq!(
            copies_at(
                "candidate:1 1 udp 2130706431 192.0.2.10 47000 typ host",
                &extra
            ),
            vec!["candidate:1 1 udp 2130706430 100.64.0.7 47000 typ host".to_string()]
        );
        assert!(copies_at(
            "candidate:2 1 udp 1694498815 192.0.2.10 5000 typ srflx raddr 0.0.0.0 rport 0",
            &extra
        )
        .is_empty());
        assert!(copies_at("candidate:3 1 tcp 1 192.0.2.10 9 typ host", &extra).is_empty());
        assert!(copies_at("", &extra).is_empty());
    }

    #[test]
    fn bare_external_ips_are_pinned_to_the_default_route_address() {
        let local = Some("172.18.0.2".parse().unwrap());
        assert_eq!(
            pin_to_local(vec!["192.0.2.10".into()], local),
            vec!["192.0.2.10/172.18.0.2".to_string()]
        );
        // Explicit pairs and other families are left alone.
        assert_eq!(
            pin_to_local(
                vec!["192.0.2.10/10.0.0.5".into(), "2001:db8::1".into()],
                local
            ),
            vec!["192.0.2.10/10.0.0.5".to_string(), "2001:db8::1".to_string()]
        );
        assert_eq!(
            pin_to_local(vec!["192.0.2.10".into()], None),
            vec!["192.0.2.10".to_string()]
        );
    }

    #[test]
    fn rejects_bad_values() {
        assert!(parse(Some("0"), None).is_err());
        assert!(parse(Some("70000"), None).is_err());
        assert!(parse(Some("udp"), None).is_err());
        assert!(parse(None, Some("tak.local")).is_err());
    }
}
