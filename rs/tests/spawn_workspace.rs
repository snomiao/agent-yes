//! Exercise the real HTTP spawn endpoint with a harmless executable that records
//! its cwd. Each daemon has a private home/config; no real agents are launched.
#![cfg(unix)]

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::os::unix::fs::PermissionsExt;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

struct Daemon(Child);
impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn spawn_uses_host_workspace_when_cwd_is_blank() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    let state = home.join(".agent-yes");
    std::fs::create_dir_all(&state).unwrap();
    std::fs::write(state.join(".serve-token"), "spawn-workspace-test").unwrap();
    let bin = tmp.path().join("ayrs");
    std::fs::copy(env!("CARGO_BIN_EXE_ayrs"), &bin).unwrap();
    let stub = tmp.path().join("agent-yes");
    std::fs::write(&stub, "#!/bin/sh\npwd -P > .spawn-cwd\n").unwrap();
    std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut daemon = Daemon(
        Command::new(&bin)
            .args(["serve", "--port", "0"])
            .env("HOME", &home)
            .env("AGENT_YES_HOME", &state)
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
    let post = |body: Value| {
        let body = body.to_string();
        let mut conn = TcpStream::connect(addr).unwrap();
        conn.set_read_timeout(Some(Duration::from_secs(15)))
            .unwrap();
        write!(conn, "POST /api/spawn HTTP/1.1\r\nHost: {addr}\r\nAuthorization: Bearer spawn-workspace-test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        let mut response = String::new();
        conn.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        serde_json::from_str::<Value>(response.split_once("\r\n\r\n").unwrap().1).unwrap()
    };
    let check = |body: Value, expected: &std::path::Path| {
        let record = expected.join(".spawn-cwd");
        let _ = std::fs::remove_file(&record);
        let response = post(body);
        assert_eq!(response["cwd"], expected.to_string_lossy().as_ref());
        assert_eq!(response["ok"], true);
        let physical_cwd = expected.canonicalize().unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while std::fs::read_to_string(&record).unwrap_or_default().trim()
            != physical_cwd.to_str().unwrap()
            && Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(
            std::fs::read_to_string(record).unwrap().trim(),
            physical_cwd.to_str().unwrap()
        );
    };
    check(json!({"cli": "bash"}), &home);
    let workspace = home.join("workspace");
    std::fs::write(
        state.join("config.json"),
        json!({"workspace": "~/workspace", "provisionRoot": "~/repos"}).to_string(),
    )
    .unwrap();
    // The host ignores group/world-writable configuration files.
    std::fs::set_permissions(
        state.join("config.json"),
        std::fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    for cwd in [Value::Null, json!(""), json!("  ")] {
        check(json!({"cli": "bash", "cwd": cwd}), &workspace);
    }
    check(json!({"cli": "bash"}), &workspace);
    let explicit = home.join("explicit");
    check(json!({"cli": "bash", "cwd": explicit}), &explicit);
}
