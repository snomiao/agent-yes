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
//!   when that port is forwarded on the router too.
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

#[derive(Debug, PartialEq, Eq)]
pub enum PublicIps {
    Auto,
    List(Vec<String>),
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
        Some(s) if s.eq_ignore_ascii_case("auto") => Some(PublicIps::Auto),
        Some(s) => {
            let ips: Vec<String> = s.split(',').map(|x| x.trim().to_string()).collect();
            for ip in &ips {
                // webrtc-rs also takes "external/local" pairs.
                for part in ip.split('/') {
                    part.parse::<std::net::IpAddr>().with_context(|| {
                        format!("AGENT_YES_ICE_PUBLIC_IPS: {ip:?} is not an IP address")
                    })?;
                }
            }
            Some(PublicIps::List(ips))
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
            let public_ips = match cfg.public_ips {
                None => vec![],
                Some(PublicIps::List(ips)) => ips,
                Some(PublicIps::Auto) => {
                    let kind = tokio::task::spawn_blocking(super::nat_probe::probe)
                        .await?
                        .context("AGENT_YES_ICE_PUBLIC_IPS=auto: STUN lookup")?;
                    vec![super::nat_probe::public_addr(&kind).ip().to_string()]
                }
            };
            let public_ips = pin_to_local(public_ips, primary_local_ipv4());
            Ok(IceNet { mux, public_ips })
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
    Ok(match (port, n.public_ips.is_empty()) {
        (None, true) => None,
        (port, _) => Some(format!(
            "ICE {}{}",
            port.map(|p| format!("on one UDP port {p}"))
                .unwrap_or_else(|| "on ephemeral UDP ports".into()),
            if n.public_ips.is_empty() {
                String::new()
            } else {
                format!(", advertising {}", n.public_ips.join(", "))
            }
        )),
    })
}

pub fn is_configured() -> bool {
    ICE_NET
        .get()
        .is_some_and(|n| n.mux.is_some() || !n.public_ips.is_empty())
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
            Some(PublicIps::List(vec![
                "192.0.2.10".into(),
                "198.51.100.7/172.17.0.2".into()
            ]))
        );
        assert_eq!(
            parse(None, Some("AUTO")).unwrap().public_ips,
            Some(PublicIps::Auto)
        );
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
