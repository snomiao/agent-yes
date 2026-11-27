//! A daemon gets its room link from AY_WEBRTC_URL next to a bare `--webrtc`,
//! because a command line is public (`ps`). ayrs must host that room, and
//! must not pass the variable on to anything it spawns.
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

#[test]
fn bare_webrtc_hosts_the_env_room_and_children_never_inherit_it() {
    let tmp = tempfile::tempdir().unwrap();
    let state = tmp.path().join(".agent-yes");
    fs::create_dir_all(&state).unwrap();
    // ayrs probes the login shell at startup; this one records the env it got.
    let dump = tmp.path().join("child-env");
    let shell = tmp.path().join("shell");
    fs::write(&shell, "#!/bin/sh\nenv > \"$AY_TEST_ENV_DUMP\"\nexit 1\n").unwrap();
    fs::set_permissions(&shell, fs::Permissions::from_mode(0o700)).unwrap();

    let secret = format!("e1.{}", "7a".repeat(32));
    // Port 1 on loopback: signaling fails fast and retries; the room line is
    // printed before it connects.
    let room = format!("webrtc://rlinkenv:{secret}@127.0.0.1:1");
    let mut daemon = Daemon(
        Command::new(env!("CARGO_BIN_EXE_ayrs"))
            .args(["serve", "--webrtc"])
            .env("HOME", tmp.path())
            .env("AGENT_YES_HOME", &state)
            .env("SHELL", &shell)
            .env("AY_TEST_ENV_DUMP", &dump)
            .env("AY_WEBRTC_URL", &room)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    // Never joined: the reader exits by itself once the pipe closes.
    let (tx, rx) = mpsc::channel();
    let stderr = daemon.0.stderr.take().unwrap();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });

    let mut lines = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut hosted = false;
    while Instant::now() < deadline && !(hosted && dump.exists()) {
        if let Ok(line) = rx.recv_timeout(Duration::from_millis(200)) {
            hosted |= line.contains("room rlinkenv via 127.0.0.1:1");
            lines.push(line);
        }
    }
    assert!(hosted, "did not host the env room:\n{}", lines.join("\n"));

    // Give the shell a moment to finish writing.
    let mut env = String::new();
    while Instant::now() < deadline {
        env = fs::read_to_string(&dump).unwrap_or_default();
        if env.contains("AY_TEST_ENV_DUMP=") {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(env.contains("AY_TEST_ENV_DUMP="), "no env dump: {env}");
    assert!(
        !env.contains("AY_WEBRTC_URL"),
        "child inherited the room link"
    );
    assert!(!env.contains(&secret), "child env holds the room secret");
}
