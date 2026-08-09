// Workspace routes + provisioning for the Rust daemon — a native port of the
// TS /api/ws* handlers (ts/ws.ts + ts/serve.ts) so the console's /ws browser
// and the New-agent form's repo/branch combobox work on `ayrs serve` too.
//
// Scope vs the TS daemon: the JS codehost/provision package additionally runs a
// repo's setup script after cloning; this native path is a plain `git clone`
// (or `git worktree add` for forks) into the standard layout
// `<wsRoot>/<owner>/<repo>/tree/<branch>` — no setup-repo.sh. The same
// admission gates apply: the koho provision hook when configured (its exit
// code decides), otherwise the provisionAllowlist (empty = deny all).

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub const WS_JSON_SCHEMA: &str = "ay-ws/v1";
// Branch names may contain `/`, so the walk below `tree/` is recursive; this
// bounds a pathological/looping layout, not a legitimate branch depth.
const MAX_BRANCH_DEPTH: usize = 8;

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

fn expand_tilde(s: &str) -> PathBuf {
    if let Some(rest) = s.strip_prefix("~/") {
        return home().join(rest);
    }
    if s == "~" {
        return home();
    }
    PathBuf::from(s)
}

/// ~/.agent-yes/config.json with the TS tamper guard: a symlinked, other-owned,
/// or group/world-writable config must not feed a hook we will execute.
fn read_config() -> Value {
    let p = home().join(".agent-yes").join("config.json");
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let Ok(md) = std::fs::symlink_metadata(&p) else {
            return json!({});
        };
        if md.file_type().is_symlink()
            || md.uid() != unsafe { libc::getuid() }
            || md.mode() & 0o022 != 0
        {
            return json!({});
        }
    }
    std::fs::read_to_string(&p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}))
}

/// Workspace root: CODEHOST_WS_ROOT > config provisionRoot > ~/ws (the same
/// chain ts/workspaceConfig.ts getProvisionRoot + provision's resolveWsRoot use).
pub fn ws_root() -> PathBuf {
    if let Ok(env) = std::env::var("CODEHOST_WS_ROOT") {
        let env = env.trim();
        if !env.is_empty() {
            return expand_tilde(env);
        }
    }
    if let Some(r) = read_config().get("provisionRoot").and_then(|v| v.as_str()) {
        if !r.trim().is_empty() {
            return expand_tilde(r.trim());
        }
    }
    home().join("ws")
}

fn provision_hook() -> Option<String> {
    if let Ok(h) = std::env::var("AGENT_YES_PROVISION_HOOK") {
        if !h.trim().is_empty() {
            return Some(h);
        }
    }
    read_config()
        .get("provisionHook")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(String::from)
}

/// Whether a koho provision hook is configured (read-only disclosure).
pub fn has_provision_hook() -> bool {
    provision_hook().is_some()
}

/// Owner/repo allowlist — empty means DENY ALL (provisioning fetches and runs
/// third-party code paths on this host). `*` = allow all, `<owner>` = any repo
/// of that owner, `<owner>/<repo>` = exact. CODEHOST_PROVISION_ALLOWLIST
/// (comma-separated) overrides the config, mirroring the TS daemon.
pub fn is_provision_allowed(owner: &str, repo: &str) -> bool {
    let list: Vec<String> = match std::env::var("CODEHOST_PROVISION_ALLOWLIST") {
        Ok(env) if !env.trim().is_empty() => env.split(',').map(String::from).collect(),
        _ => read_config()
            .get("provisionAllowlist")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default(),
    };
    let list: Vec<String> = list
        .iter()
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    if list.iter().any(|e| e == "*") {
        return true;
    }
    let o = owner.to_lowercase();
    let full = format!("{}/{}", owner, repo).to_lowercase();
    list.iter()
        .any(|e| e.trim_end_matches("/*") == o || *e == full)
}

// ---- child processes with a deadline ---------------------------------------

pub struct Capture {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
}

/// Run a command under the recovered login-shell env (a launchd daemon's bare
/// PATH has no git/gh) and capture its output with a hard deadline. Per the
/// repo rule, the timeout path NEVER joins the reader threads — a grandchild
/// holding the pipe write end would hang the join; abandoned readers exit by
/// themselves once the last writer closes.
pub fn run_capture(mut cmd: Command, timeout: Duration) -> Capture {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(env) = super::shell_env::login_shell_env() {
        for (k, v) in env {
            cmd.env(k, v);
        }
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return Capture {
                ok: false,
                stdout: String::new(),
                stderr: e.to_string(),
            }
        }
    };
    let read_bg = |pipe: Option<Box<dyn std::io::Read + Send>>| {
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        if let Some(mut p) = pipe {
            std::thread::spawn(move || {
                let mut s = String::new();
                use std::io::Read;
                let _ = p.read_to_string(&mut s);
                let _ = tx.send(s);
            });
        }
        rx
    };
    let rx_out = read_bg(child.stdout.take().map(|p| Box::new(p) as _));
    let rx_err = read_bg(child.stderr.take().map(|p| Box::new(p) as _));
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break Some(st),
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => break None,
        }
    };
    let grab = |rx: std::sync::mpsc::Receiver<String>| {
        rx.recv_timeout(Duration::from_secs(2)).unwrap_or_default()
    };
    match status {
        Some(st) => Capture {
            ok: st.success(),
            stdout: grab(rx_out),
            stderr: grab(rx_err),
        },
        None => Capture {
            ok: false,
            stdout: String::new(),
            stderr: format!("timed out after {}s", timeout.as_secs()),
        },
    }
}

fn git(args: &[&str], cwd: Option<&Path>, timeout: Duration) -> Capture {
    let mut c = Command::new("git");
    c.args(args);
    if let Some(d) = cwd {
        c.current_dir(d);
    }
    run_capture(c, timeout)
}

// ---- provision hook (koho) --------------------------------------------------

pub enum HookResult {
    NotConfigured,
    Allowed,
    Denied(String),
}

/// Run the koho-style provision hook when configured — it prepares the host
/// (typically `gh auth switch` keyed on KOHO_OWNER) and its exit code IS the
/// admission decision, overriding the allowlist. Mirrors runProvisionHook in
/// ts/serve.ts (set -e, 60s default timeout, login-shell env).
pub fn run_provision_hook(cwd: &Path, koho: &[(&str, &str)]) -> HookResult {
    let Some(hook) = provision_hook() else {
        return HookResult::NotConfigured;
    };
    let shell = std::env::var("AGENT_YES_PROVISION_SHELL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            std::env::var("AGENT_YES_SPAWN_SHELL")
                .ok()
                .filter(|s| !s.trim().is_empty())
        })
        .unwrap_or_else(|| "/bin/sh".into());
    let timeout_ms = std::env::var("AGENT_YES_PROVISION_HOOK_TIMEOUT_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(60_000);
    let mut cmd = Command::new(shell);
    cmd.arg("-c")
        .arg(format!("set -e\n{hook}"))
        .current_dir(cwd);
    for (k, v) in koho {
        cmd.env(k, v);
    }
    let r = run_capture(cmd, Duration::from_millis(timeout_ms));
    if r.ok {
        HookResult::Allowed
    } else {
        let detail = format!("{}\n{}", r.stdout, r.stderr);
        HookResult::Denied(detail.trim().chars().take(4096).collect())
    }
}

// ---- workspace walk ---------------------------------------------------------

/// True when `dir` is a git checkout root (`.git` file = linked worktree, dir = clone).
fn is_checkout_root(dir: &Path) -> bool {
    dir.join(".git").exists()
}

// Real subdirectories only — no symlinks (a link cycle under tree/ must not
// loop the walk), no dotdirs.
fn subdirs(dir: &Path) -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(dir) else {
        return out;
    };
    for ent in rd.flatten() {
        let name = ent.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let Ok(ft) = ent.file_type() else { continue };
        if ft.is_symlink() || !ft.is_dir() {
            continue;
        }
        out.push((name, ent.path()));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

pub struct WsEntry {
    pub owner: String,
    pub repo: String,
    pub branch: String,
    pub path: PathBuf,
}

/// Walk `<wsRoot>/<owner>/<repo>/tree/**` collecting checkout roots; below
/// `tree/` descend until a `.git` marker (branch names may contain `/`).
pub fn walk_workspaces(root: &Path) -> Vec<WsEntry> {
    fn walk_branches(dir: &Path, owner: &str, repo: &str, segs: &[String], out: &mut Vec<WsEntry>) {
        if segs.len() > MAX_BRANCH_DEPTH {
            return;
        }
        for (name, p) in subdirs(dir) {
            let mut branch_segs = segs.to_vec();
            branch_segs.push(name);
            if is_checkout_root(&p) {
                out.push(WsEntry {
                    owner: owner.into(),
                    repo: repo.into(),
                    branch: branch_segs.join("/"),
                    path: p,
                });
            } else {
                walk_branches(&p, owner, repo, &branch_segs, out);
            }
        }
    }
    let mut found = Vec::new();
    for (owner, od) in subdirs(root) {
        for (repo, rd) in subdirs(&od) {
            let tree = rd.join("tree");
            if tree.is_dir() {
                walk_branches(&tree, &owner, &repo, &[], &mut found);
            }
        }
    }
    found
}

/// Segment-boundary path containment (parity with ts/ws.ts isPathInside).
pub fn is_path_inside(parent: &Path, child: &Path) -> bool {
    let p = parent.components().collect::<Vec<_>>();
    let c = child.components().collect::<Vec<_>>();
    c.len() >= p.len() && c[..p.len()] == p[..]
}

fn live_agents_in(records: &[crate::pid_store::PidRecord], ws_path: &Path) -> usize {
    records
        .iter()
        .filter(|r| r.exit_code.is_none() && !r.cwd.is_empty())
        .filter(|r| is_path_inside(ws_path, Path::new(&r.cwd)))
        .count()
}

// ---- git status -------------------------------------------------------------

/// One `git status --porcelain=v2 --branch` call → the TS GitStatus shape
/// (branch, short head, ahead/behind, dirty, hasUpstream).
pub fn git_status(dir: &Path) -> Result<Value, String> {
    let r = git(
        &["status", "--porcelain=v2", "--branch"],
        Some(dir),
        Duration::from_secs(20),
    );
    if !r.ok {
        return Err(r.stderr.trim().chars().take(200).collect());
    }
    let (mut branch, mut head, mut ahead, mut behind) = (String::new(), String::new(), 0i64, 0i64);
    let mut has_upstream = false;
    let mut dirty = false;
    for line in r.stdout.lines() {
        if let Some(rest) = line.strip_prefix("# branch.head ") {
            branch = rest.trim().to_string();
        } else if let Some(rest) = line.strip_prefix("# branch.oid ") {
            head = rest.trim().chars().take(7).collect();
        } else if line.starts_with("# branch.upstream ") {
            has_upstream = true;
        } else if let Some(rest) = line.strip_prefix("# branch.ab ") {
            for part in rest.split_whitespace() {
                if let Some(n) = part.strip_prefix('+') {
                    ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = part.strip_prefix('-') {
                    behind = n.parse().unwrap_or(0);
                }
            }
        } else if !line.starts_with('#') && !line.trim().is_empty() {
            dirty = true;
        }
    }
    Ok(json!({
        "branch": branch, "head": head, "ahead": ahead, "behind": behind,
        "dirty": dirty, "hasUpstream": has_upstream,
    }))
}

// ---- route payloads ---------------------------------------------------------

/// GET /api/ws — every workspace with its live-agent count (no git; per-entry
/// git state is fetched lazily via /api/ws/status, exactly like the TS daemon).
pub fn ls_json(records: &[crate::pid_store::PidRecord]) -> Value {
    let root = ws_root();
    let workspaces: Vec<Value> = walk_workspaces(&root)
        .into_iter()
        .map(|w| {
            json!({
                "owner": w.owner, "repo": w.repo, "branch": w.branch,
                "path": w.path.to_string_lossy(),
                "agents": { "live": live_agents_in(records, &w.path) },
            })
        })
        .collect();
    json!({ "schema": WS_JSON_SCHEMA, "wsRoot": root.to_string_lossy(), "workspaces": workspaces })
}

/// GET /api/ws/status?path= — one workspace's git state + live-agent count.
/// The path must sit inside the workspace root (a share-token client must not
/// probe arbitrary host paths).
pub fn status_json(
    records: &[crate::pid_store::PidRecord],
    dir_raw: &str,
) -> Result<Value, (u16, String)> {
    let root = ws_root();
    let dir = PathBuf::from(dir_raw);
    // resolve symlinks/.. the cheap way: canonicalize both sides when possible
    let canon = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    if !is_path_inside(&canon(&root), &canon(&dir)) {
        return Err((
            400,
            format!("path is outside the workspace root {}", root.display()),
        ));
    }
    if !dir.join(".git").exists() {
        return Err((
            404,
            format!("not a workspace checkout (no .git): {}", dir.display()),
        ));
    }
    let git = git_status(&dir).map_err(|e| (502, format!("git status failed: {e}")))?;
    // back-derive owner/repo/branch from the layout, best-effort
    let rel: Vec<String> = dir
        .strip_prefix(&root)
        .map(|r| {
            r.components()
                .map(|c| c.as_os_str().to_string_lossy().to_string())
                .collect()
        })
        .unwrap_or_default();
    let (owner, repo, branch) = if rel.len() >= 4 && rel[2] == "tree" {
        (rel[0].clone(), rel[1].clone(), rel[3..].join("/"))
    } else {
        (
            String::new(),
            String::new(),
            git["branch"].as_str().unwrap_or("").to_string(),
        )
    };
    Ok(json!({
        "schema": WS_JSON_SCHEMA,
        "workspace": {
            "owner": owner, "repo": repo, "branch": branch,
            "path": dir.to_string_lossy(),
            "agents": { "live": live_agents_in(records, &dir) },
            "git": git,
        }
    }))
}

// 60s memo for the gh side of /api/ws/repos — `gh repo list` is a network call
// and the console hits this endpoint on every form open / host switch.
static GH_REPOS_MEMO: std::sync::Mutex<Option<(Instant, bool, Vec<String>, String)>> =
    std::sync::Mutex::new(None);

/// GET /api/ws/repos — repos this host can provision from: everything already
/// under the workspace layout (with its provisioned branches) plus, best-effort,
/// what `gh repo list` can see. gh being missing/unauthenticated never fails
/// the endpoint — the UI gets gh.ok=false and still renders the local repos.
pub fn repos_json() -> Value {
    let root = ws_root();
    let mut order: Vec<String> = Vec::new();
    let mut by_repo: std::collections::HashMap<String, (String, String, bool, Vec<Value>)> =
        std::collections::HashMap::new();
    for w in walk_workspaces(&root) {
        let key = format!("{}/{}", w.owner, w.repo);
        let e = by_repo.entry(key.clone()).or_insert_with(|| {
            order.push(key);
            (w.owner.clone(), w.repo.clone(), true, Vec::new())
        });
        e.3.push(json!({ "name": w.branch, "path": w.path.to_string_lossy() }));
    }
    let (gh_ok, gh_repos, gh_error) = {
        let memo = GH_REPOS_MEMO.lock().ok().and_then(|g| (*g).clone());
        match memo {
            Some((t, ok, repos, err)) if t.elapsed() < Duration::from_secs(60) => (ok, repos, err),
            _ => {
                let mut c = Command::new("gh");
                c.args(["repo", "list", "--limit", "200", "--json", "nameWithOwner"]);
                let r = run_capture(c, Duration::from_secs(10));
                let (ok, repos, err) = if r.ok {
                    match serde_json::from_str::<Vec<Value>>(&r.stdout) {
                        Ok(list) => (
                            true,
                            list.iter()
                                .filter_map(|v| v["nameWithOwner"].as_str().map(String::from))
                                .collect(),
                            String::new(),
                        ),
                        Err(_) => (false, Vec::new(), "gh returned unparseable JSON".into()),
                    }
                } else {
                    let e = r.stderr.trim().chars().take(200).collect::<String>();
                    (
                        false,
                        Vec::new(),
                        if e.is_empty() {
                            "gh unavailable".into()
                        } else {
                            e
                        },
                    )
                };
                if let Ok(mut g) = GH_REPOS_MEMO.lock() {
                    *g = Some((Instant::now(), ok, repos.clone(), err.clone()));
                }
                (ok, repos, err)
            }
        }
    };
    for full in &gh_repos {
        if by_repo.contains_key(full) {
            continue;
        }
        if let Some((owner, repo)) = full.split_once('/') {
            order.push(full.clone());
            by_repo.insert(full.clone(), (owner.into(), repo.into(), false, Vec::new()));
        }
    }
    // provisioned repos first, then alphabetical — the picker's natural order
    order.sort_by_key(|k| {
        let local = by_repo.get(k).map(|e| e.2).unwrap_or(false);
        (!local, k.to_lowercase())
    });
    order.dedup();
    let repos: Vec<Value> = order
        .iter()
        .filter_map(|k| by_repo.get(k))
        .map(|(owner, repo, local, branches)| {
            json!({ "owner": owner, "repo": repo, "local": local, "branches": branches })
        })
        .collect();
    let gh = if gh_error.is_empty() {
        json!({ "ok": gh_ok })
    } else {
        json!({ "ok": gh_ok, "error": gh_error })
    };
    json!({ "schema": WS_JSON_SCHEMA, "wsRoot": root.to_string_lossy(), "repos": repos, "gh": gh })
}

fn valid_repo_segment(s: &str) -> bool {
    !s.is_empty()
        && s != "."
        && s != ".."
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
}

/// GET /api/ws/branches?repo=<owner>/<repo> — remote branches via
/// `git ls-remote --heads origin` from an existing local checkout (uses that
/// checkout's credentials), falling back to `gh api`, merged with provisioned
/// local branches. The repo param is strictly validated and passed as argv.
pub fn branches_json(repo_param: &str) -> Result<Value, (u16, String)> {
    let Some((owner, repo)) = repo_param.split_once('/') else {
        return Err((400, "missing/invalid ?repo=<owner>/<repo>".into()));
    };
    if !valid_repo_segment(owner) || !valid_repo_segment(repo) {
        return Err((400, "missing/invalid ?repo=<owner>/<repo>".into()));
    }
    let root = ws_root();
    let mut local: Vec<(String, PathBuf)> = walk_workspaces(&root)
        .into_iter()
        .filter(|w| w.owner == owner && w.repo == repo)
        .map(|w| (w.branch, w.path))
        .collect();
    local.sort();
    let mut remote: Vec<String> = Vec::new();
    let mut source = "";
    let mut error = String::new();
    if let Some((_, anchor)) = local.first() {
        let r = git(
            &["ls-remote", "--heads", "origin"],
            Some(anchor),
            Duration::from_secs(15),
        );
        if r.ok {
            remote = r
                .stdout
                .lines()
                .filter_map(|l| l.split("\trefs/heads/").nth(1))
                .map(|s| s.trim().to_string())
                .collect();
            source = "ls-remote";
        } else {
            error = r.stderr.trim().chars().take(200).collect();
        }
    }
    if source.is_empty() {
        let mut c = Command::new("gh");
        c.args([
            "api",
            &format!("repos/{owner}/{repo}/branches"),
            "--paginate",
            "--jq",
            ".[].name",
        ]);
        let r = run_capture(c, Duration::from_secs(15));
        if r.ok {
            remote = r
                .stdout
                .lines()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            source = "gh";
            error.clear();
        } else if error.is_empty() {
            error = r.stderr.trim().chars().take(200).collect();
            if error.is_empty() {
                error = "gh unavailable".into();
            }
        }
    }
    let mut names: Vec<String> = remote.clone();
    names.extend(local.iter().map(|(b, _)| b.clone()));
    names.sort();
    names.dedup();
    let branches: Vec<Value> = names
        .iter()
        .map(|name| {
            let path = local.iter().find(|(b, _)| b == name).map(|(_, p)| p);
            let mut o = json!({
                "name": name,
                "remote": remote.contains(name),
                "provisioned": path.is_some(),
            });
            if let Some(p) = path {
                o["path"] = json!(p.to_string_lossy());
            }
            o
        })
        .collect();
    let mut out = json!({
        "schema": WS_JSON_SCHEMA,
        "repo": format!("{owner}/{repo}"),
        "source": if source.is_empty() { "local-only" } else { source },
        "branches": branches,
    });
    if !error.is_empty() {
        out["error"] = json!(error);
    }
    Ok(out)
}

// ---- provisioning (spawn `from` / `fork`) -----------------------------------

pub struct Provisioned {
    pub folder: PathBuf,
    pub action: String,
}

pub struct GitSource {
    pub url: String,
    pub owner: String,
    pub repo: String,
    /// branch embedded in the source (github /tree/<branch> or @branch specs)
    pub branch: String,
}

/// Parse a spawn `from` source: bare owner/repo[@branch] and github URLs are
/// github-first (clone via https://github.com/…, credentials from gh's
/// credential helper); any other scheme/host is a raw git URL. None = not a
/// recognizable source (the caller 400s).
pub fn parse_source(s: &str) -> Option<GitSource> {
    let s = s.trim().trim_end_matches('/');
    // owner/repo[@branch]
    let bare = regex::Regex::new(r"^([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)(?:@(\S+))?$").ok()?;
    if let Some(m) = bare.captures(s) {
        let (owner, repo) = (m[1].to_string(), m[2].to_string());
        if valid_repo_segment(&owner) && valid_repo_segment(&repo) {
            return Some(GitSource {
                url: format!("https://github.com/{owner}/{repo}.git"),
                owner,
                repo,
                branch: m.get(3).map(|b| b.as_str().to_string()).unwrap_or_default(),
            });
        }
        return None;
    }
    // github URLs (repo root, /tree/<branch>, .git, git@)
    let gh_url = regex::Regex::new(
        r"^https?://github\.com/([^/\s]+)/([^/\s]+?)(?:\.git)?(?:/tree/([^\s?#]+))?$",
    )
    .ok()?;
    if let Some(m) = gh_url.captures(s) {
        let (owner, repo) = (m[1].to_string(), m[2].to_string());
        return Some(GitSource {
            url: format!("https://github.com/{owner}/{repo}.git"),
            owner,
            repo,
            branch: m.get(3).map(|b| b.as_str().to_string()).unwrap_or_default(),
        });
    }
    let gh_scp = regex::Regex::new(r"^git@github\.com:([^/\s]+)/([^/\s]+?)(?:\.git)?$").ok()?;
    if let Some(m) = gh_scp.captures(s) {
        let (owner, repo) = (m[1].to_string(), m[2].to_string());
        return Some(GitSource {
            url: format!("https://github.com/{owner}/{repo}.git"),
            owner,
            repo,
            branch: String::new(),
        });
    }
    // any other git URL: scp-style or ssh/git/http(s) scheme; owner/repo from
    // the last two path segments so the checkout lands in the standard layout
    let raw =
        regex::Regex::new(r"^(?:git@[^:/\s]+:|(?:ssh|git|https?)://[^/\s]+/)(\S+?)(?:\.git)?$")
            .ok()?;
    let m = raw.captures(s)?;
    let segs: Vec<&str> = m[1].split('/').filter(|p| !p.is_empty()).collect();
    if segs.len() < 2 {
        return None;
    }
    let owner = segs[segs.len() - 2].to_string();
    let repo = segs[segs.len() - 1].trim_end_matches(".git").to_string();
    if !valid_repo_segment(&owner) || !valid_repo_segment(&repo) {
        return None;
    }
    Some(GitSource {
        url: s.to_string(),
        owner,
        repo,
        branch: String::new(),
    })
}

/// A branch name that lands in a filesystem path (tree/<branch>) — no empty,
/// `.`, `..` segments, no option-looking names.
pub fn bad_branch(b: &str) -> bool {
    b.starts_with('-') || b.split('/').any(|s| s.is_empty() || s == "." || s == "..")
}

/// Clone `src` into `<wsRoot>/<owner>/<repo>/tree/<branch>` (reusing an
/// existing checkout). `create` = branch off the default when the named branch
/// doesn't exist on the remote (`ay ws new --create` semantics).
pub fn provision_clone(
    src: &GitSource,
    branch: &str,
    create: bool,
) -> Result<Provisioned, (u16, String)> {
    if !branch.is_empty() && bad_branch(branch) {
        return Err((400, format!("invalid branch name: {branch}")));
    }
    let base = ws_root().join(&src.owner).join(&src.repo).join("tree");
    let dest_for = |b: &str| base.join(b);
    if !branch.is_empty() && dest_for(branch).join(".git").exists() {
        return Ok(Provisioned {
            folder: dest_for(branch),
            action: "existing".into(),
        });
    }
    std::fs::create_dir_all(&base)
        .map_err(|e| (500, format!("cannot create {}: {e}", base.display())))?;
    let tmp = base.join(format!(
        ".clone-{}-{:x}",
        std::process::id(),
        Instant::now().elapsed().as_nanos() as u64 ^ 0x5eed
    ));
    let clone_to = |extra: &[&str]| {
        let mut args: Vec<&str> = vec!["clone"];
        args.extend(extra);
        args.push("--");
        args.push(&src.url);
        let tmp_s = tmp.to_string_lossy().to_string();
        let mut owned_args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        owned_args.push(tmp_s);
        let mut c = Command::new("git");
        c.args(&owned_args);
        run_capture(c, Duration::from_secs(300))
    };
    let mut created = false;
    let mut r = if branch.is_empty() {
        clone_to(&[])
    } else {
        clone_to(&["--branch", branch])
    };
    if !r.ok && !branch.is_empty() && create {
        // branch may not exist yet — clone the default and branch off it
        let _ = std::fs::remove_dir_all(&tmp);
        r = clone_to(&[]);
        if r.ok {
            let co = git(
                &["checkout", "-b", branch],
                Some(&tmp),
                Duration::from_secs(20),
            );
            if co.ok {
                created = true;
            } else {
                r = co;
            }
        }
    }
    if !r.ok {
        let _ = std::fs::remove_dir_all(&tmp);
        let mut msg: String = r.stderr.trim().chars().take(500).collect();
        if msg.is_empty() {
            msg = "unknown".into();
        }
        if !branch.is_empty() && !create {
            msg.push_str("\n(if the branch doesn't exist yet, retry with create:true)");
        }
        return Err((502, format!("git clone failed: {msg}")));
    }
    let actual = if branch.is_empty() {
        let head = git(
            &["rev-parse", "--abbrev-ref", "HEAD"],
            Some(&tmp),
            Duration::from_secs(10),
        );
        let b = head.stdout.trim().to_string();
        if b.is_empty() || bad_branch(&b) {
            "main".to_string()
        } else {
            b
        }
    } else {
        branch.to_string()
    };
    let dest = dest_for(&actual);
    if dest.exists() {
        // raced/already there — keep the existing checkout, drop ours
        let _ = std::fs::remove_dir_all(&tmp);
    } else {
        if let Some(parent) = dest.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::rename(&tmp, &dest).map_err(|e| {
            let _ = std::fs::remove_dir_all(&tmp);
            (
                500,
                format!("cannot place checkout at {}: {e}", dest.display()),
            )
        })?;
    }
    Ok(Provisioned {
        folder: dest,
        action: if created {
            "cloned+new-branch".into()
        } else {
            "cloned".into()
        },
    })
}

/// Owner/repo from a checkout's github origin remote (for the fork gate).
pub fn origin_owner_repo(cwd: &Path) -> Option<(String, String)> {
    let r = git(
        &["remote", "get-url", "origin"],
        Some(cwd),
        Duration::from_secs(10),
    );
    if !r.ok {
        return None;
    }
    let re = regex::Regex::new(r"github\.com[:/]([^/\s]+)/(.+?)(?:\.git)?/?$").ok()?;
    let m = re.captures(r.stdout.trim())?;
    Some((m[1].to_string(), m[2].to_string()))
}

/// Fork = sibling linked worktree off the source checkout's HEAD on a new
/// branch, placed in the standard layout. No clone, committed work only.
pub fn fork_worktree(from_cwd: &Path, branch: &str) -> Result<Provisioned, (u16, String)> {
    if bad_branch(branch) {
        return Err((400, format!("invalid branch name: {branch}")));
    }
    if !from_cwd.join(".git").exists() {
        return Err((400, format!("not a git checkout: {}", from_cwd.display())));
    }
    let (owner, repo) = origin_owner_repo(from_cwd)
        .ok_or((400, "fork source has no github origin remote".to_string()))?;
    let dest = ws_root().join(&owner).join(&repo).join("tree").join(branch);
    if dest.join(".git").exists() {
        return Ok(Provisioned {
            folder: dest,
            action: "existing".into(),
        });
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| (500, format!("cannot create {}: {e}", parent.display())))?;
    }
    let dest_s = dest.to_string_lossy().to_string();
    let r = git(
        &["worktree", "add", "-b", branch, &dest_s],
        Some(from_cwd),
        Duration::from_secs(60),
    );
    if !r.ok {
        return Err((
            502,
            format!(
                "fork failed: {}",
                r.stderr.trim().chars().take(500).collect::<String>()
            ),
        ));
    }
    Ok(Provisioned {
        folder: dest,
        action: "forked".into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_source_github_first() {
        let s = parse_source("acme/tools").unwrap();
        assert_eq!(s.url, "https://github.com/acme/tools.git");
        assert_eq!(
            (s.owner.as_str(), s.repo.as_str(), s.branch.as_str()),
            ("acme", "tools", "")
        );
        let s = parse_source("acme/tools@dev").unwrap();
        assert_eq!(s.branch, "dev");
        let s = parse_source("https://github.com/acme/tools/tree/feat/x").unwrap();
        assert_eq!(s.branch, "feat/x");
        assert_eq!(s.url, "https://github.com/acme/tools.git");
        let s = parse_source("git@github.com:acme/tools.git").unwrap();
        assert_eq!(s.url, "https://github.com/acme/tools.git");
    }

    #[test]
    fn parse_source_raw_git_urls() {
        let s = parse_source("git@gitlab.com:acme/tools.git").unwrap();
        assert_eq!(s.url, "git@gitlab.com:acme/tools.git");
        assert_eq!((s.owner.as_str(), s.repo.as_str()), ("acme", "tools"));
        let s = parse_source("https://gitlab.com/org/group/proj.git").unwrap();
        assert_eq!((s.owner.as_str(), s.repo.as_str()), ("group", "proj"));
        assert!(parse_source("https://gitlab.com/tools").is_none());
        assert!(parse_source("not a source").is_none());
        assert!(parse_source("../evil").is_none());
    }

    #[test]
    fn branch_validation_rejects_traversal() {
        assert!(bad_branch("../up"));
        assert!(bad_branch("a//b"));
        assert!(bad_branch("-rf"));
        assert!(!bad_branch("feat/x"));
    }

    #[test]
    fn path_inside_is_segment_based() {
        assert!(is_path_inside(Path::new("/a/b"), Path::new("/a/b/c")));
        assert!(!is_path_inside(Path::new("/a/b"), Path::new("/a/bc")));
    }
}
