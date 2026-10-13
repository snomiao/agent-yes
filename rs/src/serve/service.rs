// Native OS-level service install for `ayrs serve`.
//
// Prefers the platform's own supervisor so the *ayrs* daemon tree stays pure
// Rust (no Node/Bun), the whole point of the Rust daemon:
//
//   macOS   -> launchd user agent  ~/Library/LaunchAgents/<LABEL>.plist
//   Linux   -> systemd user unit   ~/.config/systemd/user/<LABEL>.service
//   Windows -> Task Scheduler task <LABEL>, defined by ~/.agent-yes/<LABEL>.xml
//
// Fallback: on Linux WITHOUT a usable systemd `--user` bus (e.g. a container),
// register with oxmgr instead of failing (see the oxmgr block below). oxmgr is a
// separate supervisor process — the ayrs process it runs is still pure Rust — so
// the "no Node/Bun in ayrs" invariant holds. This mirrors how the TS `ay serve`
// is managed on such hosts.
//
// The systemd/launchd label is distinct from the oxmgr name the TS daemon
// registers (`agent-yes`), so both can be installed at once during migration.
//
// Windows shape, and why it isn't an `sc.exe` service: a real Windows service
// needs admin rights, runs in session 0, and must answer the SCM control
// dispatcher — none of which fits a per-user daemon that spawns agents in the
// user's own session. A Task Scheduler logon task is the user-level equivalent
// of a launchd agent / `systemd --user` unit. Two Windows-only wrinkles:
//
//   * Task Scheduler gives a console program a visible console window, so the
//     task launches `ay-spawn-hidden` (GUI subsystem, spawns its child with
//     CREATE_NO_WINDOW under a kill-on-close job) when that sibling binary is
//     present — the same shim `ay serve install` interposes for oxmgr.
//   * Task Scheduler cannot redirect stdout/stderr the way launchd's
//     StandardOutPath does, so the action runs a generated `.cmd` shim that
//     does the `>>` redirect into the same log files the other platforms use.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;

pub const LABEL: &str = "com.snomiao.ayrs-serve";

fn home() -> Result<PathBuf> {
    dirs::home_dir().context("cannot resolve home directory")
}

/// Absolute path to the running `ayrs` binary — launchd/systemd get no PATH
/// worth relying on, so the unit must name the executable outright.
fn exe() -> Result<String> {
    let p = std::env::current_exe().context("cannot resolve current executable")?;
    // Resolve symlinks (~/.cargo/bin/ayrs is real, but a `bun link`-style
    // shim would otherwise bake in a path that moves).
    let p = std::fs::canonicalize(&p).unwrap_or(p);
    Ok(strip_verbatim(&p.to_string_lossy()))
}

/// Windows `canonicalize` returns a `\\?\C:\…` verbatim path. CreateProcess
/// accepts it, but `cmd.exe` and the Task Scheduler UI do not, so drop the
/// prefix before it gets baked into the generated files.
fn strip_verbatim(p: &str) -> String {
    p.strip_prefix(r"\\?\").unwrap_or(p).to_string()
}

fn log_dir() -> Result<PathBuf> {
    let dir = match std::env::var("AGENT_YES_HOME") {
        Ok(v) if !v.is_empty() => PathBuf::from(v),
        _ => home()?.join(".agent-yes"),
    };
    std::fs::create_dir_all(&dir).ok();
    Ok(dir)
}

/// Args the service should run, after the executable path.
pub fn service_args(webrtc: &Option<String>, sighost: &str) -> Vec<String> {
    let mut args = vec!["serve".to_string(), "--webrtc".to_string()];
    if let Some(v) = webrtc {
        if !v.is_empty() {
            args.push(v.clone());
        }
    }
    args.push("--sighost".to_string());
    args.push(sighost.to_string());
    args
}

// --- run receipt ----------------------------------------------------------
// The default installed daemon runs `ayrs serve --webrtc …` with NO local HTTP
// port, so `install` can't probe a `/api/version` endpoint the way the TS
// `ay serve install` does to decide "already running the latest version". So
// instead the running daemon drops a small receipt at startup recording its
// version + pid + the service args it was launched with. `install` reads it to
// answer the same question — same intent, file instead of HTTP.

/// What the currently-running ayrs daemon recorded about itself at startup.
#[derive(Serialize, Deserialize)]
struct RunReceipt {
    /// `CARGO_PKG_VERSION` of the binary that is actually running.
    version: String,
    /// The daemon's pid, so a stale receipt (daemon crashed/stopped) is ignored.
    pid: u32,
    /// The `service_args` the daemon was launched with, to compare config.
    args: Vec<String>,
}

fn receipt_path() -> Result<PathBuf> {
    Ok(log_dir()?.join(".ayrs-serve.receipt"))
}

/// Record what this process is running so a later `ayrs serve install` can skip
/// a redundant teardown+reinstall when we're already the current version+config.
/// Best-effort: a missing/unwritable receipt just means `install` won't no-op.
pub fn write_run_receipt(args: &[String]) {
    let receipt = RunReceipt {
        version: env!("CARGO_PKG_VERSION").to_string(),
        pid: std::process::id(),
        args: args.to_vec(),
    };
    if let (Ok(path), Ok(body)) = (receipt_path(), serde_json::to_string(&receipt)) {
        let _ = std::fs::write(path, body);
    }
}

fn read_run_receipt() -> Option<RunReceipt> {
    let txt = std::fs::read_to_string(receipt_path().ok()?).ok()?;
    serde_json::from_str(&txt).ok()
}

/// Pure decision: does `r` describe a live daemon on THIS binary's version with
/// THESE exact service args? Split out from [`already_current`] (which reads the
/// file) so the version/args/liveness logic is unit-testable without touching
/// the real receipt path. Mirrors the TS `runningVer === current && sameConfig`.
fn receipt_is_current(r: &RunReceipt, desired_args: &[String]) -> bool {
    r.version == env!("CARGO_PKG_VERSION")
        && r.args == desired_args
        && crate::pid_store::is_process_alive(r.pid)
}

/// True when a daemon is already running THIS binary's version with THESE exact
/// service args — the condition under which `install` is a no-op. Minus the TS
/// boot-autostart re-assert, which native launchd/systemd units already guarantee.
fn already_current(desired_args: &[String]) -> bool {
    read_run_receipt().is_some_and(|r| receipt_is_current(&r, desired_args))
}

#[cfg(target_os = "macos")]
fn unit_path() -> Result<PathBuf> {
    Ok(home()?
        .join("Library/LaunchAgents")
        .join(format!("{LABEL}.plist")))
}

#[cfg(target_os = "linux")]
fn unit_path() -> Result<PathBuf> {
    Ok(home()?
        .join(".config/systemd/user")
        .join(format!("{LABEL}.service")))
}

#[cfg(windows)]
fn unit_path() -> Result<PathBuf> {
    // Kept beside the logs rather than in a system location: the task XML is a
    // user-owned artifact, and `log_dir()` already honours AGENT_YES_HOME.
    Ok(log_dir()?.join(format!("{LABEL}.xml")))
}

/// The `.cmd` shim the task actually launches — it exists solely to give the
/// daemon the stdout/stderr redirect Task Scheduler can't do itself.
#[cfg(windows)]
fn script_path() -> Result<PathBuf> {
    Ok(log_dir()?.join(format!("{LABEL}.cmd")))
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn unit_path() -> Result<PathBuf> {
    bail!(
        "`ayrs serve` service management is only supported on macOS (launchd), \
         Linux (systemd --user) and Windows (Task Scheduler)"
    )
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[cfg(target_os = "macos")]
fn render_unit(exe: &str, args: &[String], out_log: &str, err_log: &str) -> String {
    let mut prog = String::new();
    for a in std::iter::once(&exe.to_string()).chain(args.iter()) {
        prog.push_str(&format!("    <string>{}</string>\n", xml_escape(a)));
    }
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array>
{prog}  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>{out}</string>
  <key>StandardErrorPath</key><string>{err}</string>
</dict>
</plist>
"#,
        prog = prog,
        out = xml_escape(out_log),
        err = xml_escape(err_log),
    )
}

#[cfg(target_os = "linux")]
fn render_unit(exe: &str, args: &[String], _out: &str, _err: &str) -> String {
    let quoted: Vec<String> = args
        .iter()
        .map(|a| format!("'{}'", a.replace('\'', "'\\''")))
        .collect();
    format!(
        "[Unit]\n\
         Description=agent-yes Rust serve daemon (ayrs)\n\
         After=network-online.target\n\n\
         [Service]\n\
         Type=simple\n\
         ExecStart='{exe}' {args}\n\
         Restart=always\n\
         RestartSec=5\n\n\
         [Install]\n\
         WantedBy=default.target\n",
        exe = exe,
        args = quoted.join(" "),
    )
}

/// `DOMAIN\user` for the task's principal and logon trigger. Task Scheduler
/// accepts a bare username too, but the qualified form is what its own exports
/// use and it stays unambiguous on a domain-joined box.
#[cfg(windows)]
fn current_user() -> String {
    let user = std::env::var("USERNAME").unwrap_or_default();
    match std::env::var("USERDOMAIN") {
        Ok(d) if !d.is_empty() && !user.is_empty() => format!("{d}\\{user}"),
        _ => user,
    }
}

/// `ay-spawn-hidden.exe` next to this binary, if it shipped with this install.
#[cfg(windows)]
fn spawn_hidden() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let p = exe.parent()?.join("ay-spawn-hidden.exe");
    p.is_file().then_some(p)
}

/// (Command, Arguments) for the task's `<Exec>` action.
///
/// `cmd.exe /d /c call "<script>"` rather than `/c "<script>"`: when the string
/// after `/c` starts with a quote, cmd strips the outer pair, which would break
/// a home directory containing a space. `call` puts a bare token first, so the
/// quoting survives. `/d` skips AutoRun registry commands.
#[cfg(windows)]
fn task_action(script: &std::path::Path) -> (String, String) {
    let inner = format!("/d /c call \"{}\"", script.display());
    match spawn_hidden() {
        // The shim is GUI-subsystem, so Task Scheduler allocates it no console
        // at all, and it starts cmd with CREATE_NO_WINDOW — nothing flashes.
        Some(l) => (
            strip_verbatim(&l.to_string_lossy()),
            format!("cmd.exe {inner}"),
        ),
        None => ("cmd.exe".to_string(), inner),
    }
}

/// The `.cmd` the task runs: the daemon with its output appended to the same
/// log files launchd names via StandardOutPath/StandardErrorPath.
#[cfg(windows)]
fn render_launcher_cmd(exe: &str, args: &[String], out_log: &str, err_log: &str) -> String {
    // `%` is the one character batch re-interprets inside a quoted token.
    let q = |s: &str| format!("\"{}\"", s.replace('%', "%%"));
    let argv: Vec<String> = args.iter().map(|a| q(a)).collect();
    format!(
        "@echo off\r\n\
         rem Generated by `ayrs serve install` — regenerated on every install.\r\n\
         rem Task Scheduler cannot redirect stdio, so the redirect lives here.\r\n\
         {exe} {args} >> {out} 2>> {err}\r\n",
        exe = q(exe),
        args = argv.join(" "),
        out = q(out_log),
        err = q(err_log),
    )
}

/// Task Scheduler 1.2 XML. Element order follows the schema sequence that the
/// Task Scheduler UI itself exports — the parser rejects a reordered `Settings`.
#[cfg(windows)]
fn render_task_xml(user: &str, command: &str, arguments: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>agent-yes Rust serve daemon (ayrs)</Description>
    <URI>\{label}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>{user}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>{user}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{command}</Command>
      <Arguments>{arguments}</Arguments>
    </Exec>
  </Actions>
</Task>
"#,
        label = LABEL,
        user = xml_escape(user),
        command = xml_escape(command),
        arguments = xml_escape(arguments),
    )
}

#[cfg(windows)]
fn render_unit(exe: &str, args: &[String], out_log: &str, err_log: &str) -> String {
    // The XML names the shim; the shim's script is written separately by
    // install() from the same exe/args, so both stay in sync.
    let script = script_path().unwrap_or_else(|_| PathBuf::from(format!("{LABEL}.cmd")));
    let _ = (exe, args, out_log, err_log);
    let (command, arguments) = task_action(&script);
    render_task_xml(&current_user(), &command, &arguments)
}

/// Block until nothing else holds the log files open, so a reinstall doesn't
/// race the instance it just stopped.
///
/// `schtasks /end` returns as soon as the kill is *requested*; the old daemon
/// can outlive the call by a beat. That matters because the shim's `>>`
/// redirect opens the logs deny-write: starting the replacement too early makes
/// cmd fail to open them and the daemon exits immediately — with no output, in
/// the very files that would have explained it. Probing with `share_mode(0)`
/// tests exactly the access cmd is about to need.
#[cfg(windows)]
fn wait_for_logs_released(paths: &[&std::path::Path]) {
    use std::os::windows::fs::OpenOptionsExt;
    for _ in 0..100 {
        let all_free = paths.iter().all(|p| {
            !p.exists()
                || std::fs::OpenOptions::new()
                    .append(true)
                    .share_mode(0)
                    .open(p)
                    .is_ok()
        });
        if all_free {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

/// `schtasks /run` reports only that the *launch* was accepted, and the task's
/// exit code surfaces as a locale-dependent "Last Result" line. Watching the
/// error log grow instead is locale-independent and proves the daemon actually
/// reached its startup banner.
#[cfg(windows)]
fn wait_for_daemon_output(err_log: &std::path::Path, before: u64) -> bool {
    for _ in 0..100 {
        if std::fs::metadata(err_log).map(|m| m.len()).unwrap_or(0) > before {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    false
}

/// `schtasks /xml` only reads UTF-16 — a UTF-8 file fails with a bare
/// "The task XML is malformed", so encode explicitly rather than `fs::write`.
#[cfg(windows)]
fn write_utf16(path: &std::path::Path, body: &str) -> Result<()> {
    let mut bytes = vec![0xFF, 0xFE]; // UTF-16LE BOM
    for u in body.encode_utf16() {
        bytes.extend_from_slice(&u.to_le_bytes());
    }
    std::fs::write(path, bytes)?;
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn render_unit(_e: &str, _a: &[String], _o: &str, _r: &str) -> String {
    String::new()
}

fn run(cmd: &str, args: &[&str]) -> Result<String> {
    let out = Command::new(cmd)
        .args(args)
        .output()
        .with_context(|| format!("failed to run `{cmd}`"))?;
    let mut s = String::from_utf8_lossy(&out.stdout).into_owned();
    s.push_str(&String::from_utf8_lossy(&out.stderr));
    if !out.status.success() {
        bail!("`{cmd} {}` failed: {}", args.join(" "), s.trim());
    }
    Ok(s)
}

// --- oxmgr fallback -------------------------------------------------------
// On Linux WITHOUT a systemd `--user` bus (e.g. a container: `systemctl --user`
// fails with "Failed to connect to bus … $DBUS_SESSION_BUS_ADDRESS and
// $XDG_RUNTIME_DIR not defined"), there is no native user supervisor to talk to.
// Rather than fail, fall back to oxmgr — the same supervisor the TS `ay serve`
// uses. This does NOT reintroduce a Node/Bun process into the *ayrs* daemon tree
// (oxmgr is a separate supervisor; the process it runs is still pure-Rust ayrs).

/// The oxmgr-managed process name. Matches the TS daemon's convention and stays
/// distinct from it (`agent-yes`), so both can be registered during migration.
const OXMGR_NAME: &str = "ayrs-serve";

/// `which`-style PATH lookup for an executable (Linux fallback only).
fn which(bin: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(bin);
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }
    None
}

/// Is a usable systemd user bus present? Probe with a cheap read-only call — if
/// the bus is unreachable this fails with the same connection error `install`
/// would hit, so a `false` here reliably means "don't use systemd --user".
#[cfg(target_os = "linux")]
fn systemd_user_available() -> bool {
    Command::new("systemctl")
        .args(["--user", "show-environment"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// POSIX single-quote a token so oxmgr's shell-style word splitting keeps it
/// intact (verified: oxmgr parses `'a b'` as one arg). Safe-charset tokens pass
/// through unquoted for readability. Guards against spaces in the exe path
/// (e.g. an unusual install dir) or a future arg.
fn sh_quote(s: &str) -> String {
    let safe = !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/._-+@:=".contains(&b));
    if safe {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

/// The single command string oxmgr's `start <COMMAND>` positional expects; oxmgr
/// splits it (shell-style) into program + args (verified: stores command=`…/ayrs`,
/// args=[…]). Each token is shell-quoted so spaces/specials survive the split.
fn oxmgr_command(exe: &str, args: &[String]) -> String {
    std::iter::once(sh_quote(exe))
        .chain(args.iter().map(|a| sh_quote(a)))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Register (or re-register) `ayrs serve` under oxmgr with restart-on-crash.
/// No `--health-cmd`: ayrs has no serve-liveness heartbeat, and unlike the Bun
/// daemon (which could freeze its JS loop while alive) has no "alive-but-wedged"
/// failure mode, so restart-always is sufficient supervision.
fn oxmgr_install(oxmgr: &str, exe: &str, args: &[String]) -> Result<()> {
    let _ = Command::new(oxmgr).args(["delete", OXMGR_NAME]).output(); // idempotent
    let cmd = oxmgr_command(exe, args);
    run(
        oxmgr,
        &[
            "start",
            &cmd,
            "--name",
            OXMGR_NAME,
            "--restart",
            "always",
            "--max-restarts",
            "20",
        ],
    )?;
    Ok(())
}

pub fn install(webrtc: &Option<String>, sighost: &str) -> Result<()> {
    let path = unit_path()?;
    let exe = exe()?;
    let args = service_args(webrtc, sighost);

    // Idempotent re-run: if the daemon is already up on THIS binary's version
    // with THESE exact args, skip the teardown+reinstall entirely — restarting
    // it would drop every connected browser to re-assert what's already true.
    // (Mirrors `ay serve install`'s up-to-date no-op.) An upgraded binary or a
    // config change fails this check and falls through to the roll-forward below.
    if already_current(&args) {
        println!(
            "{LABEL} already running v{} (up to date)",
            env!("CARGO_PKG_VERSION")
        );
        return Ok(());
    }

    let (webrtc_url, browser_url) = super::share::resolve_share_urls(webrtc.as_deref(), sighost)?;
    let dir = log_dir()?;
    let out_log = dir.join("ayrs-serve.log");
    let err_log = dir.join("ayrs-serve.err.log");

    let body = render_unit(
        &exe,
        &args,
        &out_log.to_string_lossy(),
        &err_log.to_string_lossy(),
    );

    // Write the native unit + load it. Factored into a closure so the Linux
    // branch can choose it OR the oxmgr fallback without writing a stray unit
    // file when systemd isn't usable.
    let write_native_unit = || -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // Reinstalling over a loaded unit: unload first so the new definition
        // actually takes effect instead of silently keeping the old one running.
        let _ = uninstall_quiet();
        // Windows needs two files, not one: Task Scheduler can't do launchd's
        // StandardOutPath redirect, so the task action runs a generated `.cmd`
        // shim that appends to the same logs; and `schtasks /xml` only accepts
        // UTF-16, so the task definition goes through write_utf16.
        #[cfg(windows)]
        {
            let script = script_path()?;
            std::fs::write(
                &script,
                render_launcher_cmd(
                    &exe,
                    &args,
                    &out_log.to_string_lossy(),
                    &err_log.to_string_lossy(),
                ),
            )?;
            println!("wrote {}", script.display());
            write_utf16(&path, &body)?;
        }
        #[cfg(not(windows))]
        std::fs::write(&path, &body)?;
        println!("wrote {}", path.display());
        Ok(())
    };

    #[cfg(target_os = "macos")]
    {
        write_native_unit()?;
        let uid = unsafe { libc::getuid() };
        run(
            "launchctl",
            &["bootstrap", &format!("gui/{uid}"), &path.to_string_lossy()],
        )?;
        run(
            "launchctl",
            &["kickstart", "-k", &format!("gui/{uid}/{LABEL}")],
        )?;
        println!("installed {LABEL} ({exe} {})", args.join(" "));
    }
    #[cfg(target_os = "linux")]
    {
        if systemd_user_available() {
            write_native_unit()?;
            run("systemctl", &["--user", "daemon-reload"])?;
            run("systemctl", &["--user", "enable", "--now", LABEL])?;
            println!("installed {LABEL} ({exe} {})", args.join(" "));
        } else if let Some(oxmgr) = which("oxmgr") {
            // No systemd --user bus (typically a container). Supervise via oxmgr
            // instead of writing an inert unit that never loads. Also clear any
            // stray unit a prior systemd attempt may have left behind.
            let _ = std::fs::remove_file(&path);
            oxmgr_install(&oxmgr, &exe, &args)?;
            println!("no systemd --user bus — registered with oxmgr as '{OXMGR_NAME}'");
            println!("installed {OXMGR_NAME} ({exe} {})", args.join(" "));
        } else {
            bail!(
                "no systemd --user bus and no oxmgr on PATH.\n  \
                 Install oxmgr (bun add -g oxmgr) or run this yourself under a supervisor:\n    \
                 {exe} {}",
                args.join(" ")
            );
        }
    }
    #[cfg(windows)]
    {
        write_native_unit()?;
        run(
            "schtasks",
            &[
                "/create",
                "/tn",
                LABEL,
                "/xml",
                &path.to_string_lossy(),
                "/f",
            ],
        )?;
        wait_for_logs_released(&[&out_log, &err_log]);
        let before = std::fs::metadata(&err_log).map(|m| m.len()).unwrap_or(0);
        // /create only registers it; the logon trigger won't fire until the next
        // sign-in, so start it now the way launchctl kickstart / systemd --now do.
        run("schtasks", &["/run", "/tn", LABEL])?;
        if !wait_for_daemon_output(&err_log, before) {
            bail!(
                "task {LABEL} was registered and started, but the daemon produced no output \
                 within 10s — inspect {} and `schtasks /query /tn {LABEL} /fo LIST /v`",
                err_log.display()
            );
        }
        if spawn_hidden().is_none() {
            eprintln!(
                "note: ay-spawn-hidden.exe was not found next to ayrs.exe, so the task \
                 launches cmd.exe directly and a console window will appear at logon."
            );
        }
    }

    println!("webrtc: {webrtc_url}");
    println!("console: {browser_url}");
    println!("logs: {}", out_log.display());
    Ok(())
}

fn uninstall_quiet() -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        let uid = unsafe { libc::getuid() };
        let _ = Command::new("launchctl")
            .args(["bootout", &format!("gui/{uid}/{LABEL}")])
            .output();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = Command::new("systemctl")
            .args(["--user", "disable", "--now", LABEL])
            .output();
        // Also drop the oxmgr fallback registration, if any (harmless no-op when
        // absent). Covers the container path where install() used oxmgr.
        if let Some(oxmgr) = which("oxmgr") {
            let _ = Command::new(oxmgr).args(["delete", OXMGR_NAME]).output();
        }
    }
    #[cfg(windows)]
    {
        // /end stops the running instance; /delete deregisters it. Both are
        // no-ops (non-zero exit, ignored) when the task isn't there.
        let _ = Command::new("schtasks")
            .args(["/end", "/tn", LABEL])
            .output();
        let _ = Command::new("schtasks")
            .args(["/delete", "/tn", LABEL, "/f"])
            .output();
    }
    Ok(())
}

pub fn uninstall() -> Result<()> {
    uninstall_quiet()?;
    // Drop the run receipt too: leaving it behind (with a now-dead pid) is
    // harmless for `already_current`'s liveness check, but removing it keeps the
    // state clean and avoids a stale version lingering on disk.
    if let Ok(receipt) = receipt_path() {
        let _ = std::fs::remove_file(receipt);
    }
    let path = unit_path()?;
    if path.exists() {
        std::fs::remove_file(&path)?;
        println!("removed {}", path.display());
    } else {
        println!("{LABEL} uninstalled (or was not installed)");
    }
    #[cfg(windows)]
    if let Ok(script) = script_path() {
        if script.exists() {
            std::fs::remove_file(&script)?;
            println!("removed {}", script.display());
        }
    }
    Ok(())
}

// --- restart ---------------------------------------------------------------

/// The supervisor invocation `restart` issues, as (program, args). Split out so
/// a test pins the exact command — on macOS the `-k` is the whole feature: plain
/// `launchctl kickstart` starts the service only if it is NOT already running,
/// so dropping the flag turns a restart into a silent no-op against a live
/// daemon (and the stale binary keeps serving).
#[cfg(target_os = "macos")]
fn restart_argv(uid: u32) -> (String, Vec<String>) {
    (
        "launchctl".to_string(),
        vec![
            "kickstart".to_string(),
            "-k".to_string(),
            format!("gui/{uid}/{LABEL}"),
        ],
    )
}

#[cfg(target_os = "linux")]
fn restart_argv() -> (String, Vec<String>) {
    (
        "systemctl".to_string(),
        vec![
            "--user".to_string(),
            "restart".to_string(),
            LABEL.to_string(),
        ],
    )
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn exec_restart(prog: &str, args: &[String]) -> Result<String> {
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run(prog, &refs)
}

/// A restart only manages an EXISTING registration — it never writes a unit —
/// so a missing one is a user error, not something to paper over by installing.
#[cfg(any(target_os = "macos", target_os = "linux", windows))]
fn ensure_installed(path: &std::path::Path) -> Result<()> {
    if path.exists() {
        return Ok(());
    }
    bail!(
        "{LABEL} is not installed ({} missing) — run `ayrs serve install` first",
        path.display()
    )
}

/// Bounce the installed daemon in place, keeping the unit exactly as it is.
///
/// This is the command to run after `bun run build:rs` replaces the binary at
/// the path the unit already names: the supervisor re-execs that path, so the
/// new build takes over without rewriting (or re-deciding) any config. Unlike
/// `install`, it never recomputes the service args, so it can't silently rotate
/// the room or change the sighost — and unlike `uninstall`+`install`, it leaves
/// boot-autostart untouched.
///
/// Safe for the local fleet: agents are spawned into their own session by
/// `spawn_detached` (see `serve/control.rs`, asserted by
/// `a_spawned_child_gets_its_own_session`), so bouncing the daemon does not take
/// the agents it spawned down with it.
pub fn restart() -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        let path = unit_path()?;
        ensure_installed(&path)?;
        let uid = unsafe { libc::getuid() };
        let (prog, args) = restart_argv(uid);
        // A plist can exist without ever having been bootstrapped (hand-copied,
        // or a `bootout` that left the file); kickstart then fails with "Could
        // not find service". `install` is what loads it, so point there.
        exec_restart(&prog, &args)
            .with_context(|| format!("{LABEL} is not loaded — run `ayrs serve install`"))?;
        println!("restarted {LABEL}");
    }
    #[cfg(target_os = "linux")]
    {
        if systemd_user_available() {
            let path = unit_path()?;
            ensure_installed(&path)?;
            let (prog, args) = restart_argv();
            exec_restart(&prog, &args)?;
            println!("restarted {LABEL}");
        } else if let Some(oxmgr) = which("oxmgr") {
            // Same fallback `install` uses on a host with no systemd --user bus
            // (typically a container). oxmgr's `restart` takes an already
            // registered name, so a failure here means it never was registered.
            run(&oxmgr, &["restart", OXMGR_NAME])
                .with_context(|| format!("'{OXMGR_NAME}' is not registered with oxmgr"))?;
            println!("restarted {OXMGR_NAME} (via oxmgr)");
        } else {
            bail!("no systemd --user bus and no oxmgr on PATH — nothing to restart");
        }
    }
    #[cfg(windows)]
    {
        // Task Scheduler has no "restart": stop the running instance, then start
        // the task again. This path used to fall through to the unsupported-OS
        // arm below, which — once unit_path() gained a Windows branch — returned
        // Ok(()) having done nothing, so `ayrs serve restart` silently left the
        // old binary serving.
        let path = unit_path()?;
        ensure_installed(&path)?;
        let dir = log_dir()?;
        let out_log = dir.join("ayrs-serve.log");
        let err_log = dir.join("ayrs-serve.err.log");
        // /end returns once the stop is REQUESTED; a stopped-but-not-yet-gone
        // instance still holds the logs deny-write, and starting the new one
        // before it lets go makes the shim's `>>` fail with no output anywhere.
        let _ = Command::new("schtasks")
            .args(["/end", "/tn", LABEL])
            .output();
        wait_for_logs_released(&[&out_log, &err_log]);
        let before = std::fs::metadata(&err_log).map(|m| m.len()).unwrap_or(0);
        run("schtasks", &["/run", "/tn", LABEL])
            .with_context(|| format!("{LABEL} is not registered — run `ayrs serve install`"))?;
        if !wait_for_daemon_output(&err_log, before) {
            bail!(
                "task {LABEL} was started, but the daemon produced no output within 10s —                  inspect {} and `schtasks /query /tn {LABEL} /fo LIST /v`",
                err_log.display()
            );
        }
        println!("restarted {LABEL}");
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    {
        // Bails with the "only supported on …" message.
        unit_path()?;
    }

    Ok(())
}

pub fn status() -> Result<()> {
    let path = unit_path()?;
    println!(
        "unit: {} ({})",
        path.display(),
        if path.exists() { "present" } else { "missing" }
    );
    #[cfg(target_os = "macos")]
    {
        let uid = unsafe { libc::getuid() };
        match run("launchctl", &["print", &format!("gui/{uid}/{LABEL}")]) {
            Ok(s) => {
                for line in s.lines() {
                    let t = line.trim();
                    if t.starts_with("state =")
                        || t.starts_with("pid =")
                        || t.starts_with("last exit code")
                    {
                        println!("{t}");
                    }
                }
            }
            Err(_) => println!("state = not loaded"),
        }
    }
    #[cfg(target_os = "linux")]
    {
        if systemd_user_available() {
            let s = Command::new("systemctl")
                .args(["--user", "status", LABEL])
                .output();
            if let Ok(o) = s {
                print!("{}", String::from_utf8_lossy(&o.stdout));
            }
        } else if let Some(oxmgr) = which("oxmgr") {
            // Report the oxmgr fallback registration (the container path).
            println!("supervisor: oxmgr (no systemd --user bus)");
            let s = Command::new(oxmgr).args(["list"]).output();
            if let Ok(o) = s {
                let out = String::from_utf8_lossy(&o.stdout);
                for line in out.lines() {
                    if line.contains("NAME") || line.contains(OXMGR_NAME) {
                        println!("{line}");
                    }
                }
            }
        } else {
            println!("state = no supervisor (no systemd --user bus, no oxmgr)");
        }
    }
    #[cfg(windows)]
    {
        // Plain /fo LIST (not /v): six lines including Status and Next Run Time,
        // and no dependence on which field names this Windows locale prints.
        match run("schtasks", &["/query", "/tn", LABEL, "/fo", "LIST"]) {
            Ok(s) => {
                for line in s.lines().filter(|l| !l.trim().is_empty()) {
                    println!("{}", line.trim_end());
                }
            }
            Err(_) => println!("state = not registered"),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn service_args_defaults_to_persisted_room() {
        assert_eq!(
            service_args(&Some(String::new()), "s.agent-yes.com"),
            vec!["serve", "--webrtc", "--sighost", "s.agent-yes.com"]
        );
    }

    fn receipt(version: &str, pid: u32) -> RunReceipt {
        RunReceipt {
            version: version.to_string(),
            pid,
            args: service_args(&Some(String::new()), "s.agent-yes.com"),
        }
    }

    #[test]
    fn receipt_current_when_version_args_and_pid_all_match() {
        // Our own pid is reliably alive; version + args match → up to date.
        let r = receipt(env!("CARGO_PKG_VERSION"), std::process::id());
        let args = service_args(&Some(String::new()), "s.agent-yes.com");
        assert!(receipt_is_current(&r, &args));
    }

    #[test]
    fn receipt_stale_when_version_differs() {
        // An upgraded binary: the running daemon still reports the old version,
        // so install must NOT no-op (it should roll the daemon forward).
        let r = receipt("0.0.0-old", std::process::id());
        let args = service_args(&Some(String::new()), "s.agent-yes.com");
        assert!(!receipt_is_current(&r, &args));
    }

    #[test]
    fn receipt_stale_when_config_differs() {
        // Same version, but a different sighost → a config change must reinstall.
        let r = receipt(env!("CARGO_PKG_VERSION"), std::process::id());
        let other = service_args(&Some(String::new()), "other.example.com");
        assert!(!receipt_is_current(&r, &other));
    }

    #[test]
    fn receipt_stale_when_pid_is_dead() {
        // A crashed/stopped daemon left a receipt behind: a dead pid means the
        // service isn't actually running, so install must (re)start it.
        let dead = 4_194_303; // implausibly high pid, not us
        let r = receipt(env!("CARGO_PKG_VERSION"), dead);
        let args = service_args(&Some(String::new()), "s.agent-yes.com");
        assert!(!receipt_is_current(&r, &args));
    }

    #[test]
    fn receipt_serde_round_trips() {
        let r = receipt(env!("CARGO_PKG_VERSION"), 12345);
        let json = serde_json::to_string(&r).unwrap();
        let back: RunReceipt = serde_json::from_str(&json).unwrap();
        assert_eq!(back.version, r.version);
        assert_eq!(back.pid, r.pid);
        assert_eq!(back.args, r.args);
    }

    #[test]
    fn oxmgr_command_joins_exe_and_args() {
        // oxmgr's `start <COMMAND>` positional takes one string it splits itself.
        let cmd = oxmgr_command(
            "/root/.cargo/bin/ayrs",
            &service_args(&Some(String::new()), "s.agent-yes.com"),
        );
        assert_eq!(
            cmd,
            "/root/.cargo/bin/ayrs serve --webrtc --sighost s.agent-yes.com"
        );
    }

    #[test]
    fn oxmgr_command_quotes_spaces_and_specials() {
        // A path with a space must survive oxmgr's shell-style split as ONE token.
        let cmd = oxmgr_command("/home/a b/ayrs", &["serve".into(), "--webrtc".into()]);
        assert_eq!(cmd, "'/home/a b/ayrs' serve --webrtc");
        // embedded single quote → POSIX close/escape/reopen
        assert_eq!(sh_quote("a'b"), "'a'\\''b'");
        // safe tokens (incl. the room-URL charset) pass through unquoted
        assert_eq!(
            sh_quote("webrtc://r1:e1.ab@s.agent-yes.com"),
            "webrtc://r1:e1.ab@s.agent-yes.com"
        );
    }

    #[test]
    fn service_args_pins_explicit_room() {
        let a = service_args(
            &Some("webrtc://r1:e1.ab@s.agent-yes.com".into()),
            "s.agent-yes.com",
        );
        assert_eq!(a[2], "webrtc://r1:e1.ab@s.agent-yes.com");
    }

    #[test]
    fn install_receipt_urls_match_explicit_room() {
        let secret = "ab".repeat(32);
        let room_url = format!("webrtc://r1:e1.{secret}@s.agent-yes.com");
        let (webrtc, console) =
            super::super::share::resolve_share_urls(Some(&room_url), "ignored.example").unwrap();
        assert_eq!(webrtc, room_url);
        assert_eq!(console, format!("https://agent-yes.com/w/#r1:e1.{secret}"));
    }

    #[cfg(windows)]
    #[test]
    fn task_xml_is_well_formed_and_escaped() {
        let xml = render_task_xml(
            "BOX\\me",
            "C:\\bin\\ay-spawn-hidden.exe",
            "cmd.exe /d /c call \"C:\\a&b\\s.cmd\"",
        );
        assert!(xml.starts_with("<?xml version=\"1.0\" encoding=\"UTF-16\"?>"));
        assert!(xml.contains("<UserId>BOX\\me</UserId>"));
        assert!(xml.contains("<Command>C:\\bin\\ay-spawn-hidden.exe</Command>"));
        // `&` must survive as an entity or Task Scheduler rejects the document.
        assert!(xml.contains("C:\\a&amp;b\\s.cmd"));
        assert!(xml.contains("<LogonType>InteractiveToken</LogonType>"));
        assert!(xml.contains("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>"));
    }

    #[cfg(windows)]
    #[test]
    fn launcher_cmd_quotes_paths_and_redirects_both_streams() {
        let s = render_launcher_cmd(
            "C:\\Program Files\\ayrs.exe",
            &service_args(&Some(String::new()), "s.agent-yes.com"),
            "C:\\logs\\o.log",
            "C:\\logs\\e.log",
        );
        assert!(s.contains("\"C:\\Program Files\\ayrs.exe\" \"serve\" \"--webrtc\""));
        assert!(s.contains(">> \"C:\\logs\\o.log\" 2>> \"C:\\logs\\e.log\""));
        assert!(s.starts_with("@echo off"));
    }

    #[cfg(windows)]
    #[test]
    fn launcher_cmd_escapes_percent_so_batch_cannot_expand_it() {
        let s = render_launcher_cmd(
            "C:\\a\\ayrs.exe",
            &["serve".into(), "%PATH%".into()],
            "o",
            "e",
        );
        assert!(s.contains("\"%%PATH%%\""));
    }

    #[cfg(windows)]
    #[test]
    fn task_action_uses_call_so_a_spaced_home_survives_cmd_quote_stripping() {
        let (_cmd, args) = task_action(std::path::Path::new("C:\\Users\\a b\\.agent-yes\\x.cmd"));
        assert!(args.ends_with("/d /c call \"C:\\Users\\a b\\.agent-yes\\x.cmd\""));
    }

    #[cfg(windows)]
    #[test]
    fn utf16_xml_gets_the_bom_schtasks_requires() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("t.xml");
        write_utf16(&p, "<Task/>").unwrap();
        let b = std::fs::read(&p).unwrap();
        assert_eq!(&b[..2], &[0xFF, 0xFE]);
        assert_eq!(&b[2..6], &[b'<', 0, b'T', 0]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn restart_kickstarts_the_loaded_unit_with_k() {
        let (prog, args) = restart_argv(501);
        assert_eq!(prog, "launchctl");
        // `-k` is load-bearing: without it kickstart only starts a service that
        // is NOT already running, so restarting a live daemon silently no-ops
        // and the old binary keeps serving.
        assert_eq!(args, vec!["kickstart", "-k", &format!("gui/501/{LABEL}")]);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn restart_targets_the_user_unit() {
        let (prog, args) = restart_argv();
        assert_eq!(prog, "systemctl");
        // `--user`: the unit is installed into the per-user manager, so a
        // system-scope restart would look for a unit that does not exist there.
        assert_eq!(args, vec!["--user", "restart", LABEL]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn plist_escapes_and_lists_every_arg() {
        let u = render_unit(
            "/bin/ayrs",
            &service_args(&Some(String::new()), "a&b"),
            "/o",
            "/e",
        );
        assert!(u.contains("<string>/bin/ayrs</string>"));
        assert!(u.contains("<string>--webrtc</string>"));
        assert!(u.contains("<string>a&amp;b</string>"));
        assert!(u.contains(&format!("<string>{LABEL}</string>")));
    }
}
