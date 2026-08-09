//! Recover the user's login+interactive shell environment for daemon-spawned
//! agents.
//!
//! An `ayrs serve` started by launchd/systemd inherits the bare service PATH
//! (`/usr/bin:/bin:/usr/sbin:/sbin`) — none of the user's shell config is ever
//! read by the init system — and `spawn_detached` used to pass that
//! environment verbatim to every agent it spawned, so `bun`/`cargo`/user CLIs
//! were "command not found" inside them. The user's config is fine; it was
//! never consulted.
//!
//! Fix: once per daemon lifetime, run the user's shell as a login+interactive
//! (`-lic`) one-shot that prints its environment fenced by sentinels, and use
//! that as the base env for spawned agents. `-i` matters: PATH exports are
//! commonly scattered across `.zshenv`/`.zprofile`/`.zshrc`, and a plain
//! login shell (`-lc`) never reads `.zshrc`, silently dropping entries.
//! Mirrors (and strengthens) `loginShellEnv` in ts/serve.ts.
//!
//! Best-effort by design: sentinel extraction survives rc-file banners, a
//! timeout guards against an rc file that blocks, and every failure path
//! falls back to "inherit the daemon env unchanged" — spawning must never
//! break because env recovery did.

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tracing::{debug, info};

const DELIM: &str = "_AYRS_SHELL_ENV_DELIM_";
const TIMEOUT_MS: u64 = 8_000;

static CACHE: OnceLock<Option<HashMap<String, String>>> = OnceLock::new();

/// Resolve (and cache) the recovered login-shell environment. `None` when
/// recovery failed or is unsupported (Windows) — callers then inherit the
/// daemon env unchanged.
pub fn login_shell_env() -> Option<&'static HashMap<String, String>> {
    CACHE.get_or_init(compute).as_ref()
}

/// Kick off recovery in the background at daemon startup so the first
/// /api/spawn doesn't pay the shell's rc-file startup cost.
pub fn warm() {
    std::thread::spawn(|| {
        let n = login_shell_env().map(|e| e.len());
        match n {
            Some(n) => info!("shell_env: recovered {} vars from login shell", n),
            None => info!("shell_env: recovery unavailable — spawns inherit the daemon env"),
        }
    });
}

fn compute() -> Option<HashMap<String, String>> {
    if cfg!(windows) {
        return None; // different PATH model; the launchd/systemd disease is unix
    }
    let shell = pick_shell()?;
    let out = run_env_dump(&shell, TIMEOUT_MS)?;
    let mut env = parse_delimited_env(&out)?;
    // A usable PATH is the whole point — refuse a dump without one.
    let path = env.get("PATH")?.clone();
    env.insert("PATH".into(), dedup_path(&path));
    debug!("shell_env: recovered via {}", shell);
    Some(env)
}

/// The shell whose rc files own the user's PATH. $SHELL when the daemon has
/// one; under launchd it usually doesn't, so fall back through the common
/// defaults (zsh first — it is the macOS default since Catalina).
fn pick_shell() -> Option<String> {
    if let Ok(sh) = std::env::var("SHELL") {
        if !sh.trim().is_empty() && Path::new(&sh).exists() {
            return Some(sh);
        }
    }
    ["/bin/zsh", "/bin/bash", "/bin/sh"]
        .iter()
        .find(|p| Path::new(p).exists())
        .map(|p| p.to_string())
}

/// `<shell> -lic '<sentinel>; env -0; <sentinel>'` with a hard timeout.
/// stdout is drained on a separate thread while we poll for exit — an env
/// dump can exceed the pipe buffer, and a blocked pipe would deadlock the
/// timeout loop.
fn run_env_dump(shell: &str, timeout_ms: u64) -> Option<Vec<u8>> {
    let script = format!(r#"printf %s "{DELIM}"; env -0; printf %s "{DELIM}""#);
    let mut child = std::process::Command::new(shell)
        .args(["-lic", &script])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;

    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });

    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let out = reader.join().ok()?;
                return status.success().then_some(out);
            }
            Ok(None) => {
                if started.elapsed() >= Duration::from_millis(timeout_ms) {
                    let _ = child.kill();
                    let _ = child.wait();
                    // Do NOT join the reader: a grandchild of the killed shell
                    // (an rc file's `sleep`/spinner) can keep the pipe's write
                    // end open long after the shell is dead, and read_to_end
                    // only returns when the last writer closes. Abandon the
                    // thread — it exits by itself once the pipe drains.
                    debug!("shell_env: {} timed out after {}ms", shell, timeout_ms);
                    return None;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => {
                let _ = child.kill();
                return None;
            }
        }
    }
}

/// Extract the NUL-separated `env -0` dump fenced between the first and last
/// sentinel — anything an rc file printed outside the fence is ignored.
fn parse_delimited_env(out: &[u8]) -> Option<HashMap<String, String>> {
    let delim = DELIM.as_bytes();
    let start = find(out, delim)? + delim.len();
    let end = rfind(out, delim)?;
    if end <= start {
        return None;
    }
    let mut env = HashMap::new();
    for pair in out[start..end].split(|&b| b == 0) {
        if pair.is_empty() {
            continue;
        }
        let Ok(pair) = std::str::from_utf8(pair) else {
            continue;
        };
        let Some(eq) = pair.find('=') else { continue };
        if eq == 0 {
            continue;
        }
        env.insert(pair[..eq].to_string(), pair[eq + 1..].to_string());
    }
    (!env.is_empty()).then_some(env)
}

/// Order-preserving dedup: rc files commonly re-prepend the same directories
/// (`.zshenv`/`.zprofile`/`.zshrc` each adding `~/.bun/bin` again).
fn dedup_path(path: &str) -> String {
    let mut seen = std::collections::HashSet::new();
    path.split(':')
        .filter(|p| !p.is_empty() && seen.insert(p.to_string()))
        .collect::<Vec<_>>()
        .join(":")
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn rfind(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).rposition(|w| w == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dump(inner: &str) -> Vec<u8> {
        format!("{DELIM}{inner}{DELIM}").into_bytes()
    }

    #[test]
    fn parses_a_clean_dump() {
        let env = parse_delimited_env(&dump("PATH=/a:/b\0HOME=/Users/x\0")).unwrap();
        assert_eq!(env["PATH"], "/a:/b");
        assert_eq!(env["HOME"], "/Users/x");
    }

    #[test]
    fn ignores_banner_noise_outside_the_fence() {
        let mut out = b"welcome banner from .zshrc\n".to_vec();
        out.extend_from_slice(&dump("PATH=/a\0"));
        out.extend_from_slice(b"\ntrailing plugin output");
        assert_eq!(parse_delimited_env(&out).unwrap()["PATH"], "/a");
    }

    #[test]
    fn survives_values_with_newlines() {
        let env = parse_delimited_env(&dump("MULTI=line1\nline2\0PATH=/a\0")).unwrap();
        assert_eq!(env["MULTI"], "line1\nline2");
    }

    #[test]
    fn rejects_missing_or_lone_delimiters() {
        assert!(parse_delimited_env(b"no delims at all").is_none());
        assert!(parse_delimited_env(format!("{DELIM}PATH=/a").as_bytes()).is_none());
        assert!(parse_delimited_env(&dump("")).is_none());
    }

    #[test]
    fn dedups_path_preserving_order() {
        assert_eq!(dedup_path("/a:/b:/a:/c:/b"), "/a:/b:/c");
        assert_eq!(dedup_path("/a::/b"), "/a:/b");
    }

    #[cfg(unix)]
    #[test]
    fn recovers_env_through_a_real_shell_pipeline() {
        // A stand-in "shell" that ignores -lic and emits a fenced dump — proves
        // spawn → drain → timeout-poll → parse end to end without depending on
        // the CI user's rc files.
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("fake-shell");
        let mut f = std::fs::File::create(&script).unwrap();
        writeln!(
            f,
            "#!/bin/sh\nprintf %s \"{DELIM}\"; printf 'PATH=/x:/y:/x\\0FOO=bar\\0'; printf %s \"{DELIM}\""
        )
        .unwrap();
        drop(f);
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

        let out = run_env_dump(script.to_str().unwrap(), 5_000).unwrap();
        let mut env = parse_delimited_env(&out).unwrap();
        let path = env.remove("PATH").unwrap();
        assert_eq!(dedup_path(&path), "/x:/y");
        assert_eq!(env["FOO"], "bar");
    }

    #[cfg(unix)]
    #[test]
    fn times_out_a_hung_shell() {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("hung-shell");
        let mut f = std::fs::File::create(&script).unwrap();
        writeln!(f, "#!/bin/sh\nsleep 60").unwrap();
        drop(f);
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let started = Instant::now();
        assert!(run_env_dump(script.to_str().unwrap(), 300).is_none());
        assert!(started.elapsed() < Duration::from_secs(10));
    }
}
