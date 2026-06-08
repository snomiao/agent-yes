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
use std::path::Path;
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
    if binary_exists(binary) {
        return true;
    }

    warn!("`{}` not found on PATH.", binary);

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

    // The installer may have updated PATH, but the current process keeps a stale
    // copy (notably on Windows). Re-check; if the binary still isn't visible,
    // ask the user to re-run rather than crash-looping on a not-found spawn.
    if binary_exists(binary) {
        eprintln!("\n`{cli}` installed successfully — starting…\n");
        true
    } else {
        eprintln!(
            "\n`{cli}` installed, but it isn't on this shell's PATH yet.\n\
             Open a new terminal (or restart this one) and re-run `agent-yes {cli}`."
        );
        false
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
/// user sees installer progress (and can answer any prompts it raises).
fn run_install_command(cmd: &str) -> std::io::Result<bool> {
    use std::process::Command;
    let status = if cfg!(windows) {
        Command::new("cmd").arg("/C").arg(cmd).status()?
    } else {
        Command::new("sh").arg("-c").arg(cmd).status()?
    };
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
}
