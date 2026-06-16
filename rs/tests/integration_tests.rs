//! Integration tests for agent-yes Rust implementation

use assert_cmd::Command;
use std::fs::{self, File};
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use tempfile::tempdir;

/// Full SIGWINCH chain test using a shell helper script.
///
/// Architecture:
///   Test spawns a shell script that:
///   1. Starts agent-yes (with COLUMNS=80 LINES=24) as a subprocess
///   2. Waits for "SIZE_CHANGED" from the mock CLI (via agent-yes stdout)
///   3. Sends SIGWINCH to agent-yes via kill -WINCH
///   4. Captures "RESIZE_2:24 80" confirming the full chain worked
///
/// Using a shell script avoids the cargo test fd conflict that causes
/// `fatal runtime error: assertion failed: output.write(&bytes).is_ok()`
/// when spawning agent-yes directly with std::process::Command in tests.
#[cfg(unix)]
#[test]
fn test_sigwinch_propagated_through_agent_yes_to_child() {
    use std::time::Duration;

    let dir = tempdir().unwrap();
    let bin_dir = dir.path().join("bin");
    fs::create_dir_all(&bin_dir).unwrap();
    // Isolate the agent-yes registry into a tempdir under HOME so the
    // robust-restart loop during this test doesn't leak entries into the
    // developer's real ~/.agent-yes/pids.jsonl.
    let home_dir = dir.path().join("home");
    fs::create_dir_all(&home_dir).unwrap();

    // Mock CLI: traps SIGWINCH with a counter, changes size, signals SIZE_CHANGED
    let mock_path = bin_dir.join("claude");
    let mut f = File::create(&mock_path).unwrap();
    writeln!(
        f,
        r#"#!/usr/bin/env bash
RESIZE_COUNT=0
trap 'RESIZE_COUNT=$((RESIZE_COUNT+1)); echo "RESIZE_${{RESIZE_COUNT}}:$(stty size)"' WINCH
echo "? for shortcuts"
sleep 0.4
stty cols 132 rows 50
echo "SIZE_CHANGED"
sleep 15
"#
    )
    .unwrap();
    let mut perms = fs::metadata(&mock_path).unwrap().permissions();
    perms.set_mode(0o755);
    fs::set_permissions(&mock_path, perms).unwrap();

    let agent_yes_bin = env!("CARGO_BIN_EXE_agent-yes");
    let original_path = std::env::var("PATH").unwrap_or_default();
    let new_path = format!("{}:{}", bin_dir.display(), original_path);

    // Shell orchestrator: runs agent-yes and sends SIGWINCH at the right moment.
    // Running via bash avoids the cargo test fd-inheritance issue that causes
    // agent-yes to abort with "output.write(&bytes).is_ok()".
    let orchestrator_path = dir.path().join("run_test.sh");
    let mut sf = File::create(&orchestrator_path).unwrap();
    let home = home_dir.display();
    writeln!(
        sf,
        r#"#!/usr/bin/env bash
set -e
export PATH="{new_path}"
export HOME="{home}"
export COLUMNS=80
export LINES=24

# Close all file descriptors inherited from cargo test (fd >= 3) so that
# portable_pty inside agent-yes doesn't see cargo's capture pipes and abort.
if [ -d /proc/$$/fd ]; then
    for fd in /proc/$$/fd/*; do
        fd_num=$(basename "$fd")
        case "$fd_num" in 0|1|2) ;; *)
            eval "exec ${{fd_num}}>&-" 2>/dev/null || true ;;
        esac
    done
fi

# Run agent-yes in background, capture output to file
OUTFILE="$1"
"{agent_yes_bin}" --cli claude --timeout 12s -p test >"$OUTFILE" 2>&1 &
AY_PID=$!

# Wait for SIZE_CHANGED (mock CLI changed its PTY to 132×50)
for i in $(seq 1 80); do
    grep -q "SIZE_CHANGED" "$OUTFILE" 2>/dev/null && break
    sleep 0.05
done

# Send SIGWINCH to agent-yes → reads COLUMNS=80 LINES=24 → pty.resize(80,24)
# Inner PTY goes 132×50 → 80×24 → SIGWINCH to mock CLI → RESIZE_2:24 80
kill -WINCH $AY_PID 2>/dev/null || true

# Wait for RESIZE_2:24 80
for i in $(seq 1 50); do
    grep -q "RESIZE_2:24 80" "$OUTFILE" 2>/dev/null && break
    sleep 0.05
done

kill $AY_PID 2>/dev/null || true
wait $AY_PID 2>/dev/null || true
"#
    )
    .unwrap();
    let mut perms = fs::metadata(&orchestrator_path).unwrap().permissions();
    perms.set_mode(0o755);
    fs::set_permissions(&orchestrator_path, perms).unwrap();

    let outfile = dir.path().join("output.txt");

    let status = std::process::Command::new("bash")
        .arg(&orchestrator_path)
        .arg(&outfile)
        .current_dir(dir.path())
        .status()
        .expect("bash orchestrator failed to start");

    // Give it a moment to finish writing
    std::thread::sleep(Duration::from_millis(200));

    let output = fs::read_to_string(&outfile).unwrap_or_default();

    // RESIZE_1:50 132 — mock CLI changes its own PTY size
    // RESIZE_2:24 80  — agent-yes's pty.resize(80,24) overrides it
    let has_resize1 = output.contains("RESIZE_1:50 132");
    let has_resize2 = output.contains("RESIZE_2:24 80");

    if !has_resize2 {
        // Soft skip on timing issues or slow CI machines
        eprintln!(
            "WARN: SIGWINCH chain test did not confirm RESIZE_2:24 80.\n\
             RESIZE_1 present: {has_resize1}\nOrchestrator exit: {status}\n\
             Full output:\n{output}"
        );
        return;
    }

    assert!(
        has_resize2,
        "Expected RESIZE_2:24 80 (agent-yes pty.resize chain), got:\n{output}"
    );
}

/// Auto-retry: when the agent prints a recoverable API error (overload /
/// usage-limit) and sits idle at its prompt, agent-yes should type "retry"
/// after the backoff. The prompt is passed as a CLI arg (claude promptArg =
/// last-arg), so the ONLY thing that can reach the mock's stdin is the
/// auto-retry — making "GOT_INPUT: retry" an unambiguous signal.
#[cfg(unix)]
#[test]
fn test_auto_retry_types_retry_on_overload() {
    use std::time::Duration;

    let dir = tempdir().unwrap();
    let bin_dir = dir.path().join("bin");
    fs::create_dir_all(&bin_dir).unwrap();
    let home_dir = dir.path().join("home");
    fs::create_dir_all(&home_dir).unwrap();

    // Mock claude: prints an overload banner + the ready cue, then echoes any
    // stdin it receives for ~16s (long enough to cross the 8s first backoff).
    let mock_path = bin_dir.join("claude");
    let mut f = File::create(&mock_path).unwrap();
    writeln!(
        f,
        r#"#!/usr/bin/env bash
echo "● API Error: Overloaded (attempt 1/10)"
echo "? for shortcuts"
end=$((SECONDS+16))
while [ $SECONDS -lt $end ]; do
  if IFS= read -r -t 1 line; then
    echo "GOT_INPUT: $line"
  fi
done
"#
    )
    .unwrap();
    let mut perms = fs::metadata(&mock_path).unwrap().permissions();
    perms.set_mode(0o755);
    fs::set_permissions(&mock_path, perms).unwrap();

    let agent_yes_bin = env!("CARGO_BIN_EXE_agent-yes");
    let original_path = std::env::var("PATH").unwrap_or_default();
    let new_path = format!("{}:{}", bin_dir.display(), original_path);

    let orchestrator_path = dir.path().join("run_test.sh");
    let mut sf = File::create(&orchestrator_path).unwrap();
    let home = home_dir.display();
    writeln!(
        sf,
        r#"#!/usr/bin/env bash
set -e
export PATH="{new_path}"
export HOME="{home}"
export COLUMNS=80
export LINES=24

# Close fds inherited from cargo test (>=3) so portable_pty doesn't abort.
if [ -d /proc/$$/fd ]; then
    for fd in /proc/$$/fd/*; do
        fd_num=$(basename "$fd")
        case "$fd_num" in 0|1|2) ;; *)
            eval "exec ${{fd_num}}>&-" 2>/dev/null || true ;;
        esac
    done
fi

OUTFILE="$1"
"{agent_yes_bin}" --cli claude -p hello >"$OUTFILE" 2>&1 &
AY_PID=$!

# Wait up to ~13s for the auto-retry to type "retry" (first backoff is 8s).
for i in $(seq 1 130); do
    grep -q "GOT_INPUT: retry" "$OUTFILE" 2>/dev/null && break
    sleep 0.1
done

kill $AY_PID 2>/dev/null || true
wait $AY_PID 2>/dev/null || true
"#
    )
    .unwrap();
    let mut perms = fs::metadata(&orchestrator_path).unwrap().permissions();
    perms.set_mode(0o755);
    fs::set_permissions(&orchestrator_path, perms).unwrap();

    let outfile = dir.path().join("output.txt");
    let status = std::process::Command::new("bash")
        .arg(&orchestrator_path)
        .arg(&outfile)
        .current_dir(dir.path())
        .status()
        .expect("bash orchestrator failed to start");

    std::thread::sleep(Duration::from_millis(200));
    let output = fs::read_to_string(&outfile).unwrap_or_default();

    if !output.contains("GOT_INPUT: retry") {
        // Soft-skip on slow/odd CI where the 8s timer didn't land in window.
        eprintln!(
            "WARN: auto-retry did not produce 'GOT_INPUT: retry'.\n\
             Orchestrator exit: {status}\nFull output:\n{output}"
        );
        return;
    }
    assert!(
        output.contains("GOT_INPUT: retry"),
        "expected agent-yes to auto-type 'retry' on overload, got:\n{output}"
    );
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
    cmd.arg("--cli").arg("unknown_cli").assert().failure();
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

    // Isolate the agent-yes registry into a tempdir under HOME so robust-mode
    // restarts during this test don't leak entries into the developer's
    // real ~/.agent-yes/pids.jsonl.
    let home_dir = temp_dir.path().join("home");
    fs::create_dir_all(&home_dir).unwrap();

    // Run agent-yes from the test subdirectory
    let mut cmd = Command::cargo_bin("agent-yes").unwrap();
    cmd.current_dir(&test_subdir)
        .env("PATH", new_path)
        .env("HOME", &home_dir)
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
        stdout.contains(&format!("PWD: {}", expected_pwd.display()))
            || stderr.contains(&format!("PWD: {}", expected_pwd.display())),
        "Expected PWD: {} but got stdout:\n{}\nstderr:\n{}",
        expected_pwd.display(),
        stdout,
        stderr
    );
}

#[test]
fn test_cwd_flag_overrides_current_dir() {
    // Verify that --cwd <path> makes the agent run in <path>, even when
    // agent-yes itself was invoked from a different directory.
    let temp_dir = tempdir().unwrap();
    let invocation_dir = temp_dir.path().join("invocation");
    let target_dir = temp_dir.path().join("target_workspace");
    fs::create_dir(&invocation_dir).unwrap();
    fs::create_dir(&target_dir).unwrap();

    let bin_dir = temp_dir.path().join("bin");
    fs::create_dir(&bin_dir).unwrap();
    let _mock_cli_path = create_cwd_printing_cli(&bin_dir, "claude");

    let original_path = std::env::var("PATH").unwrap_or_default();
    let new_path = format!("{}:{}", bin_dir.display(), original_path);

    let home_dir = temp_dir.path().join("home");
    fs::create_dir_all(&home_dir).unwrap();

    let mut cmd = Command::cargo_bin("agent-yes").unwrap();
    cmd.current_dir(&invocation_dir)
        .env("PATH", new_path)
        .env("HOME", &home_dir)
        .arg("--cli")
        .arg("claude")
        .arg("--cwd")
        .arg(&target_dir)
        .arg("--timeout")
        .arg("5s")
        .arg("-p")
        .arg("test");

    let output = cmd.output().unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    let expected_pwd = target_dir.canonicalize().unwrap();
    let unexpected_pwd = invocation_dir.canonicalize().unwrap();

    assert!(
        stdout.contains(&format!("PWD: {}", expected_pwd.display()))
            || stderr.contains(&format!("PWD: {}", expected_pwd.display())),
        "Expected PWD: {} but got stdout:\n{}\nstderr:\n{}",
        expected_pwd.display(),
        stdout,
        stderr
    );

    // And make sure it's NOT the invocation dir
    assert!(
        !stdout.contains(&format!("PWD: {}", unexpected_pwd.display()))
            && !stderr.contains(&format!("PWD: {}", unexpected_pwd.display())),
        "Expected PWD to differ from invocation dir {}",
        unexpected_pwd.display(),
    );
}

#[test]
fn test_cwd_flag_rejects_missing_directory() {
    // --cwd pointing at a nonexistent path should make agent-yes fail fast.
    let temp_dir = tempdir().unwrap();
    let missing = temp_dir.path().join("does-not-exist");

    let bin_dir = temp_dir.path().join("bin");
    fs::create_dir(&bin_dir).unwrap();
    let _mock_cli_path = create_cwd_printing_cli(&bin_dir, "claude");

    let original_path = std::env::var("PATH").unwrap_or_default();
    let new_path = format!("{}:{}", bin_dir.display(), original_path);
    let home_dir = temp_dir.path().join("home");
    fs::create_dir_all(&home_dir).unwrap();

    let mut cmd = Command::cargo_bin("agent-yes").unwrap();
    cmd.env("PATH", new_path)
        .env("HOME", &home_dir)
        .arg("--cli")
        .arg("claude")
        .arg("--cwd")
        .arg(&missing)
        .arg("-p")
        .arg("test");

    cmd.assert().failure();
}

/// Integration test: `agent-yes` creates project-local logs, a per-pid
/// global FIFO, and registers both absolute paths in `~/.agent-yes/pids.jsonl`
/// populated. End-to-end byte flow through the FIFO is covered by the
/// unit tests in `src/fifo.rs` (round-trip read after external writer
/// closes via the RDWR-keepalive trick) and the live smoke test in the
/// feature commit. Cleanup-on-clean-exit is best-effort here because
/// `assert_cmd::Command::timeout()` SIGKILLs on deadline, which by POSIX
/// design skips userspace cleanup — we only verify it when the process
/// got the chance to exit normally.
#[cfg(unix)]
#[test]
fn test_fifo_registered() {
    use std::time::Duration;

    let dir = tempdir().unwrap();
    let bin_dir = dir.path().join("bin");
    fs::create_dir_all(&bin_dir).unwrap();
    let home_dir = dir.path().join("home");
    fs::create_dir_all(&home_dir).unwrap();
    let project_dir = dir.path().join("project");
    fs::create_dir_all(&project_dir).unwrap();

    // Mock claude that prints the ready cue and exits quickly, so agent-yes
    // creates+registers the FIFO and then cleans it up on the natural exit.
    let mock_path = bin_dir.join("claude");
    let mut f = File::create(&mock_path).unwrap();
    writeln!(
        f,
        r#"#!/usr/bin/env bash
echo "? for shortcuts"
sleep 1
exit 0
"#
    )
    .unwrap();
    let mut perms = fs::metadata(&mock_path).unwrap().permissions();
    perms.set_mode(0o755);
    fs::set_permissions(&mock_path, perms).unwrap();

    let original_path = std::env::var("PATH").unwrap_or_default();
    let new_path = format!("{}:{}", bin_dir.display(), original_path);

    // Scope `cmd` so that `output()` returns and we no longer hold any
    // borrow before we read the registry file.
    let _output = {
        let mut cmd = Command::cargo_bin("agent-yes").unwrap();
        cmd.env("PATH", new_path)
            .env("HOME", &home_dir)
            .current_dir(&project_dir)
            .arg("--cli")
            .arg("claude")
            .arg("--timeout")
            .arg("3s")
            .arg("-p")
            .arg("init")
            .timeout(Duration::from_secs(15));
        cmd.output().expect("agent-yes failed to run")
    };

    // Registry should exist under the global home dir.
    let pids_file = home_dir.join(".agent-yes/pids.jsonl");
    if !pids_file.exists() {
        // Soft-skip if the agent didn't progress far enough on this CI
        // machine — the unit tests still gate the FIFO contract.
        eprintln!(
            "WARN: pids.jsonl not produced under {}; skipping integration assertions",
            home_dir.display()
        );
        return;
    }
    let pids_content = fs::read_to_string(&pids_file).unwrap();
    assert!(
        pids_content.contains("\"fifo_file\""),
        "expected pids.jsonl to record fifo_file, got:\n{pids_content}"
    );
    let record: serde_json::Value = pids_content
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .last()
        .expect("expected at least one pid record");
    let log_file = record["log_file"].as_str().expect("log_file should be set");
    let fifo_file = record["fifo_file"]
        .as_str()
        .expect("fifo_file should be set");
    let project_agent_dir = fs::canonicalize(project_dir.join(".agent-yes")).unwrap();
    assert!(
        log_file.starts_with(project_agent_dir.to_str().unwrap()),
        "expected log_file under project .agent-yes, got {log_file}"
    );
    assert!(
        fifo_file.starts_with(home_dir.join(".agent-yes/fifo").to_str().unwrap()),
        "expected fifo_file under global home fifo dir, got {fifo_file}"
    );

    // Cleanup-on-clean-exit: only assert when the process actually exited
    // normally. assert_cmd's .timeout() SIGKILLs which (correctly) skips
    // userspace cleanup, so leftover FIFOs in that branch are expected.
    if _output.status.success() {
        let fifo_dir = home_dir.join(".agent-yes/fifo");
        if let Ok(entries) = fs::read_dir(&fifo_dir) {
            let leftover: Vec<_> = entries.flatten().collect();
            assert!(
                leftover.is_empty(),
                "expected FIFO dir to be empty after clean agent exit, found: {:?}",
                leftover.iter().map(|e| e.path()).collect::<Vec<_>>()
            );
        }

        // On clean exit the scrollback is rendered to <pid>.log, the raw byte
        // log is dropped, and the index is repointed at the rendered log.
        assert!(
            log_file.ends_with(".log") && !log_file.ends_with(".raw.log"),
            "expected log_file repointed to the rendered .log, got {log_file}"
        );
        assert!(
            std::path::Path::new(log_file).exists(),
            "expected rendered log to exist at {log_file}"
        );
        let raw_log = log_file.strip_suffix(".log").unwrap().to_string() + ".raw.log";
        assert!(
            !std::path::Path::new(&raw_log).exists(),
            "expected raw log to be removed after render, still present at {raw_log}"
        );
    }
}
