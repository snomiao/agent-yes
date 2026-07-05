//! Agent context and main orchestrator

use crate::codex_sessions;
use crate::config::CliConfig;
use crate::idle_waiter::IdleWaiter;
use crate::log_files::LogWriter;
use crate::messaging::{send_ctrl_c, send_esc, send_text, MessageContext};
use crate::pty_spawner::{get_terminal_size, PtyContext};
use crate::ready_manager::ReadyManager;
use crate::utils::sleep_ms;
use crate::vterm::VTermProxy;
use anyhow::Result;
use crossterm::terminal;
use std::io::Write;
use std::time::{Duration, Instant};
use tokio::io::AsyncReadExt;
use tokio::sync::{mpsc, watch};
use tracing::{debug, error, info, warn};

const HEARTBEAT_INTERVAL_MS: u64 = 50; // Check frequently for Enter timing and patterns
const FORCE_READY_TIMEOUT_MS: u64 = 10000;
const ENTER_IDLE_WAIT_MS: u64 = 50; // Wait for 50ms idle before sending Enter (reduced from 1000 due to cursor control sequences)
const ENTER_RETRY_1_MS: u64 = 500; // Retry after 500ms if no response
const ENTER_RETRY_2_MS: u64 = 1500; // Retry after 1500ms if no response
const IDLE_SCAN_INTERVAL_MS: u64 = 60000; // Re-scan rendered screen every 60s of idle

// Auto-retry on recoverable API errors (overload / rate-limit / usage-limit):
// type "retry" with exponential backoff instead of giving up.
const RETRY_BASE_SECS: u64 = 8; // first backoff; doubles each consecutive failure

/// After the no-output watchdog sends Esc, how long to wait for the stream to
/// recover before escalating to a forced restart. A working Esc repaints the
/// screen (output → idle resets → stall clears) well within this window.
const STALL_ESC_GRACE_SECS: u64 = 30;
const RETRY_MAX_DELAY_SECS: u64 = 256; // cap per-retry backoff: 8,16,32,…,256 then hold

/// Minimum quiet time (no PTY output, no forwarded stdin — see idle_waiter.ping()
/// call sites) required before a scheduled auto-retry may actually fire, on top
/// of the backoff delay above. The backoff schedule alone can elapse while the
/// user is mid-typing into the prompt; typing "retry" + Enter over that would
/// submit a mangled line. Deliberately short — this only debounces against
/// active typing, not a real excuse to delay recovery.
const RETRY_MIN_IDLE_MS: u64 = 5_000;

// Rapid-Ctrl-C panic gesture: a human escape hatch for an agent wedged on a
// silent stall that ignores forwarded Ctrl-C. Pressing Ctrl-C this many times
// within the window is read as "get me out": the first completed gesture
// Esc-cancels the in-flight request; a second while still stuck forces a restart
// (exit 75 → a --robust parent resumes with --continue).
const PANIC_CTRL_C_COUNT: usize = 5;
const PANIC_CTRL_C_WINDOW_SECS: u64 = 2;
const RETRY_GIVE_UP_SECS: u64 = 8 * 3600; // stop after 8h (claude's usage window is ~5h)

/// What the no-output watchdog should do this tick. Pure decision so it can be
/// unit-tested without a live PTY/vterm.
#[derive(Debug, PartialEq, Eq)]
enum StallAction {
    /// Not stalled (or watchdog disabled): clear any arming.
    Clear,
    /// Stalled and not yet acted on: send Esc to cancel the in-flight request.
    SendEsc,
    /// Esc already sent and the grace window elapsed with no recovery: restart.
    ForceRestart,
    /// Stalled, Esc sent, still inside the grace window: wait.
    Wait,
}

/// Decide the watchdog action from observable state. A live CLI repaints its
/// spinner timer every second (visible output → `idle_secs` stays low), so a
/// `working` screen with `idle_secs >= timeout_secs` means the stream stalled.
/// `esc_sent_elapsed_secs` is `Some(elapsed)` once Esc has been sent this stall.
fn decide_stall_action(
    timeout_secs: u64,
    working: bool,
    idle_secs: u64,
    esc_sent_elapsed_secs: Option<u64>,
    esc_grace_secs: u64,
) -> StallAction {
    if timeout_secs == 0 || !working || idle_secs < timeout_secs {
        return StallAction::Clear;
    }
    match esc_sent_elapsed_secs {
        None => StallAction::SendEsc,
        Some(elapsed) if elapsed >= esc_grace_secs => StallAction::ForceRestart,
        Some(_) => StallAction::Wait,
    }
}

#[derive(Debug, PartialEq, Eq)]
enum PanicAction {
    /// Gesture incomplete: fewer than `threshold` presses in the window.
    None,
    /// Gesture complete, first time this stall: Esc-cancel the request.
    Esc,
    /// Gesture complete again while an Esc is still in flight (output hasn't
    /// resumed): escalate to a forced restart.
    ForceKill,
}

/// Decide the rapid-Ctrl-C panic action. `recent` is the number of Ctrl-C
/// presses inside the trailing window; `esc_in_flight` is true once this gesture
/// already sent an Esc that output hasn't recovered from yet.
fn decide_panic_action(recent: usize, threshold: usize, esc_in_flight: bool) -> PanicAction {
    if recent < threshold {
        return PanicAction::None;
    }
    if esc_in_flight {
        PanicAction::ForceKill
    } else {
        PanicAction::Esc
    }
}

/// Exponential backoff (seconds) for the Nth consecutive auto-retry, capped.
fn retry_backoff_secs(streak: u32) -> u64 {
    let shift = streak.min(20); // guard against shift overflow on pathological streaks
    RETRY_BASE_SECS
        .saturating_mul(1u64 << shift)
        .min(RETRY_MAX_DELAY_SECS)
}

/// Whether a scheduled auto-retry may actually fire: the agent must be sitting
/// idle at a ready prompt (not mid-work) AND the terminal must have been quiet
/// for at least `min_idle_ms` — see RETRY_MIN_IDLE_MS.
fn should_fire_retry(working: bool, ready: bool, idle_ms: u64, min_idle_ms: u64) -> bool {
    !working && ready && idle_ms >= min_idle_ms
}

/// Agent context - centralized session state
pub struct AgentContext {
    pub cli: String,
    pub cli_config: CliConfig,
    /// Captured from CLI flags; read by tracing/log filters configured outside
    /// this struct and by call sites that branch on verbose-only diagnostics.
    #[allow(dead_code)]
    pub verbose: bool,
    /// Captured from --robust; the main.rs restart loop reads it directly from
    /// CliArgs rather than going through the context, so this copy is unused
    /// at present but kept for symmetry / future internal consumers.
    #[allow(dead_code)]
    pub robust: bool,
    pub auto_yes_enabled: bool,
    pub is_fatal: bool,
    pub is_user_abort: bool,
    pub should_restart_without_continue: bool,

    // State managers
    pub stdin_ready: ReadyManager,
    pub stdin_first_ready: ReadyManager,
    pub next_stdout: ReadyManager,
    pub idle_waiter: IdleWaiter,

    // Buffer for pattern matching
    output_buffer: String,
    vterm: VTermProxy,
    start_time: Instant,

    // Hash of vterm screen contents at the last typing_respond/enter match.
    // Suppresses re-trigger of one-shot patterns until the screen actually
    // changes (vterm contents() persists, unlike the old append-only buffer).
    last_action_screen_hash: Option<u64>,

    // Hash of vterm screen contents at the last full pattern check. Used to
    // short-circuit check_patterns() entirely when nothing on screen changed
    // — heartbeat_check() can call check_patterns() every 50ms for no_eol
    // CLIs, so re-running all regexes on an unchanged screen is wasteful.
    last_checked_screen_hash: Option<u64>,

    // Enter key scheduling
    pending_enter: bool,
    pending_enter_detected_at: Option<Instant>,
    enter_sent_at: Option<Instant>,
    enter_retry_count: u8,

    // Auto-retry on recoverable API errors (overload / rate-limit / usage-limit).
    // `streak` doubles the backoff on each consecutive failed retry; `started_at`
    // anchors the 8h give-up window; `next_at` is Some while a retry is scheduled.
    auto_retry_streak: u32,
    auto_retry_started_at: Option<Instant>,
    auto_retry_next_at: Option<Instant>,

    // Idle screen scanner - re-checks enter patterns after prolonged idle
    last_idle_scan_at: Option<Instant>,

    // Stdout overflow tracking
    stdout_drop_count: u64,

    // Per-session log file writer
    log_writer: LogWriter,

    // Working directory (for codex session storage)
    cwd: String,

    // Stdin line accumulator for /auto command detection
    stdin_line_buffer: String,

    // Stop scanning for codex session ID after first one is found
    codex_session_found: bool,

    // True once the session ever switched to the alternate screen buffer.
    // dump_scrollback() reconstructs only the normal buffer, so when this is
    // set the raw log must NOT be replaced by the rendered log on exit.
    used_alt_screen: bool,

    // When false, stdout is not a TTY (or --no-tty was passed): suppress raw
    // PTY passthrough and emit plain rendered text on exit instead.
    render_plain: bool,
    non_tty_renderer: crate::non_tty_renderer::NonTtyRenderer,

    // No-output watchdog (silent-stream-stall recovery). `stall_esc_sent_at` is
    // set when we Esc-cancel a suspected stall and cleared the moment output
    // resumes; `stall_force_restart` is raised when Esc fails to unstick it, so
    // the run exits non-zero and a `--robust` parent resumes with --continue.
    stall_esc_sent_at: Option<Instant>,
    pub stall_force_restart: bool,

    // Rapid-Ctrl-C panic gesture (human escape hatch, see PANIC_CTRL_C_COUNT).
    // `ctrl_c_times` holds recent Ctrl-C Instants trimmed to the trailing window;
    // `panic_esc_sent_at` arms once the gesture Esc-cancels a wedged request and
    // clears the moment visible output resumes, so a repeat gesture escalates to
    // a forced restart rather than re-sending Esc.
    ctrl_c_times: Vec<Instant>,
    panic_esc_sent_at: Option<Instant>,

    // Our own pid — needed to update this agent's pid_store record (the
    // unresponsive flag) from inside the loop.
    pid: u32,

    // Liveness tracking. `last_stdin_at` is stamped whenever we send a
    // high-signal poke (user/FIFO input, auto-Enter, auto-retry, typing
    // response, idle action); `last_output_at` advances on every PTY chunk.
    // If a poke is followed by no output for `cli_config.unresponsive_timeout_ms`,
    // the poke-based detector trips (see check_responsiveness). Disabled when
    // that timeout is 0.
    last_stdin_at: Option<Instant>,
    last_output_at: Instant,
    // Unified "stuck" liveness. `unresponsive` is the single flag published to
    // the pid_store + webhook; it is the OR of the two detectors' sub-states,
    // edge-triggered in update_unresponsive():
    //   - `poke_unresponsive`: no PTY bytes after a stdin poke (responsiveness).
    //   - `watchdog_stalled`:  the no-output stall watchdog sees a frozen
    //     "working" spinner (stall_watchdog_check) — the same condition that
    //     drives Esc/force-restart recovery, now surfaced on the flag too so a
    //     CLI being actively rescued also reads as stuck in `ay ls`.
    poke_unresponsive: bool,
    watchdog_stalled: bool,
    unresponsive: bool,
}

impl AgentContext {
    pub fn new(
        cli: String,
        cli_config: CliConfig,
        verbose: bool,
        robust: bool,
        auto_yes_enabled: bool,
        cwd: String,
        pid: u32,
        term_rows: u16,
        term_cols: u16,
        render_plain: bool,
    ) -> Self {
        Self {
            cli,
            cli_config,
            verbose,
            robust,
            auto_yes_enabled,
            is_fatal: false,
            is_user_abort: false,
            should_restart_without_continue: false,
            stdin_ready: ReadyManager::new(),
            stdin_first_ready: ReadyManager::new(),
            next_stdout: ReadyManager::new(),
            idle_waiter: IdleWaiter::new(),
            output_buffer: String::new(),
            vterm: VTermProxy::new(term_rows, term_cols),
            start_time: Instant::now(),
            pending_enter: false,
            pending_enter_detected_at: None,
            enter_sent_at: None,
            enter_retry_count: 0,
            auto_retry_streak: 0,
            auto_retry_started_at: None,
            auto_retry_next_at: None,
            stall_esc_sent_at: None,
            stall_force_restart: false,
            ctrl_c_times: Vec::new(),
            panic_esc_sent_at: None,
            last_idle_scan_at: None,
            stdout_drop_count: 0,
            log_writer: LogWriter::new(pid, &cwd),
            cwd,
            stdin_line_buffer: String::new(),
            codex_session_found: false,
            render_plain,
            non_tty_renderer: crate::non_tty_renderer::NonTtyRenderer::new(),
            last_action_screen_hash: None,
            last_checked_screen_hash: None,
            used_alt_screen: false,
            pid,
            last_stdin_at: None,
            last_output_at: Instant::now(),
            poke_unresponsive: false,
            watchdog_stalled: false,
            unresponsive: false,
        }
    }

    /// Path to the raw log file for this session (for PID store registration)
    pub fn raw_log_path(&self) -> Option<String> {
        self.log_writer
            .raw_log_path
            .as_ref()
            .map(|p| p.to_string_lossy().to_string())
    }

    /// On exit, render the full scrollback to `<pid>.log` and remove the raw
    /// byte log (which exists only for live tailing). Returns the rendered log
    /// path when it replaced the raw log, so the caller can repoint the pid
    /// index at it. No-op (returns None, keeping the raw log) when the session
    /// used the alternate screen — whose content the scrollback can't
    /// reconstruct — or when the render is empty.
    pub fn finalize_log(&mut self) -> Option<String> {
        if self.used_alt_screen {
            return None;
        }
        let raw_path = self.log_writer.raw_log_path.clone()?;
        let raw_str = raw_path.to_string_lossy();
        let base = raw_str.strip_suffix(".raw.log")?;
        let rendered_path = std::path::PathBuf::from(format!("{base}.log"));

        let rendered = self.vterm.dump_scrollback();
        if rendered.trim().is_empty() {
            return None;
        }

        // Write the rendered log first; only drop the raw log once it's durable.
        if let Err(e) = std::fs::write(&rendered_path, rendered.as_bytes()) {
            warn!("Failed to write rendered log {:?}: {}", rendered_path, e);
            return None;
        }
        if let Err(e) = std::fs::remove_file(&raw_path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                warn!("Failed to remove raw log {:?}: {}", raw_path, e);
            }
        }
        Some(rendered_path.to_string_lossy().to_string())
    }

    /// Run the main agent loop.
    ///
    /// Superseded by `run_with_fifo` for the production path, but kept for
    /// callers that don't want FIFO IPC (e.g. embedded use). Delegates to
    /// `run_with_fifo` with no FIFO path so the two share one main loop.
    #[allow(dead_code)]
    pub async fn run(
        &mut self,
        pty: &mut PtyContext,
        timeout_ms: Option<u64>,
        idle_action: Option<&str>,
    ) -> Result<i32> {
        self.run_with_fifo(pty, timeout_ms, idle_action, None).await
    }

    /// Run with an optional FIFO whose bytes are forwarded into the same
    /// stdin channel as user input, giving `cy send` a path into the agent.
    pub async fn run_with_fifo(
        &mut self,
        pty: &mut PtyContext,
        timeout_ms: Option<u64>,
        idle_action: Option<&str>,
        fifo_path: Option<std::path::PathBuf>,
    ) -> Result<i32> {
        let writer = pty.get_writer();

        // Create message context
        let mut msg_ctx = MessageContext::new(
            writer.clone(),
            self.idle_waiter.clone(),
            self.stdin_ready.clone(),
            self.next_stdout.clone(),
        );

        // Spawn background stdout writer — decoupled from main loop so stdout
        // backpressure never blocks pattern matching or agent interaction.
        // The agent keeps running even if nobody reads our stdout.
        // Bounded at ~10MB (1250 × 8KB chunks) — if stdout is stuck, old output
        // is dropped. The agent's operation matters more than display completeness.
        let (stdout_tx, mut stdout_rx) = mpsc::channel::<String>(1250);
        let stdout_handle = tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            let mut stdout = tokio::io::stdout();
            while let Some(data) = stdout_rx.recv().await {
                // Best-effort write — if stdout is broken, just stop
                if stdout.write_all(data.as_bytes()).await.is_err() {
                    break;
                }
                let _ = stdout.flush().await;
            }
        });

        // Channel for stdin data — both the user's stdin AND the FIFO reader
        // converge here, so /auto detection, Ctrl+C handling, and PTY forwarding
        // work the same regardless of input origin.
        let (stdin_tx, mut stdin_rx) = mpsc::channel::<Vec<u8>>(100);

        // Spawn stdin reader task
        let stdin_handle = tokio::spawn({
            let stdin_tx = stdin_tx.clone();
            async move {
                let mut stdin = tokio::io::stdin();
                let mut buf = [0u8; 1024];
                loop {
                    match stdin.read(&mut buf).await {
                        Ok(0) => break,
                        Ok(n) => {
                            if stdin_tx.send(buf[..n].to_vec()).await.is_err() {
                                break;
                            }
                        }
                        Err(e) => {
                            error!("stdin read error: {}", e);
                            break;
                        }
                    }
                }
            }
        });

        // Spawn FIFO reader thread (if a FIFO was created for this agent).
        // Forwards into the same stdin_tx as user keystrokes, so /auto
        // detection, Ctrl+C handling, and stdin_ready gating apply identically.
        let fifo_handle: Option<std::thread::JoinHandle<()>> = if let Some(ref path) = fifo_path {
            #[cfg(any(unix, windows))]
            {
                match crate::fifo::spawn_fifo_reader(path.clone(), stdin_tx.clone()) {
                    Ok(h) => Some(h),
                    Err(e) => {
                        warn!("Failed to open FIFO for reading at {:?}: {}", path, e);
                        None
                    }
                }
            }
            #[cfg(not(any(unix, windows)))]
            {
                let _ = path;
                None
            }
        } else {
            None
        };
        // Drop our extra clone so the channel closes once both readers stop.
        drop(stdin_tx);

        // Main loop
        let mut heartbeat = tokio::time::interval(Duration::from_millis(HEARTBEAT_INTERVAL_MS));
        let mut force_ready_sent = false;
        let exit_code: i32;

        // Set terminal to raw mode for proper signal handling
        let _raw_mode = terminal::enable_raw_mode();

        // Watch channel for terminal resize events (SIGWINCH → child PTY).
        // watch semantics: sender never blocks, receiver always sees the latest value.
        // This is correct for PTY resize — only the current size matters, not history.
        let initial_size = get_terminal_size();
        let (resize_tx, mut resize_rx) = watch::channel::<(u16, u16)>(initial_size);

        // Sync PTY to current terminal size immediately — changed() won't fire for the
        // initial value, so any resize that happened between spawn_agent() and here
        // would be silently missed without this explicit call.
        if let Err(e) = pty.resize(initial_size.0, initial_size.1) {
            warn!(
                "Initial PTY resize to {}x{} failed: {}",
                initial_size.0, initial_size.1, e
            );
        }
        crate::pty_spawner::write_current_ptysize(
            std::process::id(),
            initial_size.0,
            initial_size.1,
        );
        // Keep vterm in sync with the same initial size, otherwise vterm
        // could remain stuck at AgentContext::new() dimensions until the
        // first SIGWINCH fires.
        self.vterm.resize(initial_size.1, initial_size.0);

        // Suppress unused-variable warning on platforms with no resize source.
        #[cfg(not(any(unix, windows)))]
        let _ = &resize_tx;

        // Spawn SIGWINCH listener — updates the watch whenever terminal is resized
        #[cfg(unix)]
        let _sigwinch_handle = {
            tokio::spawn(async move {
                use tokio::signal::unix::{signal, SignalKind};
                let mut sig = match signal(SignalKind::window_change()) {
                    Ok(s) => s,
                    Err(e) => {
                        warn!("Failed to register SIGWINCH handler: {}", e);
                        return;
                    }
                };
                let my_pid = std::process::id();
                loop {
                    if sig.recv().await.is_none() {
                        break;
                    }
                    // `ay attach` writes ~/.agent-yes/winsize/<pid> and then
                    // raises SIGWINCH on us, since we have no TTY of our own
                    // when running detached under an orchestrator. Prefer
                    // that over ioctl whenever the file is fresh — falling
                    // back to the local TTY keeps the existing in-terminal
                    // workflow working.
                    let size = crate::pty_spawner::read_external_winsize(my_pid)
                        .unwrap_or_else(|| crate::pty_spawner::console_size().unwrap_or((80, 24)));
                    if resize_tx.send(size).is_err() {
                        break;
                    }
                }
            })
        };

        // Windows has no SIGWINCH, so poll instead. Same source priority as the
        // unix handler: an external winsize file (web console / `ay attach`,
        // which can't deliver a signal here) first, then the live console size
        // (a raw cmd-window resize). The resize_rx arm below applies whatever
        // changes. `last` avoids re-sending an unchanged size every tick.
        #[cfg(windows)]
        let _resize_poll_handle = {
            let my_pid = std::process::id();
            let mut last = initial_size;
            tokio::spawn(async move {
                let mut tick = tokio::time::interval(Duration::from_millis(250));
                loop {
                    tick.tick().await;
                    // The run loop dropped resize_rx (agent exiting) — stop
                    // instead of polling forever. The send() below only fires
                    // on a size change, so without this an idle task would
                    // never notice closure, and robust restarts would pile up
                    // orphaned pollers.
                    if resize_tx.is_closed() {
                        break;
                    }
                    // External winsize file (web console / `ay attach`) first,
                    // then the live console. None = no reliable source this
                    // tick (piped/MSYS) -> leave the size untouched.
                    let Some(size) = crate::pty_spawner::read_external_winsize(my_pid)
                        .or_else(crate::pty_spawner::console_size)
                    else {
                        continue;
                    };
                    if size != last {
                        last = size;
                        if resize_tx.send(size).is_err() {
                            break;
                        }
                    }
                }
            })
        };

        loop {
            tokio::select! {
                // Heartbeat for pattern detection
                _ = heartbeat.tick() => {
                    self.heartbeat_check(&mut msg_ctx).await?;

                    // No-output watchdog escalated: Esc didn't unstick a stalled
                    // stream. Exit non-zero (not fatal/abort) so a --robust parent
                    // restarts the CLI with its --continue restore args.
                    if self.stall_force_restart {
                        warn!("Stall watchdog: exiting run to trigger restart");
                        exit_code = 75; // EX_TEMPFAIL
                        break;
                    }

                    // Force ready after timeout
                    if !force_ready_sent && self.start_time.elapsed().as_millis() > FORCE_READY_TIMEOUT_MS as u128 {
                        if !self.stdin_ready.is_ready().await {
                            debug!("Force ready after timeout");
                            self.stdin_ready.ready().await;
                            self.stdin_first_ready.ready().await;
                            force_ready_sent = true;
                        }
                    }
                }

                // Terminal resize: propagate SIGWINCH to child PTY
                Ok(()) = resize_rx.changed() => {
                    let (cols, rows) = *resize_rx.borrow_and_update();
                    debug!("SIGWINCH: resizing PTY to {}x{}", cols, rows);
                    if let Err(e) = pty.resize(cols, rows) {
                        warn!("PTY resize to {}x{} failed: {}", cols, rows, e);
                    }
                    self.vterm.resize(rows, cols);
                    crate::pty_spawner::write_current_ptysize(std::process::id(), cols, rows);
                }

                // Stdin data
                Some(data) = stdin_rx.recv() => {
                    // Check for Ctrl+C
                    if data.contains(&0x03) {
                        // Only abort if stdin not ready (still loading)
                        if !self.stdin_ready.is_ready().await {
                            info!("User aborted: SIGINT");
                            self.is_user_abort = true;
                            send_ctrl_c(&writer)?;
                            exit_code = 130;
                            break;
                        } else {
                            // Record the press(es) and check the rapid-Ctrl-C
                            // panic gesture — a human escape hatch for an agent
                            // wedged on a silent stall that ignores forwarded
                            // Ctrl-C. Count every 0x03 in the chunk: a fast burst
                            // can arrive coalesced in a single read, and one
                            // timestamp per chunk would never reach the threshold.
                            let now = Instant::now();
                            let presses = data.iter().filter(|&&b| b == 0x03).count().max(1);
                            for _ in 0..presses {
                                self.ctrl_c_times.push(now);
                            }
                            let window = Duration::from_secs(PANIC_CTRL_C_WINDOW_SECS);
                            self.ctrl_c_times
                                .retain(|t| now.duration_since(*t) <= window);
                            match decide_panic_action(
                                self.ctrl_c_times.len(),
                                PANIC_CTRL_C_COUNT,
                                self.panic_esc_sent_at.is_some(),
                            ) {
                                PanicAction::None => {
                                    // Forward Ctrl+C to agent — a live TUI redraws
                                    // (e.g. an interrupt prompt), so treat it as a
                                    // liveness poke.
                                    send_ctrl_c(&writer)?;
                                    self.idle_waiter.ping();
                                    self.mark_stdin_sent();
                                }
                                PanicAction::Esc => {
                                    warn!(
                                        "Panic gesture: {}x Ctrl-C in {}s — sending Esc to \
                                         cancel a wedged request (repeat to force restart)",
                                        PANIC_CTRL_C_COUNT, PANIC_CTRL_C_WINDOW_SECS
                                    );
                                    // send_esc (NOT send_text) so we don't reset the
                                    // idle timer; mirrors the no-output watchdog. If
                                    // output resumes, handle_output disarms this.
                                    send_esc(&writer)?;
                                    self.panic_esc_sent_at = Some(now);
                                    self.ctrl_c_times.clear();
                                }
                                PanicAction::ForceKill => {
                                    warn!(
                                        "Panic gesture repeated while still stuck — forcing \
                                         restart (a --robust run resumes with --continue)"
                                    );
                                    // Picked up next heartbeat → exit 75 → restart.
                                    self.stall_force_restart = true;
                                    self.ctrl_c_times.clear();
                                }
                            }
                        }
                    }
                    // Check for Ctrl+Y (toggle auto-yes)
                    else if data.contains(&0x19) {
                        self.toggle_auto_yes().await;
                    }
                    // Text input: accumulate line buffer for /auto detection
                    else if let Ok(text) = String::from_utf8(data.clone()) {
                        self.stdin_line_buffer.push_str(&text);
                        let has_enter = text.contains('\r') || text.contains('\n');
                        let is_auto_cmd = has_enter && self.stdin_line_buffer.trim() == "/auto";
                        if has_enter {
                            self.stdin_line_buffer.clear();
                        }

                        if is_auto_cmd {
                            self.toggle_auto_yes().await;
                            // Send Ctrl+U to clear the typed /auto from the shell line
                            let mut w = writer.lock().map_err(|e| anyhow::anyhow!("Lock: {}", e))?;
                            w.write_all(b"\x15")?;
                            w.flush()?;
                            continue;
                        }

                        // Forward to PTY if ready
                        if self.stdin_ready.is_ready().await || !self.auto_yes_enabled {
                            {
                                let mut w = writer.lock().map_err(|e| anyhow::anyhow!("Lock: {}", e))?;
                                w.write_all(&data)?;
                                w.flush()?;
                            }
                            self.idle_waiter.ping();
                            self.mark_stdin_sent();
                        }
                    }
                }

                // Check for process exit and PTY output (poll frequently)
                _ = sleep_ms(10) => {
                    // Try to read output from channel (non-blocking)
                    while let Some(output) = pty.try_recv() {
                        self.handle_output(&output, &mut msg_ctx, &stdout_tx).await?;
                    }

                    // Check if process has exited
                    if let Ok(Some(status)) = pty.try_wait() {
                        let code = status.exit_code() as i32;
                        if self.is_user_abort {
                            exit_code = 130;
                        } else {
                            exit_code = code;
                        }
                        break;
                    }

                    // Liveness check runs here — after the PTY drain above (so a
                    // just-arrived byte clears the stall) and after the exit
                    // check (so a clean exit never flashes "unresponsive").
                    self.check_responsiveness();

                    // Check for idle timeout
                    if let Some(timeout) = timeout_ms {
                        let idle = self.idle_waiter.idle_time_ms();
                        // Log idle time every 2 seconds for debugging
                        if self.start_time.elapsed().as_secs() % 2 == 0 {
                            debug!("Idle time: {}ms / {}ms timeout", idle, timeout);
                        }
                        if idle > timeout {
                            // Check if still working
                            let screen = self.vterm.contents();
                            let is_working = self.cli_config.working.iter()
                                .any(|p| p.is_match(&screen));

                            debug!("Idle check: idle={}ms, timeout={}ms, is_working={}", idle, timeout, is_working);

                            if !is_working {
                                if let Some(action) = idle_action {
                                    info!("Idle timeout reached, performing idle action: {}", action);
                                    send_text(&msg_ctx, action).await?;
                                    send_text(&msg_ctx, "\n").await?;
                                    self.idle_waiter.ping();
                                    self.mark_stdin_sent();
                                } else {
                                    info!("Idle timeout reached ({}ms > {}ms), exiting", idle, timeout);
                                    for cmd in &self.cli_config.exit_command {
                                        send_text(&msg_ctx, cmd).await?;
                                        send_text(&msg_ctx, "\n").await?;
                                    }
                                    exit_code = 0;
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        }

        // Restore terminal mode
        let _ = terminal::disable_raw_mode();

        // Cancel stdin reader and stdout writer
        stdin_handle.abort();
        // FIFO reader thread will exit on its own when the channel closes
        // (we already dropped our extra sender clone). Just join briefly.
        if let Some(h) = fifo_handle {
            // Detach — we can't easily unblock a thread mid-blocking-read, but
            // the kernel cleans up when the process exits. The thread's
            // sender will fail the next send and the loop will exit.
            let _ = h;
        }
        // Drop sender to signal stdout writer to finish, then wait briefly
        drop(stdout_tx);
        let _ = tokio::time::timeout(Duration::from_millis(500), stdout_handle).await;

        // Plain (non-TTY) mode: nothing was forwarded during the run, so emit
        // the final rendered screen now as clean plain text. Writing here
        // (after the raw stdout writer has drained) keeps it from interleaving
        // with anything else.
        if self.render_plain {
            let rendered = self.non_tty_renderer.finalize(&self.vterm);
            if !rendered.is_empty() {
                use std::io::Write as _;
                let mut out = std::io::stdout();
                let _ = out.write_all(rendered.as_bytes());
                let _ = out.flush();
            }
        }

        // Print final newline
        if self.is_user_abort {
            eprintln!("\r\nUser aborted: SIGINT\r");
        }

        Ok(exit_code)
    }

    /// Handle PTY output
    async fn handle_output(
        &mut self,
        output: &str,
        msg_ctx: &mut MessageContext,
        stdout_tx: &mpsc::Sender<String>,
    ) -> Result<()> {
        // Liveness: any PTY byte (even pure ANSI/cursor) proves the agent is
        // alive, so stamp the output time first. This is drain time, not arrival
        // time — output queued just before a stdin poke gets stamped as "after"
        // it on the next drain, masking that poke. That, and equal-Instant ties
        // in is_stalled, both bias toward "alive" (under-detect rather than cry
        // wolf), which is the intended conservative behaviour. See
        // check_responsiveness.
        self.last_output_at = Instant::now();

        // Forward raw PTY bytes to stdout only in TTY passthrough mode. In
        // plain (non-TTY) mode we suppress the raw stream and emit rendered
        // text on exit instead — see `non_tty_renderer` and the final flush
        // at the end of `run_with_fifo`.
        //
        // Send to background stdout writer (never blocks main loop).
        // If the channel is full (~10MB buffered), drop the output —
        // agent operation is more important than display completeness.
        if !self.render_plain {
            match stdout_tx.try_send(output.to_string()) {
                Ok(_) => {}
                Err(mpsc::error::TrySendError::Full(_)) => {
                    self.stdout_drop_count += 1;
                    // Warn on first drop, then every 100 drops to avoid log spam
                    if self.stdout_drop_count == 1 || self.stdout_drop_count % 100 == 0 {
                        warn!(
                            "stdout channel full, dropped output ({} total drops)",
                            self.stdout_drop_count
                        );
                    }
                }
                Err(mpsc::error::TrySendError::Closed(_)) => {
                    // Channel closed, receiver gone — nothing to do
                }
            }
        }

        // Write to raw log file
        self.log_writer.write(output);

        // Update buffers
        self.output_buffer.push_str(output);

        // Feed raw output to virtual terminal emulator for accurate screen state
        self.vterm.process(output.as_bytes());
        // Latch alt-screen usage so finalize_log knows whether the rendered
        // scrollback can safely stand in for the raw byte log.
        self.used_alt_screen |= self.vterm.alternate_screen();

        // In plain (non-TTY) mode, let the renderer observe the screen so it
        // can capture alt-screen contents before the agent restores the
        // normal screen on exit.
        if self.render_plain {
            self.non_tty_renderer.observe(&self.vterm);
        }

        // Write back any terminal query responses (DSR, DA) to child process.
        // Lock once and batch all responses to keep them atomic w.r.t. other writers.
        let responses = self.vterm.take_responses();
        if !responses.is_empty() {
            let mut w = msg_ctx
                .writer
                .lock()
                .map_err(|e| anyhow::anyhow!("Lock: {}", e))?;
            for response in responses {
                w.write_all(&response)?;
            }
            w.flush()?;
        }

        // Extract and store codex session ID (once per session)
        if self.cli == "codex" && !self.codex_session_found {
            if let Some(session_id) = codex_sessions::extract_session_id(output) {
                codex_sessions::store_session(&self.cwd, &session_id);
                self.codex_session_found = true;
                debug!("Stored codex session ID: {}", session_id);
            }
        }

        // Keep raw output buffer size reasonable
        if self.output_buffer.len() > 100000 {
            debug!(
                "Output buffer truncated (was {} bytes)",
                self.output_buffer.len()
            );
            let split_at = find_char_boundary(&self.output_buffer, 50000);
            self.output_buffer = self.output_buffer.split_off(split_at);
        }

        // Mark stdout received
        self.next_stdout.ready().await;

        // Only ping activity if there's visible content (not just ANSI codes)
        // This prevents cursor control sequences from resetting the idle timer
        let stripped = strip_ansi_escapes::strip_str(output);
        if !stripped.trim().is_empty() {
            self.idle_waiter.ping();
            // Output resumed → a panic-Esc unstuck the stream. Disarm so the next
            // gesture starts fresh at Esc rather than jumping to force-restart.
            self.panic_esc_sent_at = None;
        }

        // Check patterns
        self.check_patterns(msg_ctx).await?;

        Ok(())
    }

    /// Heartbeat pattern check (for cursor-based rendering)
    /// No-output watchdog: recover a silently-stalled API stream.
    ///
    /// A live CLI keeps repainting its spinner timer (visible output, so
    /// `idle_waiter` pings ~every second) while it works. If a `working` spinner
    /// is on screen yet no visible output has arrived for `stall_timeout_secs`,
    /// the stream `await` never resolved — the classic silent stall that prints
    /// no error, so the printed-error auto-retry never fires. Recovery escalates:
    ///   1. send Esc to cancel the in-flight request (armed once per stall);
    ///   2. if output still hasn't resumed `STALL_ESC_GRACE_SECS` later, raise
    ///      `stall_force_restart` so the run exits non-zero and a `--robust`
    ///      parent restarts the CLI with its `--continue` restore args.
    /// Clears its arming the instant real output resumes (idle drops below the
    /// threshold) or the spinner leaves the screen.
    async fn stall_watchdog_check(&mut self, msg_ctx: &mut MessageContext) -> Result<()> {
        let timeout = self.cli_config.stall_timeout_secs;
        let screen = self.vterm.contents();
        let working = self.cli_config.working.iter().any(|p| p.is_match(&screen));
        let idle_secs = self.idle_waiter.idle_time_ms() / 1000;
        let esc_elapsed = self.stall_esc_sent_at.map(|t| t.elapsed().as_secs());
        let action = decide_stall_action(
            timeout,
            working,
            idle_secs,
            esc_elapsed,
            STALL_ESC_GRACE_SECS,
        );
        // Any non-Clear action means the "working" spinner is frozen → feed the
        // unified stuck flag. The stuck/recovered webhook is now emitted centrally
        // by update_unresponsive() (this used to fire its own "STUCK" notify); the
        // match below is purely the recovery escalation (Esc → force-restart).
        self.watchdog_stalled = action != StallAction::Clear;
        match action {
            StallAction::Clear => {
                // Healthy, idle-at-prompt, or recovered after an Esc: disarm.
                self.stall_esc_sent_at = None;
            }
            StallAction::SendEsc => {
                warn!(
                    "No-output watchdog: spinner up with no visible output for {}s (>= {}s) — \
                     stream looks stalled, sending Esc to cancel",
                    idle_secs, timeout
                );
                // Esc cancels claude's in-flight request; harmless to other CLIs.
                // Use send_esc (NOT send_text) so we don't ping the idle timer —
                // the watchdog needs idle to keep growing to escalate if Esc
                // fails to recover the stream.
                send_esc(&msg_ctx.writer)?;
                self.stall_esc_sent_at = Some(Instant::now());
            }
            StallAction::Wait => {}
            StallAction::ForceRestart => {
                warn!(
                    "No-output watchdog: Esc did not recover the stream after {}s — forcing \
                     restart (a --robust run resumes with --continue)",
                    STALL_ESC_GRACE_SECS
                );
                self.stall_force_restart = true;
            }
        }
        self.update_unresponsive();
        Ok(())
    }

    async fn heartbeat_check(&mut self, msg_ctx: &mut MessageContext) -> Result<()> {
        // Terminal query responses (DSR, DA) are now handled automatically
        // by VTermProxy in handle_output() via vt100 callbacks.

        // No-output watchdog: catch a silently-stalled stream the printed-error
        // auto-retry below can never see (a stall prints nothing).
        self.stall_watchdog_check(msg_ctx).await?;

        // Drive the auto-retry backoff timer. Runs every heartbeat (independent of
        // screen changes) so the delayed "retry" still fires while the agent sits
        // idle on an error banner producing no new output. Arming/reset happens in
        // check_patterns(); here we only fire the scheduled send.
        if let Some(next_at) = self.auto_retry_next_at {
            let now = Instant::now();
            // Give up after the outage window (usage limit resets ~5h; allow 8h).
            if self
                .auto_retry_started_at
                .is_some_and(|s| s.elapsed().as_secs() >= RETRY_GIVE_UP_SECS)
            {
                warn!(
                    "Auto-retry: giving up after {}h with no recovery",
                    RETRY_GIVE_UP_SECS / 3600
                );
                self.auto_retry_next_at = None;
                self.auto_retry_started_at = None;
                self.auto_retry_streak = 0;
            } else if now >= next_at {
                // Re-render the screen to confirm the agent is idle at a prompt —
                // never type "retry" while it's busy (e.g. the CLI's own retry) —
                // and require a few quiet seconds on top of the backoff delay, so
                // a scheduled retry doesn't collide with a line the user is
                // actively typing (see RETRY_MIN_IDLE_MS).
                let screen = self.vterm.contents();
                let working = self.cli_config.working.iter().any(|p| p.is_match(&screen));
                let ready = self.cli_config.ready.iter().any(|p| p.is_match(&screen));
                let idle_ms = self.idle_waiter.idle_time_ms();
                if !should_fire_retry(working, ready, idle_ms, RETRY_MIN_IDLE_MS) {
                    self.auto_retry_next_at = Some(now + Duration::from_millis(500));
                } else {
                    self.auto_retry_streak = self.auto_retry_streak.saturating_add(1);
                    warn!(
                        "Auto-retry: typing 'retry' (attempt {})",
                        self.auto_retry_streak
                    );
                    self.do_send_retry(msg_ctx)?;
                    // Self-schedule the next retry with escalated backoff. Leaving
                    // this None and re-arming from check_patterns would tight-loop
                    // while the error banner stays on screen. check_patterns resets
                    // the streak (cancelling this) once the agent recovers.
                    let next = retry_backoff_secs(self.auto_retry_streak);
                    self.auto_retry_next_at = Some(now + Duration::from_secs(next));
                }
            }
        }

        // Check patterns on heartbeat (for no-EOL CLIs)
        if self.cli_config.no_eol {
            self.check_patterns(msg_ctx).await?;
        }

        // Idle screen scanner: re-check enter patterns after prolonged idle
        // This catches prompts that appeared but were missed (e.g. after buffer clear)
        if self.auto_yes_enabled && !self.pending_enter {
            let idle_ms = self.idle_waiter.idle_time_ms();
            if idle_ms >= IDLE_SCAN_INTERVAL_MS {
                let should_scan = match self.last_idle_scan_at {
                    Some(last) => last.elapsed().as_millis() as u64 >= IDLE_SCAN_INTERVAL_MS,
                    None => true,
                };
                if should_scan {
                    self.last_idle_scan_at = Some(Instant::now());
                    let buffer = self.vterm.contents();
                    let buffer_hash = hash_str(&buffer);
                    // Skip if screen still equals the last handled action.
                    // If it diverges, clear the suppression so identical
                    // prompts can be re-handled after intervening output.
                    if self.last_action_screen_hash != Some(buffer_hash) {
                        self.last_action_screen_hash = None;
                        for pattern in &self.cli_config.enter {
                            if pattern.is_match(&buffer) {
                                debug!("Idle scan: enter pattern matched after {}ms idle", idle_ms);
                                self.pending_enter = true;
                                self.pending_enter_detected_at = Some(Instant::now());
                                self.enter_sent_at = None;
                                self.enter_retry_count = 0;
                                self.last_action_screen_hash = Some(buffer_hash);
                                break;
                            }
                        }
                    }
                }
            }
        }

        // Handle pending Enter with idle wait and retry logic
        if self.pending_enter {
            let idle_time = self.idle_waiter.idle_time_ms();
            let now = Instant::now();
            debug!(
                "Pending enter: idle_time={}ms, enter_sent={}",
                idle_time,
                self.enter_sent_at.is_some()
            );

            // Check if we should send Enter (first time - wait for idle)
            if self.enter_sent_at.is_none() {
                if idle_time >= ENTER_IDLE_WAIT_MS {
                    debug!("Sending Enter after {}ms idle", idle_time);
                    self.do_send_enter(msg_ctx)?;
                    self.enter_sent_at = Some(now);
                    self.next_stdout.unready().await;
                }
            } else if let Some(sent_at) = self.enter_sent_at {
                // Check if we received output after sending Enter
                if self.next_stdout.is_ready().await {
                    // Got response, clear pending state
                    debug!("Got response after Enter, clearing pending state");
                    self.pending_enter = false;
                    self.pending_enter_detected_at = None;
                    self.enter_sent_at = None;
                    self.enter_retry_count = 0;
                } else {
                    // No response yet, check for retry
                    let elapsed_since_send = now.duration_since(sent_at).as_millis() as u64;

                    if self.enter_retry_count == 0 && elapsed_since_send >= ENTER_RETRY_1_MS {
                        debug!(
                            "Retry 1: Sending Enter again after {}ms",
                            elapsed_since_send
                        );
                        self.do_send_enter(msg_ctx)?;
                        self.enter_retry_count = 1;
                        self.enter_sent_at = Some(now);
                    } else if self.enter_retry_count == 1 && elapsed_since_send >= ENTER_RETRY_2_MS
                    {
                        debug!(
                            "Retry 2: Sending Enter again after {}ms",
                            elapsed_since_send
                        );
                        self.do_send_enter(msg_ctx)?;
                        self.enter_retry_count = 2;
                        // After second retry, just keep waiting
                        self.pending_enter = false;
                        self.pending_enter_detected_at = None;
                        self.enter_sent_at = None;
                        self.enter_retry_count = 0;
                    }
                }
            }
        }

        Ok(())
    }

    /// Actually send the Enter key
    fn do_send_enter(&mut self, msg_ctx: &MessageContext) -> Result<()> {
        {
            let mut writer = msg_ctx
                .writer
                .lock()
                .map_err(|e| anyhow::anyhow!("Lock: {}", e))?;
            writer.write_all(b"\r")?;
            writer.flush()?;
        }
        self.idle_waiter.ping();
        self.mark_stdin_sent();
        Ok(())
    }

    /// Type "retry" + Enter — the auto-retry response to a recoverable API error.
    fn do_send_retry(&mut self, msg_ctx: &MessageContext) -> Result<()> {
        {
            let mut writer = msg_ctx
                .writer
                .lock()
                .map_err(|e| anyhow::anyhow!("Lock: {}", e))?;
            writer.write_all(b"retry")?;
            writer.write_all(b"\r")?;
            writer.flush()?;
        }
        self.idle_waiter.ping();
        self.mark_stdin_sent();
        Ok(())
    }

    /// Stamp the last-stdin time — marks a "poke" whose response (any PTY
    /// output) the liveness check waits for. Reset by output advancing
    /// `last_output_at` past this instant. See check_responsiveness.
    fn mark_stdin_sent(&mut self) {
        self.last_stdin_at = Some(Instant::now());
    }

    /// Poke-based liveness detector: the agent looks stuck when we sent a poke
    /// (`last_stdin_at`) that no PTY output has answered
    /// (`last_output_at < last_stdin_at`) for at least the configured window.
    /// Updates this detector's sub-state and republishes the unified flag. No-op
    /// when the timeout is 0 (this detector disabled for the CLI) — the other
    /// detector can still publish.
    fn check_responsiveness(&mut self) {
        let timeout_ms = self.cli_config.unresponsive_timeout_ms;
        if timeout_ms == 0 {
            return;
        }
        self.poke_unresponsive = is_stalled(
            self.last_stdin_at,
            self.last_output_at,
            Instant::now(),
            Duration::from_millis(timeout_ms),
        );
        self.update_unresponsive();
    }

    /// Publish the unified `unresponsive` liveness flag — the agent is stuck when
    /// EITHER detector trips: the post-stdin responsiveness check
    /// (`poke_unresponsive`) or the no-output stall watchdog (`watchdog_stalled`,
    /// the same frozen-spinner condition that drives Esc/force-restart recovery).
    /// Edge-triggered: writes the pid_store flag + fires the webhook only on a
    /// true change, so a stuck agent notifies once and recovery notifies once,
    /// regardless of which detector caused the transition.
    fn update_unresponsive(&mut self) {
        let stuck = is_stuck(self.poke_unresponsive, self.watchdog_stalled);
        if stuck == self.unresponsive {
            return;
        }
        self.unresponsive = stuck;
        crate::pid_store::PidStore::new().set_unresponsive(self.pid, stuck);
        if stuck {
            warn!("Agent unresponsive: no PTY output while expecting it");
            crate::webhook::notify("UNRESPONSIVE", "no output — agent looks stuck", &self.cwd);
        } else {
            info!("Agent responsive again after a stall");
            crate::webhook::notify("RUNNING", "responsive again", &self.cwd);
        }
    }

    async fn toggle_auto_yes(&mut self) {
        self.auto_yes_enabled = !self.auto_yes_enabled;
        if self.auto_yes_enabled {
            eprintln!("\r\n[auto-yes: ON]\r");
        } else {
            eprintln!("\r\n[auto-yes: OFF]\r");
            self.stdin_ready.ready().await;
        }
    }

    /// Check patterns and respond accordingly
    async fn check_patterns(&mut self, msg_ctx: &mut MessageContext) -> Result<()> {
        // Use vterm rendered screen for pattern matching (correctly handles cursor movement, clearing, etc.)
        let buffer = self.vterm.contents();

        // Short-circuit if screen contents are byte-identical to the last
        // check. Sticky state (is_fatal, ready, pending_enter) cannot transition
        // without a screen change, and one-shot patterns are already suppressed
        // via last_action_screen_hash, so re-running all regexes is pure waste.
        let buffer_hash = hash_str(&buffer);
        if self.last_checked_screen_hash == Some(buffer_hash) {
            return Ok(());
        }
        self.last_checked_screen_hash = Some(buffer_hash);

        // Auto-retry on recoverable API errors (overload / rate-limit / usage-
        // limit). Evaluated BEFORE fatal so these don't kill the session. We only
        // arm/reset the backoff state here; the actual (back-off-timed) "retry"
        // send happens in heartbeat_check() once the agent is idle at its prompt.
        if !self.cli_config.auto_retry.is_empty() {
            let err = self
                .cli_config
                .auto_retry
                .iter()
                .any(|p| p.is_match(&buffer));
            let ready_now = self.cli_config.ready.iter().any(|p| p.is_match(&buffer));
            if err && ready_now {
                // Error banner is up AND the agent is back at its prompt: schedule
                // the next retry unless one is already counting down.
                if self.auto_retry_next_at.is_none() {
                    if self.auto_retry_started_at.is_none() {
                        self.auto_retry_started_at = Some(Instant::now());
                    }
                    let delay = retry_backoff_secs(self.auto_retry_streak);
                    self.auto_retry_next_at = Some(Instant::now() + Duration::from_secs(delay));
                    warn!(
                        "Auto-retry armed: recoverable error detected, retrying in {}s (attempt {})",
                        delay,
                        self.auto_retry_streak + 1
                    );
                }
            } else if ready_now && !err && self.auto_retry_started_at.is_some() {
                // Back at a clean prompt with no error → recovered (whether from our
                // retry or the CLI's own). Reset the backoff ladder and cancel any
                // pending retry.
                debug!("Auto-retry: recovered, resetting backoff ladder");
                self.auto_retry_streak = 0;
                self.auto_retry_started_at = None;
                self.auto_retry_next_at = None;
            }
        }

        // Check fatal patterns first (only if not already matched)
        if !self.is_fatal {
            for pattern in &self.cli_config.fatal {
                if pattern.is_match(&buffer) {
                    error!("Fatal pattern matched: {}", pattern);
                    self.is_fatal = true;
                    return Ok(());
                }
            }
        }

        // Check restart-without-continue patterns (only if not already matched)
        if !self.should_restart_without_continue {
            for pattern in &self.cli_config.restart_without_continue {
                if pattern.is_match(&buffer) {
                    warn!("Restart without continue pattern matched");
                    self.should_restart_without_continue = true;
                    break;
                }
            }
        }

        // Check ready patterns
        for pattern in &self.cli_config.ready {
            if pattern.is_match(&buffer) {
                if !self.stdin_ready.is_ready().await {
                    debug!("Ready pattern matched");
                    self.stdin_ready.ready().await;
                    self.stdin_first_ready.ready().await;
                }
                break;
            }
        }

        // If auto-yes is disabled, don't auto-respond
        if !self.auto_yes_enabled {
            return Ok(());
        }

        // One-shot pattern suppression: if the screen hasn't changed since
        // the last typing_respond/enter match, skip those checks. Without
        // this, vterm.contents() persists matched prompts and would
        // re-trigger every time check_patterns() runs.
        if self.last_action_screen_hash == Some(buffer_hash) {
            return Ok(());
        }
        // Screen has diverged from the last handled action — clear the
        // suppression so that if an identical prompt later reappears (after
        // any intervening output), one-shot patterns can fire again.
        self.last_action_screen_hash = None;

        // Check typing response patterns
        for (response, patterns) in &self.cli_config.typing_respond {
            for pattern in patterns {
                if pattern.is_match(&buffer) {
                    debug!("Typing response pattern matched, sending: {:?}", response);
                    send_text(msg_ctx, response).await?;
                    self.mark_stdin_sent();
                    self.output_buffer.clear();
                    self.last_action_screen_hash = Some(buffer_hash);
                    return Ok(());
                }
            }
        }

        // Check enter patterns
        let enter_excluded = self
            .cli_config
            .enter_exclude
            .iter()
            .any(|pattern| pattern.is_match(&buffer));
        for pattern in &self.cli_config.enter {
            if pattern.is_match(&buffer) {
                if enter_excluded {
                    debug!("Enter pattern matched but excluded");
                    return Ok(());
                }
                if !self.pending_enter {
                    debug!("Enter pattern matched, scheduling Enter after idle");
                    self.pending_enter = true;
                    self.pending_enter_detected_at = Some(Instant::now());
                    self.enter_sent_at = None;
                    self.enter_retry_count = 0;
                    self.output_buffer.clear();
                    self.last_action_screen_hash = Some(buffer_hash);
                }
                return Ok(());
            }
        }

        Ok(())
    }
}

/// Pure liveness decision: the agent is stalled when we sent a poke
/// (`last_stdin_at`) that no PTY output has answered (`last_output_at` predates
/// the poke) for at least `timeout`. Extracted from `check_responsiveness` so
/// the time arithmetic can be unit-tested without a real PTY.
fn is_stalled(
    last_stdin_at: Option<Instant>,
    last_output_at: Instant,
    now: Instant,
    timeout: Duration,
) -> bool {
    match last_stdin_at {
        Some(sent) => last_output_at < sent && now.saturating_duration_since(sent) >= timeout,
        None => false,
    }
}

/// The unified "stuck" liveness state: the agent is unresponsive when EITHER
/// detector trips — the post-stdin responsiveness check (`poke_unresponsive`) or
/// the no-output stall watchdog's frozen spinner (`watchdog_stalled`). A free fn
/// so the combine rule is unit-testable; see update_unresponsive.
fn is_stuck(poke_unresponsive: bool, watchdog_stalled: bool) -> bool {
    poke_unresponsive || watchdog_stalled
}

/// Hash a string with the default hasher — used to detect screen state changes.
fn hash_str(s: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut hasher);
    hasher.finish()
}

/// Find the nearest char boundary at or after `at`, so split_off won't panic on multi-byte UTF-8.
fn find_char_boundary(s: &str, at: usize) -> usize {
    if at >= s.len() {
        return s.len();
    }
    let mut pos = at;
    while !s.is_char_boundary(pos) {
        pos += 1;
    }
    pos
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_retry_backoff_secs_doubles_then_caps() {
        // 8, 16, 32, 64, 128, 256 …
        assert_eq!(retry_backoff_secs(0), 8);
        assert_eq!(retry_backoff_secs(1), 16);
        assert_eq!(retry_backoff_secs(2), 32);
        assert_eq!(retry_backoff_secs(3), 64);
        assert_eq!(retry_backoff_secs(4), 128);
        assert_eq!(retry_backoff_secs(5), 256);
        // capped at RETRY_MAX_DELAY_SECS, and no shift overflow for large streaks
        assert_eq!(retry_backoff_secs(6), 256);
        assert_eq!(retry_backoff_secs(50), 256);
    }

    #[test]
    fn test_should_fire_retry_requires_ready_not_working_and_quiet() {
        // Busy — never fire even if otherwise ready and quiet.
        assert!(!should_fire_retry(true, true, 10_000, 5_000));
        // Not at a recognized ready prompt — don't fire.
        assert!(!should_fire_retry(false, false, 10_000, 5_000));
        // Ready and idle, but the quiet window hasn't elapsed yet (user may
        // still be mid-typing) — defer.
        assert!(!should_fire_retry(false, true, 4_999, 5_000));
        // Ready, idle, and past the quiet window — fire.
        assert!(should_fire_retry(false, true, 5_000, 5_000));
        assert!(should_fire_retry(false, true, 10_000, 5_000));
    }

    #[test]
    fn test_stall_disabled_when_timeout_zero() {
        // timeout 0 always clears, even if it otherwise looks stalled.
        assert_eq!(
            decide_stall_action(0, true, 9999, None, 30),
            StallAction::Clear
        );
    }

    #[test]
    fn test_stall_not_working_clears() {
        // No spinner on screen → never a stall, regardless of idle time.
        assert_eq!(
            decide_stall_action(300, false, 9999, None, 30),
            StallAction::Clear
        );
    }

    #[test]
    fn test_panic_below_threshold_is_none() {
        // 4 presses in the window → gesture incomplete, forward as normal.
        assert_eq!(decide_panic_action(4, 5, false), PanicAction::None);
    }

    #[test]
    fn test_panic_at_threshold_sends_esc() {
        // 5th press completes the gesture, no Esc yet → Esc-cancel.
        assert_eq!(decide_panic_action(5, 5, false), PanicAction::Esc);
    }

    #[test]
    fn test_panic_repeat_while_esc_in_flight_force_kills() {
        // Gesture repeats while a prior Esc hasn't recovered → force restart.
        assert_eq!(decide_panic_action(5, 5, true), PanicAction::ForceKill);
    }

    #[test]
    fn test_panic_below_threshold_ignores_esc_state() {
        // An armed Esc doesn't lower the bar: still need a full gesture.
        assert_eq!(decide_panic_action(4, 5, true), PanicAction::None);
    }

    #[test]
    fn test_stall_working_but_recent_output_clears() {
        // Spinner up but output flowed within the window → healthy.
        assert_eq!(
            decide_stall_action(300, true, 299, None, 30),
            StallAction::Clear
        );
    }

    #[test]
    fn test_stall_trips_to_esc_at_threshold() {
        // Spinner up, no output for >= timeout, Esc not yet sent → send Esc.
        assert_eq!(
            decide_stall_action(300, true, 300, None, 30),
            StallAction::SendEsc
        );
    }

    #[test]
    fn test_stall_waits_during_esc_grace() {
        // Esc sent 10s ago, grace 30s → keep waiting for recovery.
        assert_eq!(
            decide_stall_action(300, true, 360, Some(10), 30),
            StallAction::Wait
        );
    }

    #[test]
    fn test_stall_escalates_after_grace() {
        // Esc sent, grace elapsed, still stalled → force restart.
        assert_eq!(
            decide_stall_action(300, true, 400, Some(30), 30),
            StallAction::ForceRestart
        );
    }

    #[test]
    fn test_stall_recovers_after_esc_clears_arming() {
        // Esc worked: output resumed (idle dropped below timeout) → Clear, which
        // disarms stall_esc_sent_at so a later stall re-sends Esc fresh.
        assert_eq!(
            decide_stall_action(300, true, 5, Some(10), 30),
            StallAction::Clear
        );
    }

    #[test]
    fn test_is_stalled_no_poke() {
        // Never sent stdin → never stalled, regardless of output age.
        let now = Instant::now();
        let old = now.checked_sub(Duration::from_secs(60)).unwrap();
        assert!(!is_stalled(None, old, now, Duration::from_secs(3)));
    }

    #[test]
    fn test_is_stalled_poke_then_output() {
        // Output arrived AFTER the poke → responsive (twitched back).
        let now = Instant::now();
        let sent = now.checked_sub(Duration::from_secs(10)).unwrap();
        let output_after = now.checked_sub(Duration::from_secs(5)).unwrap();
        assert!(!is_stalled(
            Some(sent),
            output_after,
            now,
            Duration::from_secs(3)
        ));
    }

    #[test]
    fn test_is_stalled_poke_then_silence() {
        // Poked 10s ago, last output predates the poke, timeout 3s → stalled.
        let now = Instant::now();
        let sent = now.checked_sub(Duration::from_secs(10)).unwrap();
        let output_before = now.checked_sub(Duration::from_secs(12)).unwrap();
        assert!(is_stalled(
            Some(sent),
            output_before,
            now,
            Duration::from_secs(3)
        ));
    }

    #[test]
    fn test_is_stalled_within_window() {
        // Poked 1s ago with no output yet, but 3s window hasn't elapsed → not yet.
        let now = Instant::now();
        let sent = now.checked_sub(Duration::from_secs(1)).unwrap();
        let output_before = now.checked_sub(Duration::from_secs(2)).unwrap();
        assert!(!is_stalled(
            Some(sent),
            output_before,
            now,
            Duration::from_secs(3)
        ));
    }

    #[test]
    fn test_unified_stuck_is_or_of_detectors() {
        // update_unresponsive publishes is_stuck(poke, watchdog): either detector
        // alone trips the unified flag; only when neither holds is it clear.
        assert!(!is_stuck(false, false));
        assert!(is_stuck(true, false)); // poke-based responsiveness check tripped
        assert!(is_stuck(false, true)); // no-output stall watchdog tripped
        assert!(is_stuck(true, true));
    }

    #[test]
    fn test_watchdog_stalled_maps_every_non_clear_action() {
        // stall_watchdog_check feeds the unified flag via
        // `watchdog_stalled = action != StallAction::Clear`: a frozen spinner reads
        // as stuck whether we're about to Esc, waiting out the grace, or forcing a
        // restart; only Clear (healthy / recovered / idle-at-prompt) is not stuck.
        let grace = 30;
        // Clear cases → not stuck.
        assert_eq!(
            decide_stall_action(300, false, 999, None, grace),
            StallAction::Clear
        );
        assert_eq!(
            decide_stall_action(300, true, 5, Some(10), grace),
            StallAction::Clear
        );
        // Every recovery state → stuck (non-Clear).
        for action in [
            decide_stall_action(300, true, 300, None, grace), // SendEsc
            decide_stall_action(300, true, 360, Some(10), grace), // Wait
            decide_stall_action(300, true, 400, Some(30), grace), // ForceRestart
        ] {
            assert_ne!(action, StallAction::Clear);
            assert!(is_stuck(false, action != StallAction::Clear));
        }
    }

    #[test]
    fn test_find_char_boundary_ascii() {
        let s = "hello world";
        assert_eq!(find_char_boundary(s, 5), 5);
    }

    #[test]
    fn test_find_char_boundary_multibyte_exact() {
        // 门 is 3 bytes in UTF-8: E9 97 A8
        let s = "门";
        assert_eq!(find_char_boundary(s, 0), 0); // start of char
        assert_eq!(find_char_boundary(s, 3), 3); // end of char = len
    }

    #[test]
    fn test_find_char_boundary_multibyte_mid() {
        // "a门b" = [61, E9, 97, A8, 62]
        let s = "a门b";
        assert_eq!(find_char_boundary(s, 1), 1); // start of 门
        assert_eq!(find_char_boundary(s, 2), 4); // mid 门 -> skip to b
        assert_eq!(find_char_boundary(s, 3), 4); // mid 门 -> skip to b
        assert_eq!(find_char_boundary(s, 4), 4); // start of b
    }

    #[test]
    fn test_find_char_boundary_beyond_len() {
        let s = "hello";
        assert_eq!(find_char_boundary(s, 100), 5);
    }

    #[test]
    fn test_find_char_boundary_emoji() {
        // 🦀 is 4 bytes in UTF-8
        let s = "a🦀b";
        assert_eq!(find_char_boundary(s, 1), 1); // start of 🦀
        assert_eq!(find_char_boundary(s, 2), 5); // mid 🦀 -> skip to b
        assert_eq!(find_char_boundary(s, 3), 5);
        assert_eq!(find_char_boundary(s, 4), 5);
        assert_eq!(find_char_boundary(s, 5), 5); // start of b
    }

    #[test]
    fn test_split_off_with_find_char_boundary() {
        // Simulate the buffer truncation with Chinese characters
        let mut buf = String::new();
        for _ in 0..20000 {
            buf.push('门'); // 3 bytes each = 60000 bytes
        }
        let split_at = find_char_boundary(&buf, 50000);
        // Should not panic
        let tail = buf.split_off(split_at);
        assert!(!tail.is_empty());
        // split_at should be on a char boundary (multiple of 3 for 门)
        assert_eq!(split_at % 3, 0);
    }
}
