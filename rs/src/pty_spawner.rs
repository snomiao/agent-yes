//! PTY process spawner module

use crate::config::CliConfig;
use anyhow::{anyhow, Result};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use tokio::sync::mpsc;
use tracing::{debug, info};

/// Env vars that pin a process to a PARENT Claude Code session — stripped from
/// every spawned CLI so the agent is a clean top-level session (its own saved
/// transcript; no attach to a parent's stale SSE port/session id). Deliberately
/// NARROW: other CLAUDE_CODE_* settings (provider/auth/limits) pass through.
/// MIRRORS `CLAUDE_SESSION_PIN_ENV` in ts/sessionEnv.ts — keep the two in sync.
/// `AGENT_YES_PID` is NOT here: it is re-stamped with our own pid to build the
/// subagent tree, not dropped.
pub const CLAUDE_SESSION_PIN_ENV: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_SSE_PORT",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_ENTRYPOINT",
];

/// Expand `${VAR}` references in `raw` against the current process environment.
/// Sets `*unresolved = true` if any referenced variable is unset or empty, so
/// callers can choose to skip the assignment rather than emit a blank value.
/// `${VAR:-default}` falls back to `default` when VAR is unset/empty (and never
/// marks the entry unresolved) — used for overridable defaults like the model.
fn expand_env_vars(raw: &str, unresolved: &mut bool) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        if let Some(end) = after.find('}') {
            let expr = &after[..end];
            let (name, fallback) = match expr.split_once(":-") {
                Some((n, d)) => (n, Some(d)),
                None => (expr, None),
            };
            match std::env::var(name) {
                Ok(v) if !v.is_empty() => out.push_str(&v),
                _ => match fallback {
                    Some(d) => out.push_str(d),
                    None => *unresolved = true,
                },
            }
            rest = &after[end + 1..];
        } else {
            // No closing brace — emit the literal "${" and continue past it.
            out.push_str("${");
            rest = after;
        }
    }
    out.push_str(rest);
    out
}

/// Read terminal size via ioctl(TIOCGWINSZ). Returns None if stdout is not a TTY.
#[cfg(unix)]
fn ioctl_terminal_size() -> Option<(u16, u16)> {
    use std::os::unix::io::AsRawFd;
    let mut size: libc::winsize = unsafe { std::mem::zeroed() };
    if unsafe { libc::ioctl(std::io::stdout().as_raw_fd(), libc::TIOCGWINSZ, &mut size) } == 0
        && size.ws_col > 0
        && size.ws_row > 0
    {
        Some((size.ws_col.max(20), size.ws_row))
    } else {
        None
    }
}

/// Live console size if stdout is a real console/tty, else None. No env var,
/// no default — callers choose the fallback. Crucial for the resize watchers:
/// "no console" (piped / MSYS pty) must mean "don't change the size", not
/// "assume 80x24" (which would clobber an env- or attach-derived size).
pub fn console_size() -> Option<(u16, u16)> {
    #[cfg(unix)]
    {
        ioctl_terminal_size()
    }
    // Windows has no ioctl; read the console screen buffer. Err when stdout
    // isn't a console (piped/redirected/MSYS pty) -> None.
    #[cfg(windows)]
    {
        match crossterm::terminal::size() {
            Ok((cols, rows)) if cols > 0 && rows > 0 => Some((cols.max(20), rows)),
            _ => None,
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        None
    }
}

/// Max age of an externally-supplied winsize before we ignore it. After this,
/// a stale attach client that died holding the lock would otherwise pin our
/// PTY at the wrong size forever.
const WINSIZE_STALE_MS: u128 = 30_000;

/// Read `$AGENT_YES_HOME/winsize/<pid>` or `~/.agent-yes/winsize/<pid>` if a
/// recent `ay attach` wrote one.
/// Format: `<cols> <rows> <timestamp_ms>\n`. Returns None when the file is
/// missing, malformed, or older than [`WINSIZE_STALE_MS`].
///
/// Used by the SIGWINCH handler so attach clients can override the agent's
/// PTY size even though the agent has no TTY of its own.
pub fn read_external_winsize(pid: u32) -> Option<(u16, u16)> {
    let dir = crate::log_files::global_dir()?;
    read_external_winsize_from(&dir, pid)
}

/// `read_external_winsize` with the base dir injected — exposed so tests
/// can hit a tempdir without mutating `$HOME` (which races with concurrent
/// PTY tests that snapshot the env via posix_spawn).
pub fn read_external_winsize_from(base_dir: &std::path::Path, pid: u32) -> Option<(u16, u16)> {
    let path = base_dir.join("winsize").join(pid.to_string());
    let content = std::fs::read_to_string(&path).ok()?;
    parse_winsize_line(content.lines().next()?)
}

/// Record the agent's CURRENT applied PTY size to `$AGENT_YES_HOME/ptysize/<pid>`
/// (format: `<cols> <rows>\n`) so `ay serve` / the web console can render the
/// existing buffer at the agent's real width before adapting to the viewport.
/// Best-effort; never panics.
pub fn write_current_ptysize(pid: u32, cols: u16, rows: u16) {
    if let Some(dir) = crate::log_files::global_dir() {
        let d = dir.join("ptysize");
        let _ = std::fs::create_dir_all(&d);
        let _ = std::fs::write(d.join(pid.to_string()), format!("{} {}\n", cols, rows));
    }
}

/// Parse a single `"cols rows timestamp_ms"` line. Extracted for unit tests.
pub fn parse_winsize_line(line: &str) -> Option<(u16, u16)> {
    let mut parts = line.split_ascii_whitespace();
    let cols: u16 = parts.next()?.parse().ok()?;
    let rows: u16 = parts.next()?.parse().ok()?;
    let ts: u128 = parts.next()?.parse().ok()?;
    if cols == 0 || rows == 0 {
        return None;
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis();
    if now.saturating_sub(ts) > WINSIZE_STALE_MS {
        return None;
    }
    Some((cols.max(20), rows))
}

/// Terminal size for initial PTY spawn: COLUMNS/LINES env vars first (useful in
/// non-TTY/pipe/CI contexts), then the OS console size (ioctl on Unix, the
/// console screen buffer on Windows), then (80, 24).
pub fn get_terminal_size() -> (u16, u16) {
    if let (Ok(cols), Ok(rows)) = (std::env::var("COLUMNS"), std::env::var("LINES")) {
        if let (Ok(cols), Ok(rows)) = (cols.parse::<u16>(), rows.parse::<u16>()) {
            return (cols.max(20), rows);
        }
    }
    // OS console size (ioctl on Unix, screen buffer on Windows). None when
    // stdout isn't a console (piped/redirected) -> fall through to 80x24.
    console_size().unwrap_or((80, 24))
}

/// PTY process context
pub struct PtyContext {
    pub master: Box<dyn MasterPty + Send>,
    pub child: Box<dyn portable_pty::Child + Send + Sync>,
    output_rx: mpsc::UnboundedReceiver<String>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
}

// Library-style PTY wrapper. `write` / `wait` / `kill` are stable helpers
// kept on the type so embedders / tests can drive the PTY directly even
// though the agent main loop only uses `get_writer`/`try_wait` today.
#[allow(dead_code)]
impl PtyContext {
    /// Write data to the PTY
    pub fn write(&self, data: &str) -> Result<()> {
        let mut writer = self
            .writer
            .lock()
            .map_err(|e| anyhow!("Lock error: {}", e))?;
        writer.write_all(data.as_bytes())?;
        writer.flush()?;
        Ok(())
    }

    /// Read available data from the PTY (non-blocking via channel)
    pub fn try_recv(&mut self) -> Option<String> {
        self.output_rx.try_recv().ok()
    }

    /// Get a cloned writer for async writing
    pub fn get_writer(&self) -> Arc<Mutex<Box<dyn Write + Send>>> {
        self.writer.clone()
    }

    /// Check if child process has exited
    pub fn try_wait(&mut self) -> Result<Option<portable_pty::ExitStatus>> {
        Ok(self.child.try_wait()?)
    }

    /// Wait for child process to exit
    pub fn wait(&mut self) -> Result<portable_pty::ExitStatus> {
        Ok(self.child.wait()?)
    }

    /// Kill the child process (and its whole process group).
    pub fn kill(&mut self) -> Result<()> {
        self.reap_group(); // take leaked descendants (a `yes | cmd`, etc.) with it
        self.child.kill()?;
        Ok(())
    }

    /// SIGKILL the child's entire process group. The PTY child is its own
    /// session/group leader (portable_pty calls setsid), so descendants it
    /// spawned share its pgid — even after the child exits and they reparent to
    /// PID 1, because reparenting changes ppid but not pgid. Without this a
    /// leaked `yes | cmd` (and the like) spins at ~100% CPU forever. Targets the
    /// recorded pgid, never ppid==1, so it's container-safe and never touches
    /// processes outside this agent's session.
    pub fn reap_group(&self) {
        #[cfg(unix)]
        if let Some(pid) = self.child.process_id() {
            let pid = pid as i32;
            // Resolve the child's group; fall back to its pid (== pgid for a
            // session leader) if it has already exited and getpgid fails.
            let pgid = unsafe { libc::getpgid(pid) };
            let target = if pgid > 0 { pgid } else { pid };
            // Negative target == "every process in group `target`".
            unsafe {
                libc::kill(-target, libc::SIGKILL);
            }
        }
    }

    /// Resize the PTY
    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        // Guard against zero dimensions, which can corrupt PTY state on some platforms
        let cols = cols.max(1);
        let rows = rows.max(1);
        self.master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }
}

/// Spawn an agent process in a PTY
pub async fn spawn_agent(
    cli: &str,
    args: &[String],
    config: &CliConfig,
    cwd: &str,
    verbose: bool,
) -> Result<PtyContext> {
    let pty_system = native_pty_system();

    // Get terminal size from parent or use defaults
    let (cols, rows) = get_terminal_size();
    debug!("Using terminal size: {}x{}", cols, rows);

    // Create PTY with actual terminal size
    let pair = pty_system.openpty(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })?;

    // Destructure to get separate ownership of master and slave
    let master = pair.master;
    let slave = pair.slave;

    // Determine the binary to run
    let binary = config.binary.as_ref().map(|s| s.as_str()).unwrap_or(cli);

    // Build command - inherits parent environment by default
    // On Windows, use cmd.exe /c to resolve .cmd/.bat files via PATHEXT
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = CommandBuilder::new("cmd.exe");
        c.arg("/c");
        c.arg(binary);
        c
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = CommandBuilder::new(binary);
    for arg in args {
        cmd.arg(arg);
    }

    // Set working directory (passed from main to ensure consistency)
    cmd.cwd(cwd);

    // Tag the agent's env with our pid so a nested `ay` launched from inside this
    // agent inherits it as its parent_pid — this is what builds the agent>subagent
    // tree in `ay ls` and the console. Mirrors ts/index.ts.
    cmd.env("AGENT_YES_PID", std::process::id().to_string());

    // A caller-injected AGENT_YES_AGENT_ID (from `ay serve`'s /api/spawn) is for
    // THIS agent's record only (pid_store::new_agent_id reads it from our env).
    // Strip it from the wrapped CLI's env so the agent's subagents (a nested `ay`)
    // don't inherit it and register under the same id — which would make that id
    // ambiguous. Our own process env still carries it for new_agent_id().
    cmd.env_remove("AGENT_YES_AGENT_ID");

    // Strip the parent Claude Code session markers so the wrapped CLI is a CLEAN
    // top-level session. Without this, an `ay claude` launched from inside another
    // Claude Code session inherits CLAUDE_CODE_CHILD_SESSION — the child claude then
    // disables transcript saving ("⚠ Transcript saving is off …") — and
    // CLAUDE_CODE_SSE_PORT/SESSION_ID make it attach to the parent's stale session.
    // AGENT_YES_PID is re-stamped above (not stripped here). Mirrors
    // CLAUDE_SESSION_PIN_ENV in ts/sessionEnv.ts (and freshAgentEnv in ts/serve.ts).
    for key in CLAUDE_SESSION_PIN_ENV {
        cmd.env_remove(key);
    }

    // The agent runs in a PTY (a real terminal), so advertise terminal
    // capabilities. A console/daemon-spawned agent inherits an env with no TERM/
    // COLORTERM: neither the daemon (no controlling terminal) nor the recovered
    // login-shell env (captured without a tty) carries them — those vars are set
    // by the terminal emulator, not by the shell. Without them the wrapped CLI
    // renders colorless in the web console. Fill only when absent so a
    // terminal-launched agent keeps its real values (e.g. xterm-256color, tmux).
    if std::env::var_os("TERM").is_none() {
        cmd.env("TERM", "xterm-256color");
    }
    if std::env::var_os("COLORTERM").is_none() {
        cmd.env("COLORTERM", "truecolor");
    }

    // Inject per-CLI env (e.g. glm → Z.AI endpoint). Expand ${VAR} against the
    // launching env; skip entries whose vars are unset/empty so we never blank
    // out an inherited value (e.g. ANTHROPIC_AUTH_TOKEN when ZAI_API_KEY isn't
    // exported). Mirrors ts/index.ts.
    for (key, raw) in &config.env {
        let mut unresolved = false;
        let value = expand_env_vars(raw, &mut unresolved);
        if unresolved {
            continue;
        }
        cmd.env(key, value);
    }

    if verbose {
        debug!(
            "Spawning {} with args: {:?} in directory: {}",
            binary, args, cwd
        );
    }

    info!("Starting {} agent in {}...", cli, cwd);

    // Spawn the child
    let child = slave.spawn_command(cmd)?;

    // Scheduler policy: deprioritize the agent CLI so it yields CPU to the
    // interactive `ay serve` daemon (nice 0) under host load. RAISING serve's
    // priority (negative nice) needs CAP_SYS_NICE — dropped in many containers —
    // so we LOWER the agent's instead (always permitted for your own process).
    // The child's threads/descendants inherit it. Configurable via
    // AGENT_YES_AGENT_NICE (0..19, default 5, 0 = off). Mirrors ts/agentNice.ts.
    //
    // Unix only: on Windows the TS runtime's os.setPriority (which maps nice to a
    // BELOW_NORMAL/IDLE priority class) covers agents launched via that runtime;
    // a Windows-Rust SetPriorityClass branch is a follow-up (needs a Windows build
    // to verify the FFI, which can't be done from this Linux toolchain).
    #[cfg(unix)]
    if let Some(child_pid) = child.process_id() {
        // Parse as f64 then truncate toward zero (`as i32`) so a fractional value
        // like "3.9" → 3 matches ts/agentNice.ts's Number()+Math.trunc(), rather
        // than failing i32 parsing and silently falling back to the default.
        let nice = std::env::var("AGENT_YES_AGENT_NICE")
            .ok()
            .and_then(|v| v.trim().parse::<f64>().ok())
            .map(|f| f as i32)
            .unwrap_or(5)
            .clamp(0, 19);
        if nice > 0 {
            // Best-effort; ignore failures (a scheduling hint must never break a spawn).
            unsafe { libc::setpriority(libc::PRIO_PROCESS, child_pid, nice) };
        }
    }

    // CRITICAL: Drop the slave after spawning!
    // On Unix, keeping the slave open in the parent can cause writes to fail
    // in the child because the parent still holds references to the slave PTY.
    // This is the classic PTY programming pattern: fork, then close slave in parent.
    drop(slave);

    // Get reader and writer from master
    let mut reader = master.try_clone_reader()?;
    let writer = master.take_writer()?;

    // Create unbounded channel for PTY output.
    // IMPORTANT: Must be unbounded so the reader thread never blocks —
    // if stdout isn't being read, backpressure must NOT propagate to the
    // agent CLI. The agent must keep running regardless.
    // Memory is bounded by the 100KB output_buffer cap in context.rs.
    let (output_tx, output_rx) = mpsc::unbounded_channel::<String>();

    // Spawn reader thread
    thread::spawn(move || {
        let mut buf = [0u8; 8192]; // 8KB buffer like bun-pty
        let mut partial = Vec::new(); // Buffer for incomplete UTF-8 sequences
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF
                Ok(n) => {
                    // Prepend any leftover partial bytes from previous read
                    let combined;
                    let bytes: &[u8] = if partial.is_empty() {
                        &buf[..n]
                    } else {
                        partial.extend_from_slice(&buf[..n]);
                        combined = std::mem::take(&mut partial);
                        &combined
                    };

                    let (valid, leftover) = extract_valid_utf8(bytes);

                    if !valid.is_empty() {
                        if output_tx.send(valid.to_string()).is_err() {
                            break; // Channel closed
                        }
                    }

                    // Save any trailing incomplete bytes for next read
                    partial = leftover.to_vec();
                }
                Err(e) => {
                    debug!("PTY read error: {}", e);
                    break;
                }
            }
        }
    });

    Ok(PtyContext {
        master,
        child,
        output_rx,
        writer: Arc::new(Mutex::new(writer)),
    })
}

/// Check if error is "command not found".
///
/// Used by the auto-install path; called only when `--install` triggers a
/// recovery flow, so under typical runs this is unused. Kept here rather
/// than inline to make the failure-string heuristics greppable.
#[allow(dead_code)]
pub fn is_command_not_found_error(error: &str) -> bool {
    error.contains("command not found")
        || error.contains("not recognized")
        || error.contains("No such file")
        || error.contains("not found")
}

/// Extract valid UTF-8 from a byte slice, returning (valid_string, leftover_bytes).
/// Incomplete multi-byte sequences at the end are returned as leftover.
/// Invalid bytes in the middle are skipped.
pub fn extract_valid_utf8(bytes: &[u8]) -> (&str, &[u8]) {
    match std::str::from_utf8(bytes) {
        Ok(s) => (s, &[]),
        Err(e) => {
            let valid_up_to = e.valid_up_to();
            let valid_str = unsafe { std::str::from_utf8_unchecked(&bytes[..valid_up_to]) };
            match e.error_len() {
                // Incomplete sequence at end — return as leftover for next read
                None => (valid_str, &bytes[valid_up_to..]),
                // Invalid byte in the middle — skip it, no leftover
                Some(len) => {
                    // We return just the valid prefix; the caller will discard the bad byte
                    // on next iteration via the partial buffer logic
                    (valid_str, &bytes[valid_up_to + len..])
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // Serialize tests that mutate env vars — std::env::set_var is not thread-safe
    static ENV_MUTEX: Mutex<()> = Mutex::new(());

    #[test]
    fn test_expand_env_vars() {
        let _guard = ENV_MUTEX.lock().unwrap();
        std::env::set_var("AY_TEST_KEY", "secret");
        std::env::remove_var("AY_TEST_MISSING");

        // Static text passes through, no expansion needed.
        let mut unresolved = false;
        assert_eq!(
            expand_env_vars("https://api.z.ai/api/anthropic", &mut unresolved),
            "https://api.z.ai/api/anthropic"
        );
        assert!(!unresolved);

        // ${VAR} expands against the environment.
        let mut unresolved = false;
        assert_eq!(
            expand_env_vars("Bearer ${AY_TEST_KEY}", &mut unresolved),
            "Bearer secret"
        );
        assert!(!unresolved);

        // Unset var flags unresolved so the caller can skip the assignment.
        let mut unresolved = false;
        let _ = expand_env_vars("${AY_TEST_MISSING}", &mut unresolved);
        assert!(unresolved);

        // Unterminated ${ is emitted literally and doesn't flag unresolved.
        let mut unresolved = false;
        assert_eq!(expand_env_vars("${oops", &mut unresolved), "${oops");
        assert!(!unresolved);

        // ${VAR:-default}: set var wins, unset var falls back, never unresolved.
        let mut unresolved = false;
        assert_eq!(
            expand_env_vars("${AY_TEST_KEY:-fallback}", &mut unresolved),
            "secret"
        );
        assert!(!unresolved);
        let mut unresolved = false;
        assert_eq!(
            expand_env_vars("${AY_TEST_MISSING:-z-ai/glm-5.2}", &mut unresolved),
            "z-ai/glm-5.2"
        );
        assert!(!unresolved);

        std::env::remove_var("AY_TEST_KEY");
    }

    #[test]
    fn test_claude_session_pin_env_stripped() {
        use std::ffi::OsStr;
        // The claude marker that turns transcript saving off must be in the set.
        assert!(CLAUDE_SESSION_PIN_ENV.contains(&"CLAUDE_CODE_CHILD_SESSION"));

        let mut cmd = CommandBuilder::new("true");
        // Simulate the env inherited from a parent Claude Code session…
        for key in CLAUDE_SESSION_PIN_ENV {
            cmd.env(key, "inherited");
        }
        // …alongside config that MUST survive (a non-pin CLAUDE_CODE_* var, and
        // AGENT_YES_PID which is re-stamped, not stripped).
        cmd.env("CLAUDE_CODE_MAX_OUTPUT_TOKENS", "8000");
        cmd.env("AGENT_YES_PID", "999");

        // Same removal loop the spawn path runs.
        for key in CLAUDE_SESSION_PIN_ENV {
            cmd.env_remove(key);
        }

        for key in CLAUDE_SESSION_PIN_ENV {
            assert!(cmd.get_env(key).is_none(), "{key} should be stripped");
        }
        assert_eq!(
            cmd.get_env("CLAUDE_CODE_MAX_OUTPUT_TOKENS"),
            Some(OsStr::new("8000")),
            "non-pin CLAUDE_CODE_* config must pass through"
        );
        assert_eq!(
            cmd.get_env("AGENT_YES_PID"),
            Some(OsStr::new("999")),
            "AGENT_YES_PID is re-stamped, not stripped"
        );
    }

    #[test]
    fn test_is_command_not_found() {
        assert!(is_command_not_found_error("bash: foo: command not found"));
        assert!(is_command_not_found_error("'foo' is not recognized"));
        assert!(is_command_not_found_error("No such file or directory"));
        assert!(!is_command_not_found_error("Some other error"));
    }

    #[test]
    fn test_extract_valid_utf8_ascii() {
        let bytes = b"hello world";
        let (valid, leftover) = extract_valid_utf8(bytes);
        assert_eq!(valid, "hello world");
        assert!(leftover.is_empty());
    }

    #[test]
    fn test_extract_valid_utf8_complete_multibyte() {
        // 门 = E9 97 A8 (3 bytes)
        let bytes = "hello门world".as_bytes();
        let (valid, leftover) = extract_valid_utf8(bytes);
        assert_eq!(valid, "hello门world");
        assert!(leftover.is_empty());
    }

    #[test]
    fn test_extract_valid_utf8_split_at_first_byte() {
        // 门 = E9 97 A8 — only first byte present
        let bytes = &[b'h', b'i', 0xE9];
        let (valid, leftover) = extract_valid_utf8(bytes);
        assert_eq!(valid, "hi");
        assert_eq!(leftover, &[0xE9]);
    }

    #[test]
    fn test_extract_valid_utf8_split_at_second_byte() {
        // 门 = E9 97 A8 — first two bytes present
        let bytes = &[b'h', b'i', 0xE9, 0x97];
        let (valid, leftover) = extract_valid_utf8(bytes);
        assert_eq!(valid, "hi");
        assert_eq!(leftover, &[0xE9, 0x97]);
    }

    #[test]
    fn test_extract_valid_utf8_reassemble() {
        // Simulate split read: first chunk has partial 门, second has the rest
        let full = "hi门bye";
        let full_bytes = full.as_bytes();

        // Split at byte 3 (middle of 门: bytes 2,3,4 = E9,97,A8)
        let chunk1 = &full_bytes[..3]; // b"hi" + 0xE9
        let chunk2 = &full_bytes[3..]; // 0x97, 0xA8, b"bye"

        // First read
        let (valid1, leftover1) = extract_valid_utf8(chunk1);
        assert_eq!(valid1, "hi");
        assert_eq!(leftover1, &[0xE9]);

        // Second read: prepend leftover
        let mut combined = leftover1.to_vec();
        combined.extend_from_slice(chunk2);
        let (valid2, leftover2) = extract_valid_utf8(&combined);
        assert_eq!(valid2, "门bye");
        assert!(leftover2.is_empty());
    }

    #[test]
    fn test_extract_valid_utf8_emoji_split() {
        // 🦀 = F0 9F A6 80 (4 bytes)
        let full = "a🦀b";
        let full_bytes = full.as_bytes();

        // Split after 2 bytes of the emoji
        let chunk1 = &full_bytes[..3]; // b"a" + F0 9F
        let chunk2 = &full_bytes[3..]; // A6 80 b"b"

        let (valid1, leftover1) = extract_valid_utf8(chunk1);
        assert_eq!(valid1, "a");
        assert_eq!(leftover1, &[0xF0, 0x9F]);

        let mut combined = leftover1.to_vec();
        combined.extend_from_slice(chunk2);
        let (valid2, leftover2) = extract_valid_utf8(&combined);
        assert_eq!(valid2, "🦀b");
        assert!(leftover2.is_empty());
    }

    #[test]
    fn test_extract_valid_utf8_multiple_chinese_chars() {
        // Simulate the album 门 scenario with mixed CJK
        let text = "The album 门 loaded with 1 photo";
        let bytes = text.as_bytes();
        let (valid, leftover) = extract_valid_utf8(bytes);
        assert_eq!(valid, text);
        assert!(leftover.is_empty());
    }

    #[test]
    fn test_extract_valid_utf8_empty() {
        let (valid, leftover) = extract_valid_utf8(&[]);
        assert_eq!(valid, "");
        assert!(leftover.is_empty());
    }

    /// Verify that the unbounded channel never blocks the sender,
    /// even when the receiver isn't consuming messages.
    /// This simulates the scenario where stdout isn't being read
    /// but the agent CLI must keep running.
    #[test]
    fn test_unbounded_channel_no_backpressure() {
        let (tx, _rx) = mpsc::unbounded_channel::<String>();

        // Send many messages without reading — should never block
        for i in 0..5000 {
            tx.send(format!("output line {}\n", i))
                .expect("unbounded send should never fail while receiver exists");
        }

        // Sender completes instantly — no blocking occurred
        // (a bounded channel with blocking_send would stall here)
    }

    /// Spawn a real PTY, resize it, then verify the child shell sees the new dimensions via `stty size`.
    #[cfg(unix)]
    #[test]
    #[cfg_attr(tarpaulin, ignore)] // PTY child signals crash tarpaulin's ptrace
    fn test_pty_resize_reflected_in_child() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        use std::io::Read;
        use std::time::{Duration, Instant};

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty failed");

        let mut cmd = CommandBuilder::new("sh");
        cmd.args(["-c", "stty size"]);
        let _child = pair.slave.spawn_command(cmd).expect("spawn failed");
        drop(pair.slave);

        // Resize before the child reads its terminal attributes
        pair.master
            .resize(PtySize {
                rows: 40,
                cols: 120,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("resize failed");

        // Read all output with a 2-second deadline
        let mut reader = pair.master.try_clone_reader().expect("clone reader failed");
        let mut output = String::new();
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut buf = [0u8; 256];
        loop {
            // Use a short timeout by setting the read to non-blocking after deadline
            if Instant::now() >= deadline {
                break;
            }
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => output.push_str(&String::from_utf8_lossy(&buf[..n])),
            }
            if output.contains('\n') {
                break;
            }
        }

        // `stty size` prints "rows cols\n"
        let trimmed = output.trim();
        assert!(
            trimmed.contains("40 120") || trimmed.ends_with("40 120"),
            "expected '40 120' in stty output, got: {:?}",
            trimmed
        );
    }

    #[test]
    #[cfg_attr(tarpaulin, ignore)] // PTY child signals crash tarpaulin's ptrace
    fn test_pty_resize_zero_guard() {
        use portable_pty::{native_pty_system, PtySize};

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty failed");

        // Build a PtyContext directly to test the zero-guard in resize().
        // The child just has to be *some* command that exits quickly; the test
        // only exercises the resize clamp, never reads the PTY output. `true`
        // is a Unix shell builtin and does not exist as a binary on Windows
        // (`CreateProcessW` fails with `file not found`), so branch on platform:
        // `cmd /c exit` is the Windows equivalent that exits 0 immediately.
        #[cfg(unix)]
        let child_cmd = CommandBuilder::new("true");
        #[cfg(windows)]
        let child_cmd = {
            let mut b = CommandBuilder::new("cmd");
            b.args(["/c", "exit"]);
            b
        };

        let (_, output_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let writer = pair.master.take_writer().expect("take_writer");
        let ctx = PtyContext {
            master: pair.master,
            child: pair.slave.spawn_command(child_cmd).expect("spawn"),
            output_rx,
            writer: std::sync::Arc::new(std::sync::Mutex::new(writer)),
        };
        drop(pair.slave);

        // resize(0, 0) must not panic or return an error — guard clamps to 1x1
        ctx.resize(0, 0)
            .expect("resize(0,0) should succeed via clamp");
        ctx.resize(0, 24)
            .expect("resize(0,24) should succeed via clamp");
        ctx.resize(80, 0)
            .expect("resize(80,0) should succeed via clamp");
    }

    #[test]
    fn test_parse_winsize_fresh() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis();
        let line = format!("120 40 {}", now);
        assert_eq!(parse_winsize_line(&line), Some((120, 40)));
    }

    #[test]
    fn test_parse_winsize_clamps_below_min_cols() {
        // get_terminal_size enforces a 20-col minimum; the winsize parser
        // applies the same floor for consistency.
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis();
        let line = format!("5 24 {}", now);
        assert_eq!(parse_winsize_line(&line), Some((20, 24)));
    }

    #[test]
    fn test_parse_winsize_stale() {
        // 60s old → must be rejected.
        let stale = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis()
            .saturating_sub(60_000);
        let line = format!("120 40 {}", stale);
        assert_eq!(parse_winsize_line(&line), None);
    }

    #[test]
    fn test_parse_winsize_rejects_zero_dims() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis();
        assert_eq!(parse_winsize_line(&format!("0 40 {}", now)), None);
        assert_eq!(parse_winsize_line(&format!("80 0 {}", now)), None);
    }

    #[test]
    fn test_parse_winsize_rejects_malformed() {
        assert_eq!(parse_winsize_line(""), None);
        assert_eq!(parse_winsize_line("not numbers here"), None);
        assert_eq!(parse_winsize_line("80 24"), None); // missing timestamp
        assert_eq!(parse_winsize_line("80 24 abc"), None);
    }

    #[test]
    fn test_read_external_winsize_missing_returns_none() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_external_winsize_from(dir.path(), 99_999), None);
    }

    #[test]
    fn test_read_external_winsize_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let winsize_dir = dir.path().join("winsize");
        std::fs::create_dir_all(&winsize_dir).unwrap();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis();
        std::fs::write(winsize_dir.join("12345"), format!("132 50 {}\n", now)).unwrap();
        assert_eq!(
            read_external_winsize_from(dir.path(), 12345),
            Some((132, 50))
        );
    }

    #[test]
    fn test_read_external_winsize_ignores_stale_file_on_disk() {
        // End-to-end: a file on disk older than 30s is rejected by the
        // freshness gate even though its content is otherwise valid.
        let dir = tempfile::tempdir().unwrap();
        let winsize_dir = dir.path().join("winsize");
        std::fs::create_dir_all(&winsize_dir).unwrap();
        let stale = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis()
            .saturating_sub(60_000);
        std::fs::write(winsize_dir.join("42"), format!("100 30 {}\n", stale)).unwrap();
        assert_eq!(read_external_winsize_from(dir.path(), 42), None);
    }

    #[test]
    fn test_get_terminal_size_returns_valid_dimensions() {
        let (cols, rows) = get_terminal_size();
        // Must always return at least 1x1 to be a valid terminal size
        assert!(cols >= 1, "cols must be >= 1, got {}", cols);
        assert!(rows >= 1, "rows must be >= 1, got {}", rows);
        // Should return at least the enforced minimum cols
        assert!(
            cols >= 20,
            "cols must be >= 20 (enforced minimum), got {}",
            cols
        );
    }

    #[test]
    fn test_get_terminal_size_env_override() {
        // COLUMNS/LINES env vars should take precedence
        // Hold ENV_MUTEX for the entire test to prevent races with other env-var tests
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("COLUMNS", "132");
        std::env::set_var("LINES", "50");
        let (cols, rows) = get_terminal_size();
        std::env::remove_var("COLUMNS");
        std::env::remove_var("LINES");
        assert_eq!(cols, 132);
        assert_eq!(rows, 50);
    }

    #[test]
    fn test_get_terminal_size_env_override_enforces_min_cols() {
        // COLUMNS below 20 should be clamped to 20
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("COLUMNS", "5");
        std::env::set_var("LINES", "24");
        let (cols, _rows) = get_terminal_size();
        std::env::remove_var("COLUMNS");
        std::env::remove_var("LINES");
        assert_eq!(cols, 20, "cols below minimum should be clamped to 20");
    }
}
