// Native OS-level service install for `ayrs serve`.
//
// Deliberately does NOT go through oxmgr/pm2 the way the TS `ay serve install`
// does: the whole point of the Rust daemon is to have no Node/Bun process in
// the tree, so we talk to the platform's own supervisor directly.
//
//   macOS  -> launchd user agent  ~/Library/LaunchAgents/<LABEL>.plist
//   Linux  -> systemd user unit   ~/.config/systemd/user/<LABEL>.service
//
// The label is distinct from anything the TS daemon registers (oxmgr owns
// `io.oxmgr.daemon`), so both can be installed at the same time during the
// migration.

use anyhow::{bail, Context, Result};
use std::collections::HashSet;
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

/// A service-safe PATH that retains the user's common package-manager bins.
/// launchd otherwise supplies only /usr/bin:/bin:/usr/sbin:/sbin, and every
/// agent spawned by the daemon inherits that crippled PATH.
pub(crate) fn runtime_path() -> String {
    let mut paths = Vec::<PathBuf>::new();
    if let Some(home) = dirs::home_dir() {
        paths.extend([
            home.join(".bun/bin"),
            home.join(".cargo/bin"),
            home.join(".local/bin"),
        ]);
    }
    if let Some(current) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&current));
    }
    #[cfg(unix)]
    paths.extend(
        ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
            .into_iter()
            .map(PathBuf::from),
    );
    let mut seen = HashSet::new();
    paths.retain(|path| seen.insert(path.clone()));
    std::env::join_paths(paths)
        .unwrap_or_else(|_| std::ffi::OsString::from("/usr/bin:/bin:/usr/sbin:/sbin"))
        .to_string_lossy()
        .into_owned()
}

/// Args the service should run, after the executable path.
fn service_args(webrtc: &Option<String>, sighost: &str) -> Vec<String> {
    let mut args = vec!["serve".to_string(), "--webrtc".to_string()];
    if let Some(v) = webrtc {
        if !v.is_empty() {
            args.push(v.clone());
        }
    }
    args.push("--sighost".to_string());
    args.push(sighost.to_string());
    // A free loopback port gives sandboxed nested launchers a control path to
    // the unsandboxed service. The chosen port is published in ayrs-http.json.
    args.push("--port".to_string());
    args.push("0".to_string());
    args
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
  <key>ProcessType</key><string>Interactive</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>{path}</string>
    <key>RUST_BACKTRACE</key><string>1</string>
  </dict>
  <key>StandardOutPath</key><string>{out}</string>
  <key>StandardErrorPath</key><string>{err}</string>
</dict>
</plist>
"#,
        prog = prog,
        path = xml_escape(&runtime_path()),
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
         Environment=\"PATH={path}\"\n\
         Environment=\"RUST_BACKTRACE=1\"\n\
         Restart=always\n\
         RestartSec=5\n\n\
         [Install]\n\
         WantedBy=default.target\n",
        exe = exe,
        args = quoted.join(" "),
        path = runtime_path().replace('\\', "\\\\").replace('"', "\\\""),
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

pub fn install(webrtc: &Option<String>, sighost: &str) -> Result<()> {
    let path = unit_path()?;
    let exe = exe()?;
    let args = service_args(webrtc, sighost);
    let (webrtc_url, browser_url) = super::share::resolve_share_urls(webrtc.as_deref(), sighost)?;
    let dir = log_dir()?;
    let out_log = dir.join("ayrs-serve.log");
    let err_log = dir.join("ayrs-serve.err.log");

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let body = render_unit(
        &exe,
        &args,
        &out_log.to_string_lossy(),
        &err_log.to_string_lossy(),
    );
    // Reinstalling over a loaded unit: unload first so the new definition
    // actually takes effect instead of silently keeping the old one running.
    let _ = uninstall_quiet();
    std::fs::write(&path, body)?;
    println!("wrote {}", path.display());

    #[cfg(target_os = "macos")]
    {
        let uid = unsafe { libc::getuid() };
        run(
            "launchctl",
            &["bootstrap", &format!("gui/{uid}"), &path.to_string_lossy()],
        )?;
        run(
            "launchctl",
            &["kickstart", "-k", &format!("gui/{uid}/{LABEL}")],
        )?;
    }
    #[cfg(target_os = "linux")]
    {
        run("systemctl", &["--user", "daemon-reload"])?;
        run("systemctl", &["--user", "enable", "--now", LABEL])?;
    }

    println!("installed {LABEL} ({exe} {})", args.join(" "));
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
    }
    Ok(())
}

pub fn uninstall() -> Result<()> {
    uninstall_quiet()?;
    let path = unit_path()?;
    if path.exists() {
        std::fs::remove_file(&path)?;
        println!("removed {}", path.display());
    } else {
        println!("{LABEL} was not installed");
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
        let s = Command::new("systemctl")
            .args(["--user", "status", LABEL])
            .output();
        if let Ok(o) = s {
            print!("{}", String::from_utf8_lossy(&o.stdout));
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
            vec![
                "serve",
                "--webrtc",
                "--sighost",
                "s.agent-yes.com",
                "--port",
                "0",
            ]
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
        assert!(u.contains("<string>--port</string>"));
        assert!(u.contains("<string>0</string>"));
        assert!(u.contains("<key>ProcessType</key><string>Interactive</string>"));
        assert!(u.contains("<key>EnvironmentVariables</key>"));
        assert!(u.contains("<key>RUST_BACKTRACE</key><string>1</string>"));
        assert!(u.contains(".bun/bin"));
        assert!(u.contains(".cargo/bin"));
        assert!(u.contains(&format!("<string>{LABEL}</string>")));
    }

    #[test]
    fn runtime_path_keeps_agent_tool_bins_and_is_deduplicated() {
        let path = runtime_path();
        assert!(path.contains(".bun/bin"));
        assert!(path.contains(".cargo/bin"));
        let entries: Vec<_> = std::env::split_paths(&std::ffi::OsString::from(path)).collect();
        let unique: HashSet<_> = entries.iter().cloned().collect();
        assert_eq!(entries.len(), unique.len());
    }
}
