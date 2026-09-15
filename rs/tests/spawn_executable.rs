//! A service PATH can omit the user's installation, and a cached `ayrs` can
//! have no sibling wrapper. Resolve the same PATH used for the spawned child.
#![cfg(unix)]

use serde_json::{json, Value};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

struct Daemon(Child);
impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn executable(path: &Path, text: &str) {
    fs::write(path, text).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}

fn check_spawn(recover: bool, sibling: bool, wrapper: &str) {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    let state = home.join(".agent-yes");
    let cache = tmp.path().join("cache");
    let user_bin = tmp.path().join("user-bin");
    let empty_path = tmp.path().join("service-bin");
    for path in [&state, &cache, &user_bin, &empty_path] {
        fs::create_dir_all(path).unwrap();
    }
    fs::write(state.join(".serve-token"), "spawn-executable-test").unwrap();
    let bin = cache.join("ayrs");
    fs::copy(env!("CARGO_BIN_EXE_ayrs"), &bin).unwrap();
    executable(
        &user_bin.join(wrapper),
        "#!/bin/sh\nprintf user-path > .spawn-executable\n",
    );
    if sibling {
        executable(
            &cache.join("agent-yes"),
            "#!/bin/sh\nprintf sibling > .spawn-executable\n",
        );
    }
    // Deterministic login-shell fixture: no real shell config or credentials.
    let shell = tmp.path().join("shell");
    executable(
        &shell,
        if recover {
            "#!/bin/sh\nprintf '_AYRS_SHELL_ENV_DELIM_PATH=%s\\000_AYRS_SHELL_ENV_DELIM_' \"$AY_TEST_SHELL_PATH\"\n"
        } else {
            "#!/bin/sh\nexit 1\n"
        },
    );
    let mut daemon = Daemon(
        Command::new(&bin)
            .args(["serve", "--port", "0"])
            .env("HOME", &home)
            .env("AGENT_YES_HOME", &state)
            .env("SHELL", &shell)
            .env("PATH", if recover { &empty_path } else { &user_bin })
            .env("AY_TEST_SHELL_PATH", &user_bin)
            .stdout(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let mut line = String::new();
    BufReader::new(daemon.0.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let addr = line
        .trim()
        .strip_prefix("http://")
        .unwrap()
        .split('/')
        .next()
        .unwrap();
    // Explicit cwd isolates executable discovery from the separate cwd-default fix.
    let body = json!({"cli": "bash", "cwd": home}).to_string();
    let mut conn = TcpStream::connect(addr).unwrap();
    conn.set_read_timeout(Some(Duration::from_secs(15)))
        .unwrap();
    write!(conn, "POST /api/spawn HTTP/1.1\r\nHost: {addr}\r\nAuthorization: Bearer spawn-executable-test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
    let mut response = String::new();
    conn.read_to_string(&mut response).unwrap();
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    let payload: Value = serde_json::from_str(response.split_once("\r\n\r\n").unwrap().1).unwrap();
    assert_eq!(payload["ok"], true);
    let record = home.join(".spawn-executable");
    let expected = if sibling { "sibling" } else { "user-path" };
    let deadline = Instant::now() + Duration::from_secs(10);
    while fs::read_to_string(&record).unwrap_or_default() != expected && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(fs::read_to_string(record).unwrap(), expected);
}

#[test]
fn spawn_finds_wrapper_on_recovered_shell_path() {
    check_spawn(true, false, "agent-yes");
    check_spawn(true, false, "ay");
}

#[test]
fn spawn_keeps_sibling_precedence() {
    check_spawn(true, true, "agent-yes");
}

#[test]
fn spawn_falls_back_to_service_path_when_recovery_fails() {
    check_spawn(false, false, "agent-yes");
}
