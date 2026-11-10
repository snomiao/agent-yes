//! The reply route of a message that crossed a shared room (mirrors
//! ts/roomReplyAlias.ts).
//!
//! The sender's <ay-msg …> header cannot know what this machine calls the
//! room, so its reply hint names the room: `ay send <alias-for-room-<id>>:
//! <member>:<agent>`. Before the message reaches the agent, the placeholder is
//! replaced with this machine's alias for that room from
//! ~/.agent-yes/remotes.yaml, so the agent gets a command it can run as is.

use std::collections::HashMap;

const OPEN: &str = "<alias-for-room-";

/// `msg` with the room placeholders in its envelope header filled in. Only the
/// first line, and only when it is an <ay-msg …> header: the body is the
/// sender's text and is never rewritten.
pub fn fill_room_alias(msg: &str, alias_for: impl Fn(&str) -> Option<String>) -> String {
    if !msg.starts_with("<ay-msg ") {
        return msg.to_string();
    }
    let (head, rest) = match msg.find('\n') {
        Some(i) => msg.split_at(i),
        None => (msg, ""),
    };
    let mut out = String::with_capacity(msg.len());
    let mut tail = head;
    while let Some(i) = tail.find(OPEN) {
        let after = &tail[i + OPEN.len()..];
        let room_len = after
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-'))
            .unwrap_or(after.len());
        let room = &after[..room_len];
        let closed = after[room_len..].starts_with('>');
        out.push_str(&tail[..i]);
        match (closed && (1..=64).contains(&room_len))
            .then(|| alias_for(room))
            .flatten()
        {
            Some(alias) => {
                out.push_str(&alias);
                tail = &after[room_len + 1..];
            }
            None => {
                out.push_str(OPEN);
                tail = after;
            }
        }
    }
    out.push_str(tail);
    out.push_str(rest);
    out
}

/// The room id of a share link (webrtc://room:…@host, …#room:…, …#room=<id>&…).
fn room_of_link(url: &str) -> Option<String> {
    let valid = |r: &str| {
        (!r.is_empty()
            && r.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'))
        .then(|| r.to_string())
    };
    if let Some(rest) = url.strip_prefix("webrtc://") {
        return valid(rest.split(':').next()?);
    }
    let frag = url.split_once('#')?.1.trim_start_matches('?');
    if frag.contains('=') {
        let room = frag.split('&').find_map(|kv| kv.strip_prefix("room="))?;
        return valid(room);
    }
    valid(frag.split(':').next()?)
}

/// This machine's aliases for share rooms: room id → alias.
pub fn room_aliases() -> HashMap<String, String> {
    let mut out = HashMap::new();
    let Some(dir) = crate::log_files::global_dir() else {
        return out;
    };
    let Ok(text) = std::fs::read_to_string(dir.join("remotes.yaml")) else {
        return out;
    };
    let Ok(doc) = serde_yaml::from_str::<serde_yaml::Value>(&text) else {
        return out;
    };
    if let Some(remotes) = doc.get("remotes").and_then(|r| r.as_mapping()) {
        for (alias, cfg) in remotes {
            let (Some(alias), Some(url)) =
                (alias.as_str(), cfg.get("url").and_then(|u| u.as_str()))
            else {
                continue;
            };
            if let Some(room) = room_of_link(url) {
                out.entry(room).or_insert_with(|| alias.to_string());
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fleet(room: &str) -> Option<String> {
        (room == "r1").then(|| "fleet".to_string())
    }

    #[test]
    fn fills_the_receivers_alias_into_the_header_only() {
        let msg =
            "<ay-msg ab from claude — reply: ay send <alias-for-room-r1>:worker-d:fc59 \"...\">\n\
                   body mentions <alias-for-room-r1> literally\n</ay-msg ab>";
        let out = fill_room_alias(msg, fleet);
        assert!(out.starts_with("<ay-msg ab from claude — reply: ay send fleet:worker-d:fc59"));
        assert!(out.contains("body mentions <alias-for-room-r1> literally"));
    }

    #[test]
    fn leaves_unknown_rooms_and_plain_text_alone() {
        let msg = "<ay-msg ab — reply: ay send <alias-for-room-r2>:m:1 \"...\">\nhi";
        assert_eq!(fill_room_alias(msg, fleet), msg);
        assert_eq!(
            fill_room_alias("<alias-for-room-r1>", fleet),
            "<alias-for-room-r1>"
        );
    }

    #[test]
    fn reads_the_room_of_every_link_spelling() {
        let s = format!("e1.{}", "ab".repeat(32));
        for url in [
            format!("webrtc://r1:{s}@s.example"),
            format!("https://agent-yes.com/w/#r1:{s}"),
            format!("https://agent-yes.com/room/#room=r1&s={s}"),
        ] {
            assert_eq!(room_of_link(&url).as_deref(), Some("r1"), "{url}");
        }
        assert_eq!(room_of_link("http://box:7432"), None);
    }
}
