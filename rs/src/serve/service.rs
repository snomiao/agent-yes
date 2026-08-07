// Native OS-level service install for `ayrs serve`.
//
// Prefers the platform's own supervisor so the *ayrs* daemon tree stays pure
// Rust (no Node/Bun), the whole point of the Rust daemon:
//
//   macOS  -> launchd user agent  ~/Library/LaunchAgents/<LABEL>.plist
//   Linux  -> systemd user unit   ~/.config/systemd/user/<LABEL>.service
//
// Fallback: on Linux WITHOUT a usable systemd `--user` bus (e.g. a container),
// register with oxmgr instead of failing (see the oxmgr block below). oxmgr is a
// separate supervisor process — the ayrs process it runs is still pure Rust — so
// the "no Node/Bun in ayrs" invariant holds. This mirrors how the TS `ay serve`
// is managed on such hosts.
//
// The systemd/launchd label is distinct from the oxmgr name the TS daemon
// registers (`agent-yes`), so both can be installed at once during migration.

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
    Ok(p.to_string_lossy().into_owned())
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

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn unit_path() -> Result<PathBuf> {
    bail!("`ayrs serve install` is only supported on macOS (launchd) and Linux (systemd --user)")
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

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
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
