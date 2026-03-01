//! Swarm URL parsing and room code handling
//!
//! Supports multiple formats:
//! - Topic-only: `my-project` (LAN auto-discovery via mDNS)
//! - Room code: `ABC-123` (6-char, easy to share verbally)
//! - Swarm URL: `ay://my-project?peer=/ip4/1.2.3.4/tcp/4001/p2p/QmXxx`
//! - Raw multiaddr: `/ip4/1.2.3.4/tcp/4001/p2p/QmXxx`

use rand::Rng;

/// Characters allowed in room codes (no ambiguous chars: 0/O, 1/I/L excluded)
const ROOM_CODE_CHARS: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/// Configuration parsed from swarm value
#[derive(Debug, Clone, Default)]
pub struct SwarmUrlConfig {
    /// Topic for gossipsub (default: agent-yes-swarm)
    pub topic: String,
    /// Bootstrap/peer addresses to connect to
    pub bootstrap_peers: Vec<String>,
    /// Room code to resolve via DHT (if provided)
    pub room_code: Option<String>,
    /// Listen address override
    pub listen_addr: Option<String>,
}

impl SwarmUrlConfig {
    /// Parse a swarm value into configuration
    ///
    /// Supports:
    /// - `ay://topic?peer=addr&peer=addr2` - Full URL with peers
    /// - `/ip4/.../tcp/.../p2p/...` - Raw multiaddr
    /// - `ABC-123` - Room code (6-char)
    /// - `topic-name` - Just a topic name for mDNS discovery
    pub fn parse(value: Option<&str>) -> Self {
        let value = value.unwrap_or("agent-yes-swarm");
        let value = value.trim();

        // 1. Swarm URL format: ay://topic?peer=...
        if value.starts_with("ay://") {
            return Self::parse_swarm_url(value);
        }

        // 2. Raw multiaddr: starts with /
        if value.starts_with('/') {
            return Self {
                topic: "agent-yes-swarm".to_string(),
                bootstrap_peers: vec![value.to_string()],
                ..Default::default()
            };
        }

        // 3. Room code: XXX-XXX pattern (6 chars with hyphen)
        if is_room_code(value) {
            return Self {
                topic: "agent-yes-swarm".to_string(),
                room_code: Some(value.to_uppercase().replace('-', "")),
                ..Default::default()
            };
        }

        // 4. Topic name (default)
        Self {
            topic: value.to_string(),
            ..Default::default()
        }
    }

    /// Parse ay:// URL format
    ///
    /// Format: `ay://[topic]?peer=<multiaddr>&peer=<multiaddr2>`
    fn parse_swarm_url(url: &str) -> Self {
        let url = url.strip_prefix("ay://").unwrap_or(url);

        // Split into path and query
        let (path, query) = url.split_once('?').unwrap_or((url, ""));

        // Topic is the path (or default)
        let topic = if path.is_empty() {
            "agent-yes-swarm".to_string()
        } else {
            path.to_string()
        };

        // Parse query parameters
        let mut bootstrap_peers = Vec::new();
        let mut listen_addr = None;

        for param in query.split('&') {
            if param.is_empty() {
                continue;
            }

            if let Some((key, value)) = param.split_once('=') {
                match key {
                    "peer" | "bootstrap" => {
                        // URL decode the value (handles %2F for /)
                        let decoded = urlencoding::decode(value).unwrap_or(value.into());
                        bootstrap_peers.push(decoded.to_string());
                    }
                    "listen" => {
                        let decoded = urlencoding::decode(value).unwrap_or(value.into());
                        listen_addr = Some(decoded.to_string());
                    }
                    _ => {}
                }
            }
        }

        Self {
            topic,
            bootstrap_peers,
            listen_addr,
            ..Default::default()
        }
    }

    /// Build a shareable ay:// URL from current configuration
    pub fn to_swarm_url(&self, peer_addrs: &[String]) -> String {
        let mut url = format!("ay://{}", self.topic);

        if !peer_addrs.is_empty() {
            let params: Vec<String> = peer_addrs
                .iter()
                .map(|addr| format!("peer={}", urlencoding::encode(addr)))
                .collect();
            url.push('?');
            url.push_str(&params.join("&"));
        }

        url
    }
}

/// Check if a string matches the room code pattern (XXX-XXX or XXXXXX)
pub fn is_room_code(s: &str) -> bool {
    let s = s.to_uppercase();

    // With hyphen: XXX-XXX
    if s.len() == 7 && s.chars().nth(3) == Some('-') {
        let parts: Vec<&str> = s.split('-').collect();
        if parts.len() == 2 {
            return parts[0].len() == 3
                && parts[1].len() == 3
                && parts[0].chars().all(|c| ROOM_CODE_CHARS.contains(&(c as u8)))
                && parts[1].chars().all(|c| ROOM_CODE_CHARS.contains(&(c as u8)));
        }
    }

    // Without hyphen: XXXXXX
    if s.len() == 6 {
        return s.chars().all(|c| ROOM_CODE_CHARS.contains(&(c as u8)));
    }

    false
}

/// Generate a random room code (XXX-XXX format)
pub fn generate_room_code() -> String {
    let mut rng = rand::thread_rng();
    let mut code = String::with_capacity(7);

    for i in 0..6 {
        if i == 3 {
            code.push('-');
        }
        let idx = rng.gen_range(0..ROOM_CODE_CHARS.len());
        code.push(ROOM_CODE_CHARS[idx] as char);
    }

    code
}

/// Format a room code with hyphen if needed (ABC123 -> ABC-123)
pub fn format_room_code(code: &str) -> String {
    let code = code.to_uppercase().replace('-', "");
    if code.len() == 6 {
        format!("{}-{}", &code[0..3], &code[3..6])
    } else {
        code
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_topic_only() {
        let config = SwarmUrlConfig::parse(Some("my-project"));
        assert_eq!(config.topic, "my-project");
        assert!(config.bootstrap_peers.is_empty());
        assert!(config.room_code.is_none());
    }

    #[test]
    fn test_parse_none_default() {
        let config = SwarmUrlConfig::parse(None);
        assert_eq!(config.topic, "agent-yes-swarm");
    }

    #[test]
    fn test_parse_room_code() {
        // Use valid room code chars (no 0, 1, I, L, O)
        let config = SwarmUrlConfig::parse(Some("ABC-234"));
        assert_eq!(config.topic, "agent-yes-swarm");
        assert_eq!(config.room_code, Some("ABC234".to_string()));
    }

    #[test]
    fn test_parse_room_code_no_hyphen() {
        let config = SwarmUrlConfig::parse(Some("ABC234"));
        assert_eq!(config.room_code, Some("ABC234".to_string()));
    }

    #[test]
    fn test_parse_room_code_lowercase() {
        let config = SwarmUrlConfig::parse(Some("abc-234"));
        assert_eq!(config.room_code, Some("ABC234".to_string()));
    }

    #[test]
    fn test_parse_multiaddr() {
        let addr = "/ip4/1.2.3.4/tcp/4001/p2p/12D3KooWTest";
        let config = SwarmUrlConfig::parse(Some(addr));
        assert_eq!(config.topic, "agent-yes-swarm");
        assert_eq!(config.bootstrap_peers, vec![addr]);
    }

    #[test]
    fn test_parse_swarm_url_simple() {
        let config = SwarmUrlConfig::parse(Some("ay://my-project"));
        assert_eq!(config.topic, "my-project");
        assert!(config.bootstrap_peers.is_empty());
    }

    #[test]
    fn test_parse_swarm_url_with_peer() {
        let url = "ay://my-project?peer=/ip4/1.2.3.4/tcp/4001/p2p/QmTest";
        let config = SwarmUrlConfig::parse(Some(url));
        assert_eq!(config.topic, "my-project");
        assert_eq!(
            config.bootstrap_peers,
            vec!["/ip4/1.2.3.4/tcp/4001/p2p/QmTest"]
        );
    }

    #[test]
    fn test_parse_swarm_url_with_multiple_peers() {
        let url = "ay://team?peer=/ip4/1.2.3.4/tcp/4001/p2p/QmA&peer=/ip4/5.6.7.8/tcp/4001/p2p/QmB";
        let config = SwarmUrlConfig::parse(Some(url));
        assert_eq!(config.topic, "team");
        assert_eq!(config.bootstrap_peers.len(), 2);
        assert!(config.bootstrap_peers[0].contains("1.2.3.4"));
        assert!(config.bootstrap_peers[1].contains("5.6.7.8"));
    }

    #[test]
    fn test_parse_swarm_url_encoded() {
        let url = "ay://test?peer=%2Fip4%2F1.2.3.4%2Ftcp%2F4001%2Fp2p%2FQmTest";
        let config = SwarmUrlConfig::parse(Some(url));
        assert_eq!(
            config.bootstrap_peers,
            vec!["/ip4/1.2.3.4/tcp/4001/p2p/QmTest"]
        );
    }

    #[test]
    fn test_is_room_code() {
        // Valid codes (no 0, 1, I, L, O - ambiguous chars excluded)
        assert!(is_room_code("ABC-234"));
        assert!(is_room_code("abc-234")); // case insensitive
        assert!(is_room_code("DEV-742"));
        assert!(is_room_code("PRJ-482"));
        assert!(is_room_code("ABC234")); // without hyphen

        // Invalid codes
        assert!(!is_room_code("ABCDEF-234")); // too long
        assert!(!is_room_code("AB-23")); // too short
        assert!(!is_room_code("my-project")); // not matching pattern (too long)
        assert!(!is_room_code("ABC-O23")); // contains O (ambiguous)
        assert!(!is_room_code("ABC-023")); // contains 0 (ambiguous)
        assert!(!is_room_code("ABC-123")); // contains 1 (ambiguous)
        assert!(!is_room_code("ABI-234")); // contains I (ambiguous)
        assert!(!is_room_code("ABL-234")); // contains L (ambiguous)
    }

    #[test]
    fn test_generate_room_code() {
        let code = generate_room_code();
        assert_eq!(code.len(), 7);
        assert_eq!(code.chars().nth(3), Some('-'));
        assert!(is_room_code(&code));
    }

    #[test]
    fn test_format_room_code() {
        assert_eq!(format_room_code("ABC234"), "ABC-234");
        assert_eq!(format_room_code("abc234"), "ABC-234");
        assert_eq!(format_room_code("ABC-234"), "ABC-234");
    }

    #[test]
    fn test_to_swarm_url() {
        let config = SwarmUrlConfig {
            topic: "my-project".to_string(),
            ..Default::default()
        };

        assert_eq!(config.to_swarm_url(&[]), "ay://my-project");

        let addrs = vec!["/ip4/1.2.3.4/tcp/4001/p2p/QmTest".to_string()];
        let url = config.to_swarm_url(&addrs);
        assert!(url.starts_with("ay://my-project?peer="));
    }
}
