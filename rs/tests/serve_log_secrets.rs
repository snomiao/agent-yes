//! Under a service manager `ayrs serve`'s stdout and stderr are log files, so
//! the console token and the room secret must not be written to them. The
//! files that do hold secrets (the run receipt) are owner-only.
#![cfg(unix)]

use std::fs;
use std::io::{BufRead, BufReader};
use std::os::unix::fs::PermissionsExt;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

struct Daemon(Child);
impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Forward each line of a pipe to `tx`. The reader is never joined: it exits
/// by itself once the last writer closes the pipe.
fn forward<R: std::io::Read + Send + 'static>(r: R, tx: mpsc::Sender<String>) {
    std::thread::spawn(move || {
        for line in BufReader::new(r).lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
}

#[test]
fn piped_serve_output_carries_neither_the_token_nor_the_room_secret() {
    let tmp = tempfile::tempdir().unwrap();
    let state = tmp.path().join(".agent-yes");
    fs::create_dir_all(&state).unwrap();
    let token = "serve-log-secrets-test-token";
    fs::write(state.join(".serve-token"), token).unwrap();
    // A receipt left by an older version, world-readable.
    let receipt = state.join(".ayrs-serve.receipt");
    fs::write(&receipt, "{}").unwrap();
    fs::set_permissions(&receipt, fs::Permissions::from_mode(0o644)).unwrap();

    let secret = format!("e1.{}", "5e".repeat(32));
    // Port 1 on loopback: signaling fails fast and retries, which is fine,
    // because the lines under test are printed before it connects.
    let room = format!("webrtc://rlogtest:{secret}@127.0.0.1:1");
    let mut daemon = Daemon(
        Command::new(env!("CARGO_BIN_EXE_ayrs"))
            .args(["serve", "--port", "0", "--webrtc", &room])
            .env("HOME", tmp.path())
            .env("AGENT_YES_HOME", &state)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let (tx, rx) = mpsc::channel();
    forward(daemon.0.stdout.take().unwrap(), tx.clone());
    forward(daemon.0.stderr.take().unwrap(), tx);

    let mut lines = Vec::new();
    let (mut saw_http, mut saw_room) = (false, false);
    let deadline = Instant::now() + Duration::from_secs(20);
    while !(saw_http && saw_room) && Instant::now() < deadline {
        if let Ok(line) = rx.recv_timeout(Duration::from_millis(200)) {
            saw_http |= line.starts_with("http://127.0.0.1:");
            saw_room |= line.starts_with("room rlogtest ");
            lines.push(line);
        }
    }
    // Anything printed right after the startup lines counts too.
    while let Ok(line) = rx.recv_timeout(Duration::from_millis(500)) {
        lines.push(line);
    }
    let out = lines.join("\n");
    assert!(saw_http && saw_room, "startup lines missing:\n{out}");
    assert!(!out.contains(token), "console token logged:\n{out}");
    assert!(!out.contains(&secret), "room secret logged:\n{out}");
    assert!(!out.contains("#k="), "console link logged:\n{out}");

    let mode = fs::metadata(&receipt).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600, "receipt mode {mode:o}");
    // Rewritten by this run: it records a fingerprint of the room, never the link.
    let body = fs::read_to_string(&receipt).unwrap();
    assert!(body.contains("\"room\":\""), "{body}");
    assert!(!body.contains(&secret), "{body}");
}
