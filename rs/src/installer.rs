//! Pre-flight CLI installation check.
//!
//! Before agent-yes spawns the wrapped agent CLI (e.g. `claude`), verify the
//! binary actually resolves on PATH. If it doesn't, show the platform-appropriate
//! install command and offer to run it interactively — the user presses `y` and
//! agent-yes installs from the official channel, then proceeds.
//!
//! This pre-flight runs ONCE before the spawn/restart loop, so a missing CLI
//! produces a clear, actionable prompt instead of an endless crash-restart loop:
//! otherwise the shell (cmd.exe on Windows) prints "not recognized", exits 1, and
//! `--robust` restarts forever.

use crate::config::InstallConfig;
use std::path::{Path, PathBuf};
use tracing::{info, warn};

/// Does `binary` resolve to an executable on PATH?
///
/// Mirrors the resolution the OS does at spawn time: a name containing a path
/// separator is checked directly; a bare name is searched across `$PATH`
/// entries. On Windows we additionally apply `PATHEXT` extensions
/// (.COM/.EXE/.BAT/.CMD/...) so npm shims (`claude.cmd`) and native `.exe`
/// installs both count.
pub fn binary_exists(binary: &str) -> bool {
    if binary.contains('/') || binary.contains('\\') {
        return path_is_executable(Path::new(binary));
    }
    let Some(paths) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&paths).any(|dir| path_is_executable(&dir.join(binary)))
}

#[cfg(windows)]
fn path_is_executable(path: &Path) -> bool {
    // Direct hit (caller already included an extension).
    if path.is_file() {
        return true;
    }
    // Try each PATHEXT extension so `claude` matches `claude.cmd` / `claude.exe`.
    let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
    pathext.split(';').any(|ext| {
        let ext = ext.trim().trim_start_matches('.');
        !ext.is_empty() && path.with_extension(ext).is_file()
    })
}

#[cfg(not(windows))]
fn path_is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    match std::fs::metadata(path) {
        Ok(m) => m.is_file() && (m.permissions().mode() & 0o111 != 0),
        Err(_) => false,
    }
}

/// Pick the install command for the current platform, mirroring the TS
/// `getInstallCommand`: a plain `single` string wins outright; otherwise prefer
/// the OS-specific field, then the OS-typical shell, then npm as a fallback.
pub fn select_install_command(install: &InstallConfig) -> Option<String> {
    if let Some(single) = &install.single {
        return Some(single.clone());
    }
    #[cfg(windows)]
    {
        install
            .windows
            .clone()
            .or_else(|| install.powershell.clone())
            .or_else(|| install.npm.clone())
    }
    #[cfg(not(windows))]
    {
        install
            .unix
            .clone()
            .or_else(|| install.bash.clone())
            .or_else(|| install.npm.clone())
    }
}

/// Verify the agent CLI is installed; if not, show the install command and
/// (interactively, or unconditionally when `auto_install` is set) run it.
///
/// Returns `true` when the CLI is available to spawn (already present, or
/// present after a successful install), `false` when it is missing and the user
/// declined, no install command exists, or the freshly installed binary isn't
/// yet visible on this shell's PATH.
pub fn ensure_cli_installed(
    cli: &str,
    binary: &str,
    install: &InstallConfig,
    auto_install: bool,
) -> bool {
    // 1. Already resolvable on this shell's PATH — nothing to do.
    if binary_exists(binary) {
        return true;
    }

    // 2. Installed somewhere known but not *linked* onto PATH? Use it as-is
    //    instead of reinstalling. Native installers (e.g. claude's) often drop
    //    the binary in ~/.local/bin or the LocalSystem profile and leave it off
    //    PATH — agent-yes should just adopt that existing install.
    if let Some(dir) = find_installed_dir(binary) {
        return enable_installed_dir(cli, &dir, false);
    }

    warn!("`{}` not found on PATH or any known install dir.", binary);

    // 3. Genuinely not installed — offer to install it.
    let Some(install_cmd) = select_install_command(install) else {
        eprintln!(
            "\n`{cli}` is not installed, and no install command is configured for this platform.\n\
             Install it manually, then re-run `agent-yes {cli}`."
        );
        return false;
    };

    eprintln!("\n`{cli}` is not installed.\n\nInstall command:\n    {install_cmd}\n");

    let proceed = if auto_install {
        info!("--install set; installing `{}` without prompting.", cli);
        true
    } else {
        prompt_yes_no(&format!("Install `{cli}` now?"))
    };

    if !proceed {
        eprintln!(
            "Skipped. Re-run `agent-yes {cli}` after installing, or pass --install to auto-install."
        );
        return false;
    }

    eprintln!("\nInstalling `{cli}`…\n");
    match run_install_command(&install_cmd) {
        Ok(true) => {}
        Ok(false) => {
            eprintln!(
                "\nInstall command exited with an error. Install `{cli}` manually:\n    {install_cmd}"
            );
            return false;
        }
        Err(e) => {
            eprintln!("\nFailed to run install command: {e}\nInstall `{cli}` manually:\n    {install_cmd}");
            return false;
        }
    }

    // 4. After install, link it onto PATH and launch.
    if binary_exists(binary) {
        eprintln!("\n`{cli}` installed and already on PATH — starting…\n");
        return true;
    }
    match find_installed_dir(binary) {
        Some(dir) => enable_installed_dir(cli, &dir, true),
        None => {
            eprintln!(
                "\n`{cli}` installed, but it isn't on this shell's PATH yet and I couldn't locate it.\n\
                 Open a new terminal (or restart this one) and re-run `agent-yes {cli}`."
            );
            false
        }
    }
}

/// Adopt an install found at `dir` that isn't on PATH: add the directory to THIS
/// process's PATH so the spawn we're about to do resolves it, persist it so
/// future shells resolve it too (no manual GUI), and report. `just_installed`
/// distinguishes "we just installed it" from "it was already installed, just
/// not linked". Always returns true (the binary is now usable).
fn enable_installed_dir(cli: &str, dir: &Path, just_installed: bool) -> bool {
    merge_dir_into_process_path(dir);
    let persisted = persist_dir_on_path(dir);
    if just_installed {
        eprintln!(
            "\n`{cli}` installed at {} — added to PATH, starting now.",
            dir.display()
        );
    } else {
        eprintln!(
            "\n`{cli}` is already installed at {} but not on PATH — added it, starting now.",
            dir.display()
        );
    }
    if persisted {
        eprintln!(
            "Added that directory to your persistent PATH; new terminals will find `{cli}` too."
        );
    } else {
        eprintln!(
            "Couldn't update your persistent PATH automatically. Add it for new shells with:"
        );
        print_path_commands(dir);
    }
    eprintln!();
    true
}

/// Locate the directory containing `binary` after an install, checking (in
/// order): the current `$PATH`, the OS persistent PATH (Windows registry —
/// where installers write, invisible to a running process), and well-known
/// install directories. Returns the directory, or `None` if not found anywhere.
fn find_installed_dir(binary: &str) -> Option<PathBuf> {
    resolve_binary_dir(binary)
        .or_else(|| {
            os_persistent_path_dirs()
                .into_iter()
                .find(|dir| dir_has_executable(dir, binary))
        })
        .or_else(|| {
            common_install_dirs()
                .into_iter()
                .find(|dir| dir_has_executable(dir, binary))
        })
}

/// If `binary` resolves on the current `$PATH`, return the directory holding it.
fn resolve_binary_dir(binary: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths).find(|dir| dir_has_executable(dir, binary))
}

fn dir_has_executable(dir: &Path, binary: &str) -> bool {
    path_is_executable(&dir.join(binary))
}

/// Directories on the OS *persistent* PATH that the current process hasn't
/// picked up. On Windows an installer writes to the per-user/machine registry
/// PATH, which a running process can't see until it restarts — query it via
/// PowerShell. On Unix the persistent PATH lives in shell rc files we can't
/// reliably re-source, so this is empty (the common-dir probe covers it).
fn os_persistent_path_dirs() -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        use std::process::Command;
        let out = Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                "[Environment]::GetEnvironmentVariable('Path','User') + ';' + \
                 [Environment]::GetEnvironmentVariable('Path','Machine')",
            ])
            .output();
        if let Ok(out) = out {
            if out.status.success() {
                return String::from_utf8_lossy(&out.stdout)
                    .split(';')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(PathBuf::from)
                    .collect();
            }
        }
        Vec::new()
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

/// Directories installers commonly drop CLIs into, beyond `$PATH`.
fn common_install_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = home_dir() {
        dirs.push(home.join(".local").join("bin"));
        dirs.push(home.join(".bun").join("bin"));
        #[cfg(not(windows))]
        {
            dirs.push(home.join(".cargo").join("bin"));
            dirs.push(home.join(".npm-global").join("bin"));
        }
    }
    #[cfg(windows)]
    {
        // The LocalSystem service account's profile. When an installer ran under
        // a service context (codehost/CI Windows boxes do), native installers
        // land here even though the interactive user's USERPROFILE differs.
        // Observed with claude: USERPROFILE=C:\Users\qauser but claude.exe at
        // C:\Windows\System32\config\systemprofile\.local\bin.
        if let Some(sysroot) = std::env::var_os("SystemRoot") {
            let sysprofile = PathBuf::from(sysroot)
                .join("System32")
                .join("config")
                .join("systemprofile");
            dirs.push(sysprofile.join(".local").join("bin"));
            dirs.push(sysprofile.join(".bun").join("bin"));
        }
    }
    #[cfg(not(windows))]
    {
        dirs.push(PathBuf::from("/usr/local/bin"));
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
    }
    dirs
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// Prepend `dir` to this process's `PATH` (if not already present) so a spawn we
/// do next resolves a binary that lives there.
fn merge_dir_into_process_path(dir: &Path) {
    let current = std::env::var_os("PATH").unwrap_or_default();
    if let Some(joined) = path_with_dir_prepended(&current, dir) {
        // Single-threaded pre-flight, before any thread that reads PATH is
        // spawned. (set_var is safe on edition 2021; `unsafe` under 2024.)
        std::env::set_var("PATH", joined);
    }
}

/// Pure core of [`merge_dir_into_process_path`]: given a `PATH` value and a
/// directory, return the new `PATH` with `dir` prepended — or `None` if `dir` is
/// already present (nothing to change).
fn path_with_dir_prepended(current: &std::ffi::OsStr, dir: &Path) -> Option<std::ffi::OsString> {
    let mut entries: Vec<PathBuf> = std::env::split_paths(current).collect();
    if entries.iter().any(|p| p == dir) {
        return None;
    }
    entries.insert(0, dir.to_path_buf());
    std::env::join_paths(entries).ok()
}

/// Make `dir` stick on the *persistent* PATH so future shells resolve the
/// newly-installed binary without the user touching any GUI. Idempotent: if the
/// directory is already on the persistent PATH, it's left untouched. Returns
/// true on success (added or already present), false if it couldn't.
///
/// Windows: append to the per-user registry PATH via .NET
/// `[Environment]::SetEnvironmentVariable(...,'User')`, which also broadcasts
/// WM_SETTINGCHANGE so newly-launched processes pick it up. We deliberately
/// avoid `setx` — it truncates PATH at 1024 chars and can clobber a long one.
///
/// Unix: append a guarded `export PATH=…` line to the user's shell rc.
fn persist_dir_on_path(dir: &Path) -> bool {
    #[cfg(windows)]
    {
        use std::process::Command;
        // Escape single quotes for the PowerShell single-quoted string literal.
        let d = dir.to_string_lossy().replace('\'', "''");
        let script = format!(
            "$d='{d}'; \
             $p=[Environment]::GetEnvironmentVariable('Path','User'); \
             if (-not $p) {{ $p='' }} \
             $parts=@($p -split ';' | Where-Object {{ $_ -ne '' }}); \
             if ($parts -notcontains $d) {{ \
               $new = if ($p) {{ \"$p;$d\" }} else {{ $d }}; \
               [Environment]::SetEnvironmentVariable('Path', $new, 'User'); \
             }}"
        );
        Command::new("powershell")
            .args(["-NoProfile", "-Command", &script])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        let Some(home) = home_dir() else {
            return false;
        };
        // Pick the rc for the user's shell; fall back to ~/.profile.
        let shell = std::env::var("SHELL").unwrap_or_default();
        let rc = if shell.ends_with("zsh") {
            home.join(".zshrc")
        } else if shell.ends_with("bash") {
            home.join(".bashrc")
        } else {
            home.join(".profile")
        };
        append_path_line_to_rc(&rc, dir)
    }
}

/// Append a guarded `export PATH=…` line for `dir` to the shell rc at `rc`,
/// unless the directory is already referenced there (idempotent). Returns true
/// on success or if it was already present.
#[cfg(not(windows))]
fn append_path_line_to_rc(rc: &Path, dir: &Path) -> bool {
    use std::io::Write;
    let dir_str = dir.to_string_lossy();
    if let Ok(existing) = std::fs::read_to_string(rc) {
        if existing.contains(dir_str.as_ref()) {
            return true; // already on persistent PATH via this rc
        }
    }
    match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(rc)
    {
        Ok(mut f) => writeln!(f, "\nexport PATH=\"{dir_str}:$PATH\"  # added by agent-yes").is_ok(),
        Err(_) => false,
    }
}

/// Print copy-paste, session-scoped commands to put `dir` on PATH. Used only as
/// a fallback when persisting the PATH automatically failed.
fn print_path_commands(dir: &Path) {
    let d = dir.display();
    #[cfg(windows)]
    {
        eprintln!("    PowerShell:  $env:Path = \"{d};\" + $env:Path");
        eprintln!("    cmd.exe:     set \"PATH={d};%PATH%\"");
    }
    #[cfg(not(windows))]
    {
        eprintln!("    bash/zsh:    export PATH=\"{d}:$PATH\"");
    }
}

/// Interpret a yes/no answer. Defaults to **no**: only an explicit `y`/`yes`
/// (case-insensitive) confirms. A bare Enter or anything else is a no — the
/// affirmative action here pipes a remote script into a shell
/// (`irm … | iex` / `curl … | bash`), so it must be a deliberate keypress, not
/// the default.
fn interpret_yes_no(input: &str) -> bool {
    matches!(input.trim().to_lowercase().as_str(), "y" | "yes")
}

/// Ask a yes/no question on the terminal, defaulting to no (see
/// [`interpret_yes_no`]). When stdin isn't a TTY (piped/CI) we don't block
/// waiting for input — default to no and point the user at `--install`.
fn prompt_yes_no(question: &str) -> bool {
    use std::io::{BufRead, IsTerminal, Write};

    if !std::io::stdin().is_terminal() {
        eprintln!(
            "{question} [y/N] (non-interactive: defaulting to No; pass --install to auto-install)"
        );
        return false;
    }

    eprint!("{question} [y/N] ");
    let _ = std::io::stderr().flush();

    let mut line = String::new();
    if std::io::stdin().lock().read_line(&mut line).is_err() {
        return false;
    }
    interpret_yes_no(&line)
}

/// Run an install command through the platform shell, inheriting stdio so the
/// user sees installer progress live (and can answer any prompts it raises).
/// The exact command and its exit code are framed so it's clear what ran and
/// what the installer itself printed.
fn run_install_command(cmd: &str) -> std::io::Result<bool> {
    use std::process::Command;
    eprintln!("\x1b[2m> {cmd}\x1b[0m");
    eprintln!("\x1b[2m──────────────────────── installer output ────────────────────────\x1b[0m");

    #[cfg(windows)]
    let status = {
        // Do NOT use `cmd /C <cmd>`. cmd.exe mis-parses `|`, `&` and `"` in the
        // command (Rust's CreateProcess arg quoting doesn't match cmd's parser),
        // which mangles installers like claude's
        // `powershell -Command "irm … | iex"` — the `|` gets eaten, so the
        // installer neither runs correctly nor shows its output. Writing the
        // command to a temp .ps1 and running it with `-File` sidesteps all
        // command-line quoting: PowerShell reads the bytes from the file.
        let mut script = std::env::temp_dir();
        script.push(format!("agent-yes-install-{}.ps1", std::process::id()));
        std::fs::write(&script, cmd)?;
        let result = Command::new("powershell")
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(&script)
            .status();
        let _ = std::fs::remove_file(&script);
        result?
    };
    #[cfg(not(windows))]
    let status = Command::new("sh").arg("-c").arg(cmd).status()?;

    let code = status
        .code()
        .map(|c| c.to_string())
        .unwrap_or_else(|| "terminated".to_string());
    eprintln!(
        "\x1b[2m──────────────────── installer finished (exit {code}) ─────────────────\x1b[0m"
    );
    Ok(status.success())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_binary_exists_finds_real_binary() {
        // Every platform that runs these tests has a shell on PATH.
        #[cfg(windows)]
        assert!(binary_exists("cmd"));
        #[cfg(not(windows))]
        assert!(binary_exists("sh"));
    }

    #[test]
    fn test_binary_exists_rejects_missing() {
        assert!(!binary_exists("definitely-not-a-real-binary-xyz123"));
    }

    #[test]
    fn test_select_single_wins() {
        let cfg = InstallConfig {
            single: Some("brew install foo".into()),
            npm: Some("npm i -g foo".into()),
            ..Default::default()
        };
        assert_eq!(
            select_install_command(&cfg).as_deref(),
            Some("brew install foo")
        );
    }

    #[test]
    fn test_select_platform_command() {
        let cfg = InstallConfig {
            powershell: Some("irm install.ps1 | iex".into()),
            bash: Some("curl install.sh | bash".into()),
            npm: Some("npm i -g foo".into()),
            ..Default::default()
        };
        let got = select_install_command(&cfg);
        #[cfg(windows)]
        assert_eq!(got.as_deref(), Some("irm install.ps1 | iex"));
        #[cfg(not(windows))]
        assert_eq!(got.as_deref(), Some("curl install.sh | bash"));
    }

    #[test]
    fn test_select_npm_fallback() {
        let cfg = InstallConfig {
            npm: Some("npm i -g foo".into()),
            ..Default::default()
        };
        assert_eq!(
            select_install_command(&cfg).as_deref(),
            Some("npm i -g foo")
        );
    }

    #[test]
    fn test_select_none_when_empty() {
        let cfg = InstallConfig::default();
        assert!(select_install_command(&cfg).is_none());
    }

    #[test]
    fn test_interpret_yes_no_defaults_to_no() {
        // Only an explicit y/yes confirms; Enter and anything else are No.
        assert!(interpret_yes_no("y"));
        assert!(interpret_yes_no("Y"));
        assert!(interpret_yes_no("yes"));
        assert!(interpret_yes_no(" Yes \n"));
        assert!(!interpret_yes_no("")); // bare Enter
        assert!(!interpret_yes_no("\n"));
        assert!(!interpret_yes_no("n"));
        assert!(!interpret_yes_no("no"));
        assert!(!interpret_yes_no("yeah"));
        assert!(!interpret_yes_no("garbage"));
    }

    #[test]
    fn test_resolve_binary_dir_finds_shell_dir() {
        // The shell binary resolves on PATH; its dir must contain it.
        #[cfg(windows)]
        let (bin, _) = ("cmd", ());
        #[cfg(not(windows))]
        let (bin, _) = ("sh", ());
        let dir = resolve_binary_dir(bin).expect("shell resolves on PATH");
        assert!(dir_has_executable(&dir, bin));
    }

    #[test]
    fn test_common_install_dirs_includes_local_bin() {
        // Whatever HOME/USERPROFILE is, ~/.local/bin should be a candidate.
        if home_dir().is_some() {
            let dirs = common_install_dirs();
            assert!(
                dirs.iter().any(|d| d.ends_with("bin")),
                "expected at least one .../bin candidate, got {dirs:?}"
            );
        }
    }

    #[test]
    fn test_path_with_dir_prepended_prepends_and_dedupes() {
        use std::ffi::OsString;
        let sep = if cfg!(windows) { ";" } else { ":" };
        let existing = format!("/usr/bin{sep}/bin");
        let cur = OsString::from(&existing);
        let dir = Path::new("/opt/tools/bin");

        // New dir → prepended at the front.
        let got = path_with_dir_prepended(&cur, dir).expect("dir is new → Some");
        let entries: Vec<PathBuf> = std::env::split_paths(&got).collect();
        assert_eq!(entries.first().map(|p| p.as_path()), Some(dir));
        assert!(entries.iter().any(|p| p == Path::new("/usr/bin")));

        // Already present → None (no change, no duplicate).
        assert!(path_with_dir_prepended(&cur, Path::new("/bin")).is_none());
    }

    #[test]
    fn test_dir_has_executable_on_temp_file() {
        // dir_has_executable is the core of find_installed_dir's directory probe.
        let tmp = std::env::temp_dir().join("ay-installer-test-bin");
        let _ = std::fs::create_dir_all(&tmp);
        #[cfg(windows)]
        let name = "ay-fake-cli.exe";
        #[cfg(not(windows))]
        let name = "ay-fake-cli";
        let bin_path = tmp.join(name);
        std::fs::write(&bin_path, b"#!/bin/sh\n").unwrap();
        #[cfg(not(windows))]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&bin_path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        // Bare name resolves (Windows applies PATHEXT to match .exe).
        assert!(dir_has_executable(&tmp, "ay-fake-cli"));
        assert!(!dir_has_executable(&tmp, "ay-nonexistent-cli"));
        let _ = std::fs::remove_file(&bin_path);
    }

    #[cfg(not(windows))]
    #[test]
    fn test_append_path_line_to_rc_is_idempotent() {
        let dir = std::env::temp_dir();
        let rc = dir.join("ay-test-rc-file");
        let _ = std::fs::remove_file(&rc);
        let bindir = Path::new("/opt/agent/bin");

        // First append: creates the file and writes the export line.
        assert!(append_path_line_to_rc(&rc, bindir));
        let c1 = std::fs::read_to_string(&rc).unwrap();
        assert!(c1.contains("/opt/agent/bin"));
        assert!(c1.contains("added by agent-yes"));
        let count1 = c1.matches("/opt/agent/bin").count();
        assert_eq!(count1, 1);

        // Second append: dir already referenced → no-op, no duplicate line.
        assert!(append_path_line_to_rc(&rc, bindir));
        let c2 = std::fs::read_to_string(&rc).unwrap();
        assert_eq!(c2.matches("/opt/agent/bin").count(), 1);

        let _ = std::fs::remove_file(&rc);
    }
}
