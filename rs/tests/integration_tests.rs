//! Integration tests for agent-yes Rust implementation

use assert_cmd::Command;
use std::fs::{self, File};
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use tempfile::tempdir;

/// Create a mock CLI script that never shows the ready pattern
fn create_mock_cli(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
    let script_path = dir.join(name);
    let mut file = File::create(&script_path).unwrap();
    writeln!(
        file,
        r#"#!/usr/bin/env bash
echo "Starting {}..."
echo "Loading..."
# Sleep forever - never shows ready pattern
sleep 10000
"#,
        name
    )
    .unwrap();

    // Make executable
    let mut perms = fs::metadata(&script_path).unwrap().permissions();
    perms.set_mode(0o755);
    fs::set_permissions(&script_path, perms).unwrap();

    script_path
}

#[test]
fn test_version() {
    let mut cmd = Command::cargo_bin("agent-yes").unwrap();
    cmd.arg("--version")
        .assert()
        .success()
        .stdout(predicates::str::contains("agent-yes 1.31.41"));
}

#[test]
fn test_help() {
    let mut cmd = Command::cargo_bin("agent-yes").unwrap();
    cmd.arg("--help")
        .assert()
        .success()
        .stdout(predicates::str::contains("Automated interaction wrapper"));
}

#[test]
fn test_unknown_cli() {
    let mut cmd = Command::cargo_bin("agent-yes").unwrap();
    cmd.arg("--cli")
        .arg("unknown_cli")
        .assert()
        .failure();
}

// Note: Full e2e tests with PTY would require additional setup
// The TypeScript tests use node-pty which has better PTY support
// For now, we test the basic CLI functionality
