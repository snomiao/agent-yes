//! This host's identity as one member of a shared room.
//!
//! A room can have several hosts (machines, containers), each serving its own
//! agents to every viewer; the signaling server tells them apart by a peer id
//! of `h-<host id>` and shows viewers each member's name (see
//! lab/ui/cf/roomRouting.ts). Hosting in such a room takes the room's join
//! secret J (`j1.<64 hex>`), which the view link does not carry: a viewer can
//! watch and talk to agents but cannot add a host of its own.
//!
//! - host id: random, kept in ~/.agent-yes/.share-host-id so a restart (and
//!   the periodic signaling re-hello) keeps the same peer id.
//! - name: `AY_NAME`, else the hostname.
//! - J: `AY_JOIN_SECRET`, else ~/.agent-yes/.share-join-<room>, written by
//!   `ayrs serve join-secret` on the machine that hands the room out.

use anyhow::{bail, Result};
use std::path::PathBuf;

use super::e2e;

pub struct Member {
    pub host_id: String,
    pub name: String,
    /// The host token for this room, when this host has its join secret.
    pub host_token: Option<String>,
}

fn global_dir() -> PathBuf {
    crate::log_files::global_dir().unwrap_or_else(|| PathBuf::from(".agent-yes"))
}

fn join_secret_path(room: &str) -> PathBuf {
    global_dir().join(format!(".share-join-{room}"))
}

fn write_private(path: &std::path::Path, text: &str) -> Result<()> {
    if let Some(d) = path.parent() {
        std::fs::create_dir_all(d)?;
    }
    std::fs::write(path, text)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

pub fn host_id() -> String {
    let path = global_dir().join(".share-host-id");
    if let Ok(t) = std::fs::read_to_string(&path) {
        let t = t.trim();
        if !t.is_empty() && t.len() <= 32 && t.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return t.to_string();
        }
    }
    let id = e2e::random_hex(4);
    let _ = write_private(&path, &id);
    id
}

pub fn member_name() -> String {
    std::env::var("AY_NAME")
        .ok()
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(crate::identity::raw_hostname)
}

/// The join secret this host has for `room`: `AY_JOIN_SECRET`, else the saved one.
pub fn join_secret(room: &str) -> Option<String> {
    std::env::var("AY_JOIN_SECRET")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            std::fs::read_to_string(join_secret_path(room))
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
}

/// The room's join secret, minted and saved when there is none yet. The room
/// starts requiring it the next time this host says hello.
pub fn join_secret_or_mint(room: &str) -> Result<String> {
    if let Some(j) = join_secret(room) {
        return Ok(j);
    }
    let j = e2e::mint_join_secret();
    write_private(&join_secret_path(room), &j)?;
    Ok(j)
}

/// `join`: this host was asked to join someone else's room, which needs J.
pub fn for_room(room: &str, sighost: &str, join: bool) -> Result<Member> {
    let host_token = match join_secret(room) {
        Some(j) => Some(e2e::derive_host_token(&j, room, sighost)?),
        None if join => bail!(
            "joining room {room} as a host needs its join secret: set AY_JOIN_SECRET=j1.<…> \
             (the room's owner prints it with `ay serve join-secret`)"
        ),
        None => None,
    };
    Ok(Member {
        host_id: host_id(),
        name: member_name(),
        host_token,
    })
}
