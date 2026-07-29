// Agent lifecycle routes: /api/kill, /api/restart, /api/spawn, /api/spawn-config.
// Ports the corresponding handlers in ts/serve.ts.
//
// Scope note: /api/spawn here covers the PLAIN-cwd spawn. The `from` (clone) and
// `fork` (worktree) paths in the TS daemon delegate to the JS `codehost/provision`
// package and its koho provision hook; there is no Rust equivalent, so those
// requests are refused with 501 and an explanatory message rather than silently
// downgraded to a plain spawn in the wrong directory.

use serde_json::{json, Value};

/// CLIs `/api/spawn` accepts — the same list the runtime validates against, so
/// the console's picker can't offer something the spawn will reject.
pub const SUPPORTED_CLIS: &[&str] = &[
    "claude",
    "glm",
    "openrouter",
    "pi",
    "gemini",
    "codex",
    "copilot",
    "cursor",
    "grok",
    "qwen",
    "auggie",
    "amp",
    "opencode",
    "bash",
    "cmd",
    "powershell",
];

/// Absolute path to an `ay`-equivalent executable.
///
/// A detached daemon (launchd/systemd) has a PATH WITHOUT ~/.bun/bin and
/// ~/.cargo/bin, so a bare "ay" fails with "Executable not found" — the exact
/// error the console used to surface on restart. Prefer this process's own
/// binary (always present, since the daemon IS agent-yes), then PATH.
fn ay_bin() -> Option<std::path::PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        // `ayrs` and `agent-yes` are installed side by side by `cargo install`.
        if let Some(dir) = exe.parent() {
            let sibling = dir.join(if cfg!(windows) { "agent-yes.exe" } else { "agent-yes" });
            if sibling.exists() {
                return Some(sibling);
            }
        }
    }
    which_in_path("ay").or_else(|| which_in_path("agent-yes"))
}

fn which_in_path(name: &str) -> Option<std::path::PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|d| d.join(name)).find(|p| p.is_file())
}

/// Launch a detached, fully orphaned child that outlives this request AND is not
/// in the daemon's process group — a restart must survive the agent it restarts,
/// and a spawned agent must not die with the daemon.
fn spawn_detached(bin: &std::path::Path, args: &[String], cwd: &str) -> std::io::Result<u32> {
    let mut cmd = std::process::Command::new(bin);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // setsid: new session + process group, so a later group-kill of the
        // daemon can't take the agent with it.
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }
    Ok(cmd.spawn()?.id())
}

fn bad(status: u16, msg: impl Into<String>) -> super::api::ApiResponse {
    super::api::ApiResponse {
        status,
        content_type: "text/plain".into(),
        body: super::api::Body::Full(msg.into().into_bytes()),
    }
}

fn ok_json(v: Value) -> super::api::ApiResponse {
    super::api::ApiResponse {
        status: 200,
        content_type: "application/json".into(),
        body: super::api::Body::Full(serde_json::to_vec(&v).unwrap_or_default()),
    }
}

pub fn spawn_config() -> super::api::ApiResponse {
    ok_json(json!({
        // The Rust daemon runs no JS hooks; the console hides those affordances.
        "hasSpawnHook": false,
        "hasProvisionHook": false,
        "clis": SUPPORTED_CLIS,
    }))
}

/// POST /api/kill {keyword} — force-kill an agent and its children.
pub fn kill(body: &str) -> super::api::ApiResponse {
    let Ok(b) = serde_json::from_str::<Value>(body) else {
        return bad(400, "invalid JSON body");
    };
    let Some(keyword) = b.get("keyword").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) else {
        return bad(400, "missing keyword");
    };
    if cfg!(windows) {
        return bad(501, "force-kill unsupported on a Windows serve");
    }
    let rec = match super::api::resolve_one_all(keyword) {
        Ok(r) => r,
        Err(e) => return bad(404, e),
    };
    let mut killed: Vec<String> = Vec::new();
    #[cfg(unix)]
    {
        // Whole process group first (takes the children with it), then the pids
        // directly in case they aren't group leaders.
        let pgid = rec.wrapper_pid.filter(|p| *p > 1).map(|p| unsafe { libc::getpgid(p as i32) });
        if let Some(g) = pgid.filter(|g| *g > 1) {
            if unsafe { libc::kill(-g, libc::SIGKILL) } == 0 {
                killed.push(format!("group {g}"));
            }
        }
        let mut sig = |target: u32, label: String| {
            if target > 1 && unsafe { libc::kill(target as i32, libc::SIGKILL) } == 0 {
                killed.push(label);
            }
        };
        sig(rec.pid, format!("pid {}", rec.pid));
        if let Some(w) = rec.wrapper_pid.filter(|w| *w != rec.pid) {
            sig(w, format!("wrapper {w}"));
        }
    }
    super::api::mark_exited(rec.pid, "force-killed via console");
    ok_json(json!({ "ok": true, "pid": rec.pid, "killed": killed }))
}

/// POST /api/restart {keyword, fresh?} — stop the agent then relaunch it,
/// resuming its session (or `--fresh` to start clean).
///
/// Restart is a multi-second flow (graceful /exit → wait → relaunch) that must
/// OUTLIVE this request and must NOT be a child of the agent it restarts, so it
/// runs as a detached `agent-yes restart` and returns immediately; the console
/// sees the old→new pid swap over /api/ls/subscribe.
pub fn restart(body: &str) -> super::api::ApiResponse {
    let Ok(b) = serde_json::from_str::<Value>(body) else {
        return bad(400, "invalid JSON body");
    };
    let Some(keyword) = b.get("keyword").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) else {
        return bad(400, "missing keyword");
    };
    let rec = match super::api::resolve_one_all(keyword) {
        Ok(r) => r,
        Err(e) => return bad(404, e),
    };
    let Some(bin) = ay_bin() else {
        return bad(500, "cannot locate the agent-yes executable to run the restart");
    };
    let mut args = vec!["restart".to_string(), rec.pid.to_string()];
    if b.get("fresh").and_then(|v| v.as_bool()).unwrap_or(false) {
        args.push("--fresh".into());
    }
    match spawn_detached(&bin, &args, &rec.cwd) {
        Ok(_) => ok_json(json!({ "ok": true, "pid": rec.pid })),
        Err(e) => bad(500, format!("failed to launch restart: {e}")),
    }
}

/// POST /api/spawn {cli, cwd, prompt, yes?} — launch a new agent.
pub fn spawn(body: &str) -> super::api::ApiResponse {
    let Ok(b) = serde_json::from_str::<Value>(body) else {
        return bad(400, "invalid JSON body");
    };
    // A `from`/`fork` request must fail LOUDLY: falling through to the plain-cwd
    // branch would spawn the agent in the wrong directory, which reads as the
    // agent "ignoring" the fork.
    if b.get("fork").map(|v| !v.is_null()).unwrap_or(false)
        || b.get("from").and_then(|v| v.as_str()).map(|s| !s.trim().is_empty()).unwrap_or(false)
    {
        return bad(
            501,
            "provisioned spawns (`from` clone / `fork` worktree) need the JS \
             codehost/provision package and are only available on `ay serve`; \
             spawn into an existing cwd instead",
        );
    }
    let cli = b.get("cli").and_then(|v| v.as_str()).unwrap_or("claude").to_string();
    if !SUPPORTED_CLIS.contains(&cli.as_str()) {
        return bad(400, format!("unsupported cli: {cli}"));
    }
    let prompt = b.get("prompt").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let cwd = b.get("cwd").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if cwd.is_empty() {
        return bad(400, "missing cwd");
    }
    // mkdir -p so a not-yet-created workspace folder doesn't ENOENT the spawn.
    if let Err(e) = std::fs::create_dir_all(&cwd) {
        return bad(400, format!("cannot create cwd {cwd}: {e}"));
    }
    let Some(bin) = ay_bin() else {
        return bad(500, "cannot locate the agent-yes executable to spawn an agent");
    };
    let mut args = vec![format!("--cli={cli}")];
    if b.get("yes").and_then(|v| v.as_bool()).unwrap_or(false) {
        args.push("--yes".into());
    }
    if !prompt.is_empty() {
        // `--` so a prompt starting with a dash isn't parsed as a flag.
        args.push("--".into());
        args.push(prompt);
    }
    match spawn_detached(&bin, &args, &cwd) {
        Ok(pid) => ok_json(json!({ "ok": true, "pid": pid, "cli": cli, "cwd": cwd })),
        Err(e) => bad(500, format!("failed to spawn: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kill_rejects_a_bad_body() {
        assert_eq!(kill("not json").status, 400);
        assert_eq!(kill("{}").status, 400);
        assert_eq!(kill(r#"{"keyword":""}"#).status, 400);
    }

    #[test]
    fn restart_rejects_a_bad_body() {
        assert_eq!(restart("{").status, 400);
        assert_eq!(restart("{}").status, 400);
    }

    #[test]
    fn spawn_rejects_unknown_cli_and_missing_cwd() {
        assert_eq!(spawn(r#"{"cli":"nope","cwd":"/tmp"}"#).status, 400);
        assert_eq!(spawn(r#"{"cli":"claude"}"#).status, 400);
    }

    #[test]
    fn spawn_refuses_provisioned_requests_instead_of_silently_downgrading() {
        assert_eq!(spawn(r#"{"cli":"claude","cwd":"/tmp","from":"o/r"}"#).status, 501);
        assert_eq!(
            spawn(r#"{"cli":"claude","cwd":"/tmp","fork":{"fromCwd":"/a","branch":"b"}}"#).status,
            501
        );
    }

    #[test]
    fn spawn_config_lists_the_supported_clis() {
        let super::super::api::Body::Full(b) = spawn_config().body else { panic!("not full") };
        let v: Value = serde_json::from_slice(&b).unwrap();
        assert!(v["clis"].as_array().unwrap().iter().any(|c| c == "claude"));
    }
}
