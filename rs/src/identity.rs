//! The standardized agent identity string:
//!
//! ```text
//! <username>@<hostname>:<path>:<branch>#<pid>
//! e.g.  sno@Mac:~/ws/symval/symval/tree/crm:main#30402
//! ```
//!
//! Rust mirror of `ts/identity.ts`. One line answers "who is this agent" across
//! every surface that names one — the `ay send` envelope header, `ay whoami`,
//! logs, and (since this module landed) the `<ay-init-msg>` header the wrapper
//! puts on a sub-agent's initial prompt. The branch segment usually carries the
//! lane name for free (worktree checkouts like `crm-yamamoto-wifi` or
//! `fix/t173-tone-core` name their purpose), which is why there is no separate
//! role concept.
//!
//! Both runtimes build `<ay-init-msg>` and are held byte-identical by
//! `tests/fixtures/ay-init-msg.golden.txt`, so this file must track
//! `ts/identity.ts` exactly. The shared case table in
//! `tests/fixtures/identity-cases.json` is asserted by BOTH runtimes
//! (`identity::tests::matches_the_shared_case_table` here,
//! `ts/identity.spec.ts` there) so the two copies cannot drift silently — the
//! same guard `<ay-init-msg>` itself relies on.
//!
//! Parsing (right-to-left, for consumers that need it): `#<pid>` from the end;
//! the branch is after the last `:` (git forbids `:` in ref names); the username
//! is before the first `@`; the hostname is between that `@` and the next `:`
//! (hostnames contain no `:`). The path in the middle may itself contain `@`/`:`
//! (Windows drives), which is why parsing anchors on the ends.
//!
//! Every token is clamped before rendering: the identity is embedded in an
//! envelope OPEN tag, which is not nonce-protected — whitespace or `>` in a
//! token could forge header structure.

use std::path::{Path, PathBuf};

/// Replace anything outside a conservative charset so a token can never break
/// out of the envelope header line. Collapses runs to a single `-`.
/// Mirrors TS `safeToken`.
fn safe_token(raw: &str, max: usize) -> String {
    let cleaned = collapse_outside(raw, |c| {
        c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')
    });
    truncate_chars(trim_dashes(&cleaned), max)
}

/// Branch names never contain `:`/space/`~`/`^` (git forbids them), but they DO
/// allow `/` and `#` — keep `/` (readable, unambiguous: parsing anchors on
/// `#<pid>` at the end) and clamp everything else defensively.
/// Mirrors TS `safeBranch`.
fn safe_branch(raw: &str) -> String {
    let cleaned = collapse_outside(raw, |c| {
        c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '#' | '-')
    });
    truncate_chars(trim_dashes(&cleaned), 64)
}

/// `raw.replace(/[^…]+/g, "-")` — every RUN of disallowed characters becomes a
/// single `-`, matching the JS regex's `+` quantifier (not one `-` per char).
fn collapse_outside(raw: &str, allowed: impl Fn(char) -> bool) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut in_run = false;
    for ch in raw.chars() {
        if allowed(ch) {
            out.push(ch);
            in_run = false;
        } else if !in_run {
            out.push('-');
            in_run = true;
        }
    }
    out
}

/// `.replace(/^-+|-+$/g, "")`.
fn trim_dashes(s: &str) -> &str {
    s.trim_matches('-')
}

/// `.slice(0, max)`. JS slices UTF-16 code units, but every character that
/// survives the clamps above is ASCII, so a char-count truncation is identical
/// and cannot split a multi-byte boundary.
fn truncate_chars(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// The local username, header-safe ("John Smith" → "John-Smith").
/// Mirrors TS `localUser` (`os.userInfo().username`).
pub fn local_user() -> String {
    let raw = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .or_else(|_| std::env::var("LOGNAME"))
        .unwrap_or_default();
    let cleaned = safe_token(&raw, 32);
    if cleaned.is_empty() {
        "unknown".to_string()
    } else {
        cleaned
    }
}

/// The local hostname's first label ("Macs-MBP.local" → "Macs-MBP").
/// Mirrors TS `localHost` (`os.hostname().split(".")[0]`).
pub fn local_host() -> String {
    let full = raw_hostname();
    let first = full.split('.').next().unwrap_or("");
    let cleaned = safe_token(first, 32);
    if cleaned.is_empty() {
        "unknown".to_string()
    } else {
        cleaned
    }
}

#[cfg(unix)]
fn raw_hostname() -> String {
    let mut buf = [0u8; 256];
    // SAFETY: gethostname writes at most buf.len() bytes into buf.
    let ok = unsafe { libc::gethostname(buf.as_mut_ptr() as *mut libc::c_char, buf.len()) == 0 };
    if !ok {
        return String::new();
    }
    let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    String::from_utf8_lossy(&buf[..end]).to_string()
}

#[cfg(not(unix))]
fn raw_hostname() -> String {
    std::env::var("COMPUTERNAME").unwrap_or_default()
}

/// Abbreviate the home directory to `~`, mirroring how `ay ls` prints cwds and
/// TS `tildify`. `home` is a seam for tests; `None` means "look it up".
pub fn tildify(p: &str, home: Option<&str>) -> String {
    let home = match home {
        Some(h) => h.to_string(),
        None => dirs::home_dir()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or_default(),
    };
    if !home.is_empty() && p.starts_with(&home) {
        format!("~{}", &p[home.len()..])
    } else {
        p.to_string()
    }
}

/// The checked-out branch of the git repo containing `cwd`, or a short commit id
/// when detached, or `None` when `cwd` is not inside a git checkout. Pure file
/// reads — never spawns git — so it is cheap enough to run on every send: walk up
/// to the nearest `.git`, follow a worktree's `gitdir:` indirection file, then
/// parse `HEAD`. Mirrors TS `readGitBranch`.
pub fn read_git_branch(cwd: &str) -> Option<String> {
    let mut dir: PathBuf = Path::new(cwd).to_path_buf();
    // Best-effort absolutize; TS uses path.resolve(cwd).
    if dir.is_relative() {
        if let Ok(abs) = std::fs::canonicalize(&dir) {
            dir = abs;
        }
    }
    for _ in 0..32 {
        let dot_git = dir.join(".git");
        let git_dir: Option<PathBuf> = match std::fs::read_to_string(&dot_git) {
            // A worktree/submodule checkout: `.git` is a FILE containing
            // `gitdir: <path>` (absolute, or relative to the checkout).
            Ok(content) => parse_gitdir(&content).map(|rel| resolve_against(&dir, &rel)),
            // EISDIR (a normal checkout) — the TS mirror keys off that errno.
            Err(err) if dot_git.is_dir() => {
                let _ = err;
                Some(dot_git.clone())
            }
            // ENOENT/EACCES: no .git here — walk up.
            Err(_) => None,
        };
        if let Some(git_dir) = git_dir {
            let head = std::fs::read_to_string(git_dir.join("HEAD")).ok()?;
            let head = head.trim();
            if let Some(rest) = head.strip_prefix("ref:") {
                let rest = rest.trim_start();
                if let Some(name) = rest.strip_prefix("refs/heads/") {
                    if name.is_empty() {
                        return None;
                    }
                    return Some(safe_branch(name));
                }
                return None; // unrecognized HEAD — don't guess
            }
            if head.len() == 40 && head.chars().all(|c| c.is_ascii_hexdigit()) {
                return Some(head[..12].to_string()); // detached
            }
            return None;
        }
        match dir.parent() {
            Some(parent) if parent != dir => dir = parent.to_path_buf(),
            _ => return None,
        }
    }
    None
}

/// `/^gitdir:\s*(.+)\s*$/m` — the pointer inside a worktree's `.git` FILE.
fn parse_gitdir(content: &str) -> Option<String> {
    for line in content.lines() {
        if let Some(rest) = line.strip_prefix("gitdir:") {
            let path = rest.trim();
            if !path.is_empty() {
                return Some(path.to_string());
            }
        }
    }
    None
}

/// `path.resolve(dir, rel)` — absolute `rel` wins, otherwise join onto `dir`.
fn resolve_against(dir: &Path, rel: &str) -> PathBuf {
    let p = Path::new(rel);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        dir.join(p)
    }
}

/// The pieces of an identity. `user`/`host` default to the local machine
/// (correct for the envelope: the wrapper runs on the agent's own host);
/// `branch` auto-detects from `cwd` unless given. Mirrors TS `IdentityParts` —
/// including that an EXPLICIT `user`/`host`/`branch` is used verbatim, since the
/// clamps exist for machine-derived values.
#[derive(Debug, Clone, Default)]
pub struct IdentityParts<'a> {
    pub user: Option<&'a str>,
    pub host: Option<&'a str>,
    pub cwd: &'a str,
    /// `Some(None)` omits the branch segment; `None` auto-detects from `cwd`.
    #[allow(clippy::option_option)]
    pub branch: Option<Option<&'a str>>,
    pub pid: u32,
    /// Seam for `tildify`; `None` looks up the real home.
    pub home: Option<&'a str>,
}

/// Render the standardized identity for an agent. Mirrors TS `formatIdentity`.
pub fn format_identity(parts: &IdentityParts<'_>) -> String {
    let user = parts.user.map(str::to_string).unwrap_or_else(local_user);
    let host = parts.host.map(str::to_string).unwrap_or_else(local_host);
    let branch: Option<String> = match parts.branch {
        Some(explicit) => explicit.map(str::to_string),
        None => read_git_branch(parts.cwd),
    };
    let where_ = tildify(parts.cwd, parts.home);
    let branch_seg = match branch.as_deref() {
        // TS renders `${branch ? `:${branch}` : ""}` — an EMPTY branch string is
        // falsy there, so it must not produce a bare trailing `:` here either.
        Some(b) if !b.is_empty() => format!(":{b}"),
        _ => String::new(),
    };
    format!("{user}@{host}:{where_}{branch_seg}#{}", parts.pid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct IdentityCase {
        name: String,
        user: String,
        host: String,
        cwd: String,
        home: Option<String>,
        branch: Option<String>,
        pid: u32,
        want: String,
    }

    #[derive(Deserialize)]
    struct TokenCase {
        name: String,
        raw: String,
        max: usize,
        want: String,
    }

    #[derive(Deserialize)]
    struct BranchCase {
        name: String,
        raw: String,
        want: String,
    }

    #[derive(Deserialize)]
    struct Cases {
        identity: Vec<IdentityCase>,
        #[serde(rename = "safeToken")]
        safe_token: Vec<TokenCase>,
        #[serde(rename = "safeBranch")]
        safe_branch: Vec<BranchCase>,
    }

    /// The SAME table ts/identity.spec.ts asserts. This module is a hand port of
    /// ts/identity.ts, and the two only stay byte-identical — which
    /// `<ay-init-msg>`'s golden fixture depends on — if a shared table pins the
    /// behaviour on both sides.
    #[test]
    fn matches_the_shared_case_table() {
        let raw = include_str!("../../tests/fixtures/identity-cases.json");
        let cases: Cases = serde_json::from_str(raw).expect("identity-cases.json parses");

        assert!(!cases.identity.is_empty());
        for c in &cases.identity {
            let got = format_identity(&IdentityParts {
                user: Some(&c.user),
                host: Some(&c.host),
                cwd: &c.cwd,
                branch: Some(c.branch.as_deref()),
                pid: c.pid,
                home: c.home.as_deref(),
            });
            assert_eq!(got, c.want, "identity case: {}", c.name);
        }

        assert!(!cases.safe_token.is_empty());
        for c in &cases.safe_token {
            assert_eq!(
                safe_token(&c.raw, c.max),
                c.want,
                "safeToken case: {}",
                c.name
            );
        }

        assert!(!cases.safe_branch.is_empty());
        for c in &cases.safe_branch {
            assert_eq!(safe_branch(&c.raw), c.want, "safeBranch case: {}", c.name);
        }
    }

    #[test]
    fn a_run_of_bad_chars_collapses_to_one_dash() {
        // The JS regex quantifier is `+`, so "a   b" is "a-b", NOT "a---b".
        assert_eq!(safe_token("a   b", 32), "a-b");
        assert_eq!(safe_token("John Smith", 32), "John-Smith");
    }

    #[test]
    fn leading_and_trailing_dashes_are_trimmed_before_clamping() {
        assert_eq!(safe_token("  weird  ", 32), "weird");
        assert_eq!(safe_token("!!!", 32), "");
    }

    #[test]
    fn a_token_that_clamps_to_nothing_falls_back_rather_than_emitting_empty() {
        // localUser/localHost must never render an empty segment: `@:`/`::` in
        // the header would break right-to-left parsing.
        assert!(!local_user().is_empty());
        assert!(!local_host().is_empty());
    }

    #[test]
    fn tildify_only_rewrites_a_real_home_prefix() {
        assert_eq!(tildify("/home/dev/ws/repo", Some("/home/dev")), "~/ws/repo");
        assert_eq!(tildify("/home/dev", Some("/home/dev")), "~");
        assert_eq!(tildify("/srv/app", Some("/home/dev")), "/srv/app");
        assert_eq!(tildify("/srv/app", Some("")), "/srv/app");
    }

    #[test]
    fn an_empty_branch_never_renders_a_bare_trailing_colon() {
        // TS treats "" as falsy and omits the segment; a bare `:` before `#pid`
        // would make the branch unparseable.
        let got = format_identity(&IdentityParts {
            user: Some("u"),
            host: Some("h"),
            cwd: "/repo",
            branch: Some(Some("")),
            pid: 7,
            home: Some("/home/dev"),
        });
        assert_eq!(got, "u@h:/repo#7");
    }

    #[test]
    fn reads_the_branch_out_of_a_plain_checkout() {
        let tmp = tempfile::tempdir().unwrap();
        let git = tmp.path().join(".git");
        std::fs::create_dir_all(&git).unwrap();
        std::fs::write(git.join("HEAD"), "ref: refs/heads/fix/t173-tone-core\n").unwrap();
        let nested = tmp.path().join("a/b");
        std::fs::create_dir_all(&nested).unwrap();
        assert_eq!(
            read_git_branch(nested.to_str().unwrap()).as_deref(),
            Some("fix/t173-tone-core"),
        );
    }

    #[test]
    fn follows_a_worktrees_gitdir_indirection_file() {
        let tmp = tempfile::tempdir().unwrap();
        let real = tmp.path().join("realgit");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("HEAD"), "ref: refs/heads/lane-x\n").unwrap();
        let wt = tmp.path().join("wt");
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(wt.join(".git"), format!("gitdir: {}\n", real.display())).unwrap();
        assert_eq!(
            read_git_branch(wt.to_str().unwrap()).as_deref(),
            Some("lane-x")
        );
    }

    #[test]
    fn a_detached_head_yields_a_short_commit_id() {
        let tmp = tempfile::tempdir().unwrap();
        let git = tmp.path().join(".git");
        std::fs::create_dir_all(&git).unwrap();
        std::fs::write(
            git.join("HEAD"),
            "0123456789abcdef0123456789abcdef01234567\n",
        )
        .unwrap();
        assert_eq!(
            read_git_branch(tmp.path().to_str().unwrap()).as_deref(),
            Some("0123456789ab"),
        );
    }

    #[test]
    fn a_non_checkout_yields_no_branch_instead_of_guessing() {
        let tmp = tempfile::tempdir().unwrap();
        // No .git anywhere under a temp dir — walking up must terminate.
        assert_eq!(read_git_branch(tmp.path().to_str().unwrap()), None);
    }

    #[test]
    fn a_head_that_cannot_be_read_at_all_yields_no_branch() {
        // A HEAD that is a DIRECTORY makes the read fail rather than return
        // junk — a different path from the unrecognized-content case below.
        // Mirrors ts/identity.spec.ts's ".git exists but HEAD unreadable".
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join(".git").join("HEAD")).unwrap();
        assert_eq!(read_git_branch(tmp.path().to_str().unwrap()), None);
    }

    #[test]
    fn an_unrecognized_head_is_not_guessed_at() {
        let tmp = tempfile::tempdir().unwrap();
        let git = tmp.path().join(".git");
        std::fs::create_dir_all(&git).unwrap();
        std::fs::write(git.join("HEAD"), "ref: refs/tags/v1\n").unwrap();
        assert_eq!(read_git_branch(tmp.path().to_str().unwrap()), None);
    }
}
