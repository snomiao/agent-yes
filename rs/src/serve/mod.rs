// `ayrs serve` — pure-Rust port of the ay-serve WebRTC share host. Kept as a
// separate binary/module tree so it can coexist with the TS `ay serve` daemon
// during the migration: it persists its room in `.share-room-ayrs` (NOT the TS
// `.share-room`), so both hosts can run side by side without fighting over the
// signaling room, while sharing the same pids.jsonl / logs / fifos data plane.
pub mod agent_share;
pub mod api;
pub mod control;
pub mod discover;
pub mod e2e;
pub mod expose;
pub mod graph;
pub mod heartbeat;
pub mod host_stats;
pub mod http;
pub mod ice_mux;
pub mod ice_net;
pub mod log_gc;
pub mod meta;
pub mod nat_probe;
pub mod nego;
pub mod procstats;
pub mod reply_alias;
pub mod room_member;
pub mod sampler;
pub mod service;
pub mod share;
pub mod shell_env;
pub mod widget;
pub mod ws;

/// What to print for a line that carries a secret (a room link, the console's
/// `#k=` token). Only an interactive terminal gets the secret. Under a service
/// manager stdout and stderr are log files: they outlive a rotation, and
/// `ay serve logs`, backups and bug reports pass them around.
pub fn secret_line<'a>(full: &'a str, redacted: &'a str, to_terminal: bool) -> &'a str {
    if to_terminal {
        full
    } else {
        redacted
    }
}

pub fn stdout_is_terminal() -> bool {
    std::io::IsTerminal::is_terminal(&std::io::stdout())
}

pub fn stderr_is_terminal() -> bool {
    std::io::IsTerminal::is_terminal(&std::io::stderr())
}

/// Write a file only its owner can read, including when it already exists
/// with a wider mode.
pub fn write_private(path: &std::path::Path, text: &str) -> std::io::Result<()> {
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    std::io::Write::write_all(&mut opts.open(path)?, text.as_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_line_keeps_the_secret_for_a_terminal_only() {
        assert_eq!(
            secret_line("http://h/#k=SECRET", "http://h/", true),
            "http://h/#k=SECRET"
        );
        assert_eq!(
            secret_line("http://h/#k=SECRET", "http://h/", false),
            "http://h/"
        );
    }

    #[cfg(unix)]
    #[test]
    fn write_private_narrows_an_existing_wide_file() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("receipt");
        std::fs::write(&path, "old").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        write_private(&path, "new").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
