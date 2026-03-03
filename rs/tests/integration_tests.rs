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
        .stdout(predicates::str::contains("agent-yes"));
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

/// Create a mock CLI that prints its working directory
fn create_cwd_printing_cli(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
    let script_path = dir.join(name);
    let mut file = File::create(&script_path).unwrap();
    writeln!(
        file,
        r#"#!/usr/bin/env bash
# Print the working directory so we can verify it
echo "PWD: $(pwd)"
# Print ready pattern so agent-yes doesn't timeout
echo "? for shortcuts"
sleep 1
exit 0
"#
    )
    .unwrap();

    // Make executable
    let mut perms = fs::metadata(&script_path).unwrap().permissions();
    perms.set_mode(0o755);
    fs::set_permissions(&script_path, perms).unwrap();

    script_path
}

#[test]
fn test_cwd_is_preserved() {
    // Create a temp directory with a unique subdirectory
    let temp_dir = tempdir().unwrap();
    let test_subdir = temp_dir.path().join("test_workspace");
    fs::create_dir(&test_subdir).unwrap();

    // Create a mock "claude" CLI in the temp bin directory that prints its cwd
    let bin_dir = temp_dir.path().join("bin");
    fs::create_dir(&bin_dir).unwrap();
    let _mock_cli_path = create_cwd_printing_cli(&bin_dir, "claude");

    // Prepare PATH to include our mock CLI (prepend so it overrides real claude)
    let original_path = std::env::var("PATH").unwrap_or_default();
    let new_path = format!("{}:{}", bin_dir.display(), original_path);

    // Run agent-yes from the test subdirectory
    let mut cmd = Command::cargo_bin("agent-yes").unwrap();
    cmd.current_dir(&test_subdir)
        .env("PATH", new_path)
        .arg("--cli")
        .arg("claude")
        .arg("--timeout")
        .arg("5s")
        .arg("-p")
        .arg("test");

    let output = cmd.output().unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    // Check that the working directory printed by the CLI matches our test_subdir
    let expected_pwd = test_subdir.canonicalize().unwrap();
    assert!(
        stdout.contains(&format!("PWD: {}", expected_pwd.display())) ||
        stderr.contains(&format!("PWD: {}", expected_pwd.display())),
        "Expected PWD: {} but got stdout:\n{}\nstderr:\n{}",
        expected_pwd.display(),
        stdout,
        stderr
    );
}

// Note: Full e2e tests with PTY would require additional setup
// The TypeScript tests use node-pty which has better PTY support
// For now, we test the basic CLI functionality
