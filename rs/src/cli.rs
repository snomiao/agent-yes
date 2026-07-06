//! CLI argument parsing module

use anyhow::{anyhow, Result};
use clap::{ArgAction, Parser};
use std::env;

// ---------------------------------------------------------------------------
// Subcommand delegation to the TypeScript launcher
// ---------------------------------------------------------------------------
//
// This Rust binary is ONLY the agent runner. The management subcommands
// (`ay ls`, `ay send`, `ay restart`, `ay stop`, `ay serve`, …) are implemented
// solely in the TypeScript layer (ts/subcommands.ts). When this binary is
// invoked with a leading subcommand word — e.g. a cargo-installed `agent-yes`
// that shadows the JS launcher on PATH runs `agent-yes restart 1234` — clap's
// `trailing_var_arg` would parse `restart 1234` as PROMPT text and launch an
// agent instead. Detect that case up front and re-exec the JS launcher, which
// owns the subcommand dispatch.

/// Management subcommands handled by the TypeScript CLI, not this runner.
/// MUST mirror `SUBCOMMANDS` in ts/subcommands.ts — keep the two in sync.
pub const SUBCOMMANDS: &[&str] = &[
    "ls", "list", "ps", "status", "result", "notify", "notifyd", "read", "cat", "tail", "head",
    "send", "spawn", "attach", "stop", "exit", "restart", "note", "serve", "schedule", "remote",
    "reap", "help",
];

/// Subcommands reserved for the generic manager entry (`ay`/`agent-yes`), not a
/// cli-bound alias like `cy`. Mirrors `MANAGER_SUBCOMMANDS` in ts/subcommands.ts.
pub const MANAGER_SUBCOMMANDS: &[&str] = &["setup"];

/// Whether `name` is a management subcommand. `manager_commands` (true for the
/// generic `ay`/`agent-yes` entry) additionally admits manager-only commands
/// like `setup`; false for a cli-bound alias (cy/claude-yes/…) so those names
/// fall through to running the agent. Mirrors `isSubcommand` in ts/subcommands.ts.
pub fn is_subcommand(name: &str, manager_commands: bool) -> bool {
    SUBCOMMANDS.contains(&name) || (manager_commands && MANAGER_SUBCOMMANDS.contains(&name))
}

/// Mirror of ts/invokedCli.ts `invokedCliName`: the agent CLI implied by the
/// binary name (cy/claude-yes → "claude", codex-yes → "codex", …), or None for
/// the generic `ay`/`agent-yes`/`cli` manager entry. Used to tell a cli-bound
/// alias apart from the manager so manager-only subcommands (setup) don't hijack
/// an alias's prompt.
fn invoked_cli_name(exe_base: &str) -> Option<String> {
    let base = exe_base
        .strip_suffix(".js")
        .or_else(|| exe_base.strip_suffix(".ts"))
        .unwrap_or(exe_base);
    // Generic manager entries resolve to None.
    if matches!(base, "agent-yes" | "agent" | "cli" | "cli-yes" | "ay") {
        return None;
    }
    let raw = base.strip_suffix("-yes").unwrap_or(base);
    if raw.is_empty() {
        return None;
    }
    // Short aliases (must match CLI_ALIASES in ts/invokedCli.ts).
    match raw {
        "cy" => Some("claude".to_string()),
        "orcy" => Some("openrouter".to_string()),
        other => Some(other.to_string()),
    }
}

/// Pure decision: should an invocation named `exe_base` with leading user arg
/// `first_arg` delegate to the JS launcher? Split out from
/// [`maybe_delegate_subcommand`] (which reads process globals) so it's testable.
fn should_delegate(first_arg: &str, exe_base: &str) -> bool {
    let manager_commands = invoked_cli_name(exe_base).is_none();
    is_subcommand(first_arg, manager_commands)
}

/// If this binary was invoked with a leading management subcommand, re-exec the
/// JS launcher and return `Some(exit_code)` for the caller to exit with;
/// otherwise return `None` so the normal agent-run proceeds.
///
/// Only the FIRST user arg is inspected — mirrors the TS dispatch, which keys
/// off `process.argv[2]` alone (a subcommand buried after flags is not one).
pub fn maybe_delegate_subcommand() -> Option<i32> {
    let raw: Vec<String> = env::args().collect();
    let first = raw.get(1)?; // raw[0] is the binary itself
    let exe_base = env::current_exe()
        .ok()
        .and_then(|p| p.file_stem().map(|s| s.to_string_lossy().to_string()))
        .unwrap_or_default();
    if !should_delegate(first, &exe_base) {
        return None;
    }
    Some(delegate_to_js(&raw[1..]))
}

/// Re-exec the JS launcher with `forward_args`, inheriting stdio and propagating
/// the exit code. Target is `ay` by default (never this Rust binary — cargo
/// installs only `agent-yes` — so delegation can't recurse); `AGENT_YES_JS_CLI`
/// overrides with a path or command name for non-standard installs.
fn delegate_to_js(forward_args: &[String]) -> i32 {
    let launcher = env::var("AGENT_YES_JS_CLI")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "ay".to_string());
    let sub = forward_args.first().map(String::as_str).unwrap_or("");

    let not_found_msg = || {
        eprintln!(
            "agent-yes: '{sub}' is a management subcommand handled by the JS CLI, but the \
             launcher '{launcher}' was not found on PATH.\nRun it via `ay {sub} …`, or set \
             AGENT_YES_JS_CLI to the launcher path."
        );
    };

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // exec replaces this process, so signals/exit propagate perfectly; it
        // returns only if the launcher couldn't be started.
        let err = std::process::Command::new(&launcher)
            .args(forward_args)
            .exec();
        if err.kind() == std::io::ErrorKind::NotFound {
            not_found_msg();
        } else {
            eprintln!("agent-yes: failed to delegate '{sub}' to '{launcher}': {err}");
        }
        127
    }
    #[cfg(not(unix))]
    {
        match std::process::Command::new(&launcher)
            .args(forward_args)
            .status()
        {
            Ok(status) => status.code().unwrap_or(1),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                not_found_msg();
                127
            }
            Err(err) => {
                eprintln!("agent-yes: failed to delegate '{sub}' to '{launcher}': {err}");
                127
            }
        }
    }
}

/// Supported CLI tools
// MUST mirror the `clis:` keys in default.config.yaml — this list gates CLI
// validation and binary-name detection (`glm-yes` → "glm"). A new CLI added to
// the YAML won't be runnable via the Rust runtime until it's listed here too.
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
];

// Most fields here are read elsewhere in the binary; the ones that aren't
// are kept either for forward use (auto-install, use-skills) or as deprecated
// CLI compat aliases consumed by `resolve_args` and not read downstream.
// Marking them dead_code at the struct level keeps the public CLI surface
// stable without per-field annotations every commit.
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct CliArgs {
    pub cli: String,
    pub cli_args: Vec<String>,
    pub prompt: Option<String>,
    pub timeout_ms: Option<u64>,
    pub idle_action: Option<String>,
    pub robust: bool,
    pub continue_session: bool,
    pub verbose: bool,
    pub auto_yes: bool,
    pub install: bool,
    pub queue: bool,
    pub use_skills: bool,
    pub skip_permissions: bool,
    /// Working directory to run the agent in. None = use process current_dir.
    pub cwd: Option<String>,
    /// Force raw TUI passthrough even when stdout is not a TTY.
    pub force_tty: bool,
    /// Force plain rendered text output even when stdout is a TTY.
    pub no_tty: bool,
    /// Swarm mode: None = disabled, Some(value) = enabled with optional config
    /// Value can be: topic name, room code (XXX-XXX), ay:// URL, or multiaddr
    pub swarm: Option<String>,
    /// Deprecated: use --swarm instead
    pub experimental_swarm: bool,
    /// Deprecated: listen address override (use ay:// URL listen param instead)
    pub swarm_listen: Option<String>,
    /// Deprecated: use --swarm <topic> instead
    pub swarm_topic: String,
    /// Deprecated: use --swarm ay://...?peer=... instead
    pub swarm_bootstrap: Vec<String>,
}

#[derive(Parser, Debug)]
#[command(name = "agent-yes")]
#[command(version = env!("CARGO_PKG_VERSION"))]
#[command(about = "Automated interaction wrapper for AI coding assistants")]
struct Args {
    /// CLI tool to use (claude, gemini, codex, copilot, cursor, grok, qwen, auggie)
    #[arg(long, default_value = "claude")]
    cli: String,

    /// Initial prompt text
    #[arg(short, long)]
    prompt: Option<String>,

    /// Exit on idle (e.g., "60s", "1m", "5m")
    #[arg(short, long)]
    timeout: Option<String>,

    /// Deprecated: Exit on idle (alias for --timeout)
    #[arg(long = "exit-on-idle", hide = true)]
    exit_on_idle: Option<String>,

    /// Deprecated: Alias for --timeout
    #[arg(long = "idle-timeout", hide = true)]
    idle_timeout: Option<String>,

    /// Action to perform when idle timeout is reached instead of exiting (e.g. "check TODO.md")
    #[arg(long = "idle-action", short = 'a')]
    idle_action: Option<String>,

    /// Auto-restart on crash
    #[arg(short, long, default_value = "true", action = ArgAction::Set)]
    robust: bool,

    /// Resume previous session
    #[arg(short = 'c', long = "continue")]
    continue_session: bool,

    /// Debug logging
    #[arg(long, default_value = "false")]
    verbose: bool,

    /// Auto-yes mode (yes/no)
    #[arg(long, default_value = "yes")]
    auto: String,

    /// Auto-install missing CLI
    #[arg(long, default_value = "false")]
    install: bool,

    /// Queue execution (no concurrent agents)
    #[arg(long, default_value = "false")]
    queue: bool,

    /// Prepend SKILL.md context
    #[arg(long, default_value = "false")]
    use_skills: bool,

    /// Pass --dangerously-skip-permissions to the CLI
    #[arg(short = 'y', long = "yes", default_value = "false")]
    yes: bool,

    /// Working directory for the agent (default: current directory)
    #[arg(long)]
    cwd: Option<String>,

    /// Force raw TUI passthrough even when stdout is not a TTY (piped/redirected)
    #[arg(long = "force-tty", default_value = "false")]
    force_tty: bool,

    /// Force plain rendered text output even when stdout is a TTY
    #[arg(long = "no-tty", default_value = "false")]
    no_tty: bool,

    /// Enable swarm mode for multi-agent P2P networking
    ///
    /// Value formats:
    ///   --swarm my-project       Topic name (LAN auto-discovery)
    ///   --swarm ABC-123          Room code (6-char, easy to share)
    ///   --swarm "ay://..."       Swarm URL (for internet)
    ///   --swarm "/ip4/..."       Raw multiaddr (direct connect)
    #[arg(long, num_args = 0..=1, default_missing_value = "agent-yes-swarm")]
    swarm: Option<String>,

    /// Deprecated: use --swarm instead
    #[arg(long, default_value = "false", hide = true)]
    experimental_swarm: bool,

    /// Deprecated: use ay:// URL with listen param
    #[arg(long, hide = true)]
    swarm_listen: Option<String>,

    /// Deprecated: use --swarm <topic> instead
    #[arg(long, default_value = "agent-yes-swarm", hide = true)]
    swarm_topic: String,

    /// Deprecated: use --swarm ay://...?peer=... instead
    #[arg(long, hide = true)]
    swarm_bootstrap: Vec<String>,

    /// Additional arguments for the CLI tool
    #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
    args: Vec<String>,
}

/// Parse CLI arguments
pub fn parse_args() -> Result<CliArgs> {
    // Detect CLI from binary name
    let exe_name = env::current_exe()
        .ok()
        .and_then(|p| p.file_stem().map(|s| s.to_string_lossy().to_string()))
        .unwrap_or_default();

    let args = Args::parse();
    resolve_args(args, &exe_name)
}

/// Resolve parsed clap Args into CliArgs (testable without process args)
fn resolve_args(args: Args, exe_name: &str) -> Result<CliArgs> {
    let cli_from_name = detect_cli_from_name(exe_name);

    // Parse trailing args - first arg might be CLI name
    let (trailing_cli, remaining_args) = extract_cli_from_args(&args.args);

    // Determine CLI: priority is explicit --cli, then trailing positional, then binary name
    let cli = if args.cli != "claude" {
        // Explicit --cli flag was used
        args.cli.clone()
    } else if let Some(ref tc) = trailing_cli {
        // First positional arg is a valid CLI name
        tc.clone()
    } else if let Some(ref cn) = cli_from_name {
        // Detected from binary name (e.g., claude-yes)
        cn.clone()
    } else {
        // Default to claude
        args.cli.clone()
    };

    // Validate CLI
    if !SUPPORTED_CLIS.contains(&cli.as_str()) {
        return Err(anyhow!(
            "Unsupported CLI: {}. Supported: {:?}",
            cli,
            SUPPORTED_CLIS
        ));
    }

    // Parse timeout (check all aliases)
    let timeout_str = args.timeout.or(args.idle_timeout).or(args.exit_on_idle);
    let timeout_ms = timeout_str.map(|s| parse_duration(&s)).transpose()?;

    // Parse prompt from remaining args (after --)
    let (cli_args, prompt) = extract_prompt_from_args(remaining_args, args.prompt);

    // Handle swarm mode: new --swarm flag takes precedence over deprecated flags
    let swarm = if args.swarm.is_some() {
        args.swarm.clone()
    } else if args.experimental_swarm {
        // Backwards compat: convert old flags to new format
        Some(args.swarm_topic.clone())
    } else {
        None
    };

    Ok(CliArgs {
        cli,
        cli_args,
        prompt,
        timeout_ms,
        idle_action: args.idle_action,
        robust: args.robust,
        continue_session: args.continue_session,
        verbose: args.verbose,
        auto_yes: args.auto.to_lowercase() != "no",
        install: args.install,
        queue: args.queue,
        use_skills: args.use_skills,
        skip_permissions: args.yes,
        cwd: args.cwd,
        force_tty: args.force_tty,
        no_tty: args.no_tty,
        swarm,
        experimental_swarm: args.experimental_swarm,
        swarm_listen: args.swarm_listen,
        swarm_topic: args.swarm_topic,
        swarm_bootstrap: args.swarm_bootstrap,
    })
}

/// Extract CLI name from first positional argument if it's a valid CLI
fn extract_cli_from_args(args: &[String]) -> (Option<String>, Vec<String>) {
    if let Some(first) = args.first() {
        // Check if first arg is a supported CLI name (without -yes suffix handling)
        let cli_name = first.strip_suffix("-yes").unwrap_or(first);
        if SUPPORTED_CLIS.contains(&cli_name) {
            return (Some(cli_name.to_string()), args[1..].to_vec());
        }
    }
    (None, args.to_vec())
}

/// Detect CLI tool from binary name (e.g., "claude-yes" -> "claude")
fn detect_cli_from_name(name: &str) -> Option<String> {
    for cli in SUPPORTED_CLIS {
        if name.starts_with(cli) && name.contains("-yes") {
            return Some(cli.to_string());
        }
    }
    None
}

/// Parse human-readable duration to milliseconds
fn parse_duration(s: &str) -> Result<u64> {
    let s = s.trim();

    // Try parsing as humantime duration
    if let Ok(duration) = humantime::parse_duration(s) {
        return Ok(duration.as_millis() as u64);
    }

    // Try parsing as plain number (assume seconds)
    if let Ok(secs) = s.parse::<u64>() {
        return Ok(secs * 1000);
    }

    Err(anyhow!("Invalid duration format: {}", s))
}

/// Extract prompt from args (handles -- separator and bare words)
fn extract_prompt_from_args(
    args: Vec<String>,
    explicit_prompt: Option<String>,
) -> (Vec<String>, Option<String>) {
    if let Some(prompt) = explicit_prompt {
        return (args, Some(prompt));
    }

    // Look for -- separator
    if let Some(pos) = args.iter().position(|a| a == "--") {
        let cli_args = args[..pos].to_vec();
        let prompt_parts: Vec<String> = args[pos + 1..].to_vec();
        let prompt = if prompt_parts.is_empty() {
            None
        } else {
            Some(prompt_parts.join(" "))
        };
        return (cli_args, prompt);
    }

    // No -- separator: treat non-flag bare words as prompt text.
    // Flag-like args (starting with -) and their values stay as cli_args.
    let mut cli_args = Vec::new();
    let mut prompt_parts = Vec::new();
    let mut skip_next = false;

    for (i, arg) in args.iter().enumerate() {
        if skip_next {
            skip_next = false;
            continue;
        }
        if arg.starts_with('-') {
            cli_args.push(arg.clone());
            // If it's a flag like --foo bar (not --foo=bar), consume next arg as its value
            if !arg.contains('=') {
                if let Some(next) = args.get(i + 1) {
                    if !next.starts_with('-') {
                        cli_args.push(next.clone());
                        skip_next = true;
                    }
                }
            }
        } else {
            prompt_parts.push(arg.clone());
        }
    }

    let prompt = if prompt_parts.is_empty() {
        None
    } else {
        Some(prompt_parts.join(" "))
    };

    (cli_args, prompt)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_subcommand() {
        // Management subcommands are recognised for both manager and alias.
        for sub in ["restart", "ls", "send", "stop", "serve", "tail", "reap"] {
            assert!(is_subcommand(sub, true), "{sub} should be a subcommand");
            assert!(is_subcommand(sub, false), "{sub} should be a subcommand");
        }
        // Non-subcommands (cli names, flags, arbitrary prompt words) are not.
        for other in ["claude", "codex", "-p", "--cli=claude", "restartx", "hello"] {
            assert!(!is_subcommand(other, true), "{other} is not a subcommand");
        }
        // `setup` is manager-only: a subcommand for `ay`/`agent-yes`, not for a
        // cli-bound alias like `cy` (there it's a prompt word).
        assert!(is_subcommand("setup", true));
        assert!(!is_subcommand("setup", false));
    }

    #[test]
    fn test_invoked_cli_name() {
        // Generic manager entries → None.
        for name in ["agent-yes", "agent", "cli", "cli-yes", "ay", "ay.js"] {
            assert_eq!(invoked_cli_name(name), None, "{name} is the manager entry");
        }
        // Cli-bound names and aliases → their target CLI.
        assert_eq!(invoked_cli_name("claude-yes"), Some("claude".into()));
        assert_eq!(invoked_cli_name("codex-yes"), Some("codex".into()));
        assert_eq!(invoked_cli_name("cy"), Some("claude".into()));
        assert_eq!(invoked_cli_name("orcy"), Some("openrouter".into()));
        assert_eq!(invoked_cli_name("gemini-yes.js"), Some("gemini".into()));
    }

    #[test]
    fn test_should_delegate() {
        // Generic manager: any subcommand (including setup) delegates.
        assert!(should_delegate("restart", "agent-yes"));
        assert!(should_delegate("ls", "ay"));
        assert!(should_delegate("setup", "agent-yes"));
        // Cli-bound alias: management subcommands still delegate, but `setup`
        // does not (it's a prompt word for that alias).
        assert!(should_delegate("restart", "claude-yes"));
        assert!(should_delegate("send", "cy"));
        assert!(!should_delegate("setup", "claude-yes"));
        // Prompts / cli names / flags never delegate.
        assert!(!should_delegate("claude", "agent-yes"));
        assert!(!should_delegate("-p", "agent-yes"));
        assert!(!should_delegate("fix", "agent-yes"));
    }

    #[test]
    fn test_detect_cli_from_name_all() {
        assert_eq!(detect_cli_from_name("claude-yes"), Some("claude".into()));
        assert_eq!(detect_cli_from_name("gemini-yes"), Some("gemini".into()));
        assert_eq!(detect_cli_from_name("codex-yes"), Some("codex".into()));
        assert_eq!(detect_cli_from_name("copilot-yes"), Some("copilot".into()));
        assert_eq!(detect_cli_from_name("cursor-yes"), Some("cursor".into()));
        assert_eq!(detect_cli_from_name("grok-yes"), Some("grok".into()));
        assert_eq!(detect_cli_from_name("qwen-yes"), Some("qwen".into()));
        assert_eq!(detect_cli_from_name("auggie-yes"), Some("auggie".into()));
        assert_eq!(detect_cli_from_name("amp-yes"), Some("amp".into()));
        assert_eq!(
            detect_cli_from_name("opencode-yes"),
            Some("opencode".into())
        );
        assert_eq!(detect_cli_from_name("agent-yes"), None);
        assert_eq!(detect_cli_from_name("something"), None);
        assert_eq!(detect_cli_from_name(""), None);
    }

    #[test]
    fn test_parse_duration_valid() {
        assert_eq!(parse_duration("60s").unwrap(), 60000);
        assert_eq!(parse_duration("1m").unwrap(), 60000);
        assert_eq!(parse_duration("5m").unwrap(), 300000);
        assert_eq!(parse_duration("60").unwrap(), 60000);
        assert_eq!(parse_duration("  30  ").unwrap(), 30000);
        assert_eq!(parse_duration("2h").unwrap(), 7200000);
    }

    #[test]
    fn test_parse_duration_invalid() {
        assert!(parse_duration("abc").is_err());
        assert!(parse_duration("").is_err());
    }

    #[test]
    fn test_extract_prompt_with_separator() {
        let args = vec!["--flag".into(), "--".into(), "my".into(), "prompt".into()];
        let (cli_args, prompt) = extract_prompt_from_args(args, None);
        assert_eq!(cli_args, vec!["--flag"]);
        assert_eq!(prompt, Some("my prompt".into()));
    }

    #[test]
    fn test_extract_prompt_explicit() {
        let args = vec!["--flag".into()];
        let (cli_args, prompt) = extract_prompt_from_args(args, Some("explicit".into()));
        assert_eq!(cli_args, vec!["--flag"]);
        assert_eq!(prompt, Some("explicit".into()));
    }

    #[test]
    fn test_extract_prompt_empty_after_separator() {
        let args = vec!["--flag".into(), "--".into()];
        let (cli_args, prompt) = extract_prompt_from_args(args, None);
        assert_eq!(cli_args, vec!["--flag"]);
        assert_eq!(prompt, None);
    }

    #[test]
    fn test_extract_prompt_no_separator_flag_with_value() {
        // --flag value: "value" is consumed as flag's value, not prompt
        let args = vec!["--flag".into(), "value".into()];
        let (cli_args, prompt) = extract_prompt_from_args(args, None);
        assert_eq!(cli_args, vec!["--flag", "value"]);
        assert_eq!(prompt, None);
    }

    #[test]
    fn test_extract_prompt_bare_words_as_prompt() {
        // Bare words without -- should become the prompt
        let args = vec![
            "rebuild".into(),
            "and".into(),
            "analyze".into(),
            "problems".into(),
        ];
        let (cli_args, prompt) = extract_prompt_from_args(args, None);
        assert!(cli_args.is_empty());
        assert_eq!(prompt, Some("rebuild and analyze problems".into()));
    }

    #[test]
    fn test_extract_prompt_mixed_flags_and_bare_words() {
        // Flags stay as cli_args, bare words become prompt
        let args = vec![
            "--timeout".into(),
            "5m".into(),
            "solve".into(),
            "all".into(),
            "todos".into(),
        ];
        let (cli_args, prompt) = extract_prompt_from_args(args, None);
        assert_eq!(cli_args, vec!["--timeout", "5m"]);
        assert_eq!(prompt, Some("solve all todos".into()));
    }

    #[test]
    fn test_extract_cli_from_args() {
        let args = vec!["codex".into(), "hello".into(), "world".into()];
        let (cli, remaining) = extract_cli_from_args(&args);
        assert_eq!(cli, Some("codex".into()));
        assert_eq!(remaining, vec!["hello", "world"]);

        let args = vec!["codex-yes".into(), "hello".into()];
        let (cli, remaining) = extract_cli_from_args(&args);
        assert_eq!(cli, Some("codex".into()));
        assert_eq!(remaining, vec!["hello"]);

        let args = vec!["--flag".into(), "value".into()];
        let (cli, remaining) = extract_cli_from_args(&args);
        assert_eq!(cli, None);
        assert_eq!(remaining, vec!["--flag", "value"]);

        let args: Vec<String> = vec![];
        let (cli, remaining) = extract_cli_from_args(&args);
        assert_eq!(cli, None);
        assert!(remaining.is_empty());
    }

    #[test]
    fn test_extract_cli_from_args_all_clis() {
        for cli in SUPPORTED_CLIS {
            let args = vec![cli.to_string(), "arg1".into()];
            let (detected, remaining) = extract_cli_from_args(&args);
            assert_eq!(detected, Some(cli.to_string()));
            assert_eq!(remaining, vec!["arg1"]);
        }
    }

    #[test]
    fn test_resolve_args_bare_words_as_prompt() {
        // `cy arg1 arg2` → bare words become prompt (not CLI args)
        let mut args = default_args();
        args.args = vec!["arg1".into(), "arg2".into()];
        let result = resolve_args(args, "claude-yes").unwrap();
        assert_eq!(result.cli, "claude");
        assert!(result.cli_args.is_empty());
        assert_eq!(result.prompt, Some("arg1 arg2".into()));
    }

    #[test]
    fn test_resolve_args_bare_words_with_flags() {
        // bare words mixed with flags: flags → cli_args, bare words → prompt
        let mut args = default_args();
        args.args = vec![
            "--some-flag".into(),
            "value".into(),
            "fix".into(),
            "the".into(),
            "bug".into(),
        ];
        let result = resolve_args(args, "claude-yes").unwrap();
        assert_eq!(result.cli, "claude");
        assert_eq!(result.cli_args, vec!["--some-flag", "value"]);
        assert_eq!(result.prompt, Some("fix the bug".into()));
    }

    #[test]
    fn test_supported_clis_count() {
        assert_eq!(SUPPORTED_CLIS.len(), 13);
        // The claude-compatible providers (run the `claude` binary via env) must
        // be present, else their `*-yes` bins fail validation in the Rust runtime.
        for cli in ["glm", "openrouter", "pi"] {
            assert!(SUPPORTED_CLIS.contains(&cli), "missing {cli}");
        }
        // Each listed CLI must resolve to a real config (catches a name in this
        // list that isn't actually defined in default.config.yaml).
        for cli in SUPPORTED_CLIS {
            assert!(
                crate::config::get_cli_config(cli).is_ok(),
                "SUPPORTED_CLIS entry '{cli}' has no config in default.config.yaml"
            );
        }
    }

    fn default_args() -> Args {
        Args {
            cli: "claude".into(),
            prompt: None,
            timeout: None,
            exit_on_idle: None,
            idle_timeout: None,
            idle_action: None,
            robust: true,
            continue_session: false,
            verbose: false,
            auto: "yes".into(),
            install: false,
            queue: false,
            use_skills: false,
            yes: false,
            cwd: None,
            force_tty: false,
            no_tty: false,
            swarm: None,
            experimental_swarm: false,
            swarm_listen: None,
            swarm_topic: "agent-yes-swarm".into(),
            swarm_bootstrap: vec![],
            args: vec![],
        }
    }

    #[test]
    fn test_resolve_args_default() {
        let result = resolve_args(default_args(), "agent-yes").unwrap();
        assert_eq!(result.cli, "claude");
        assert!(result.prompt.is_none());
        assert!(result.timeout_ms.is_none());
        assert!(result.robust);
        assert!(!result.continue_session);
        assert!(!result.verbose);
        assert!(result.auto_yes);
        assert!(!result.install);
        assert!(!result.queue);
        assert!(result.swarm.is_none());
    }

    #[test]
    fn test_resolve_args_explicit_cli() {
        let mut args = default_args();
        args.cli = "gemini".into();
        let result = resolve_args(args, "agent-yes").unwrap();
        assert_eq!(result.cli, "gemini");
    }

    #[test]
    fn test_resolve_args_trailing_cli() {
        let mut args = default_args();
        args.args = vec!["codex".into(), "hello".into()];
        let result = resolve_args(args, "agent-yes").unwrap();
        assert_eq!(result.cli, "codex");
        assert!(result.cli_args.is_empty());
        assert_eq!(result.prompt, Some("hello".into()));
    }

    #[test]
    fn test_resolve_args_binary_name_cli() {
        let result = resolve_args(default_args(), "gemini-yes").unwrap();
        assert_eq!(result.cli, "gemini");
    }

    #[test]
    fn test_resolve_args_unsupported_cli() {
        let mut args = default_args();
        args.cli = "unsupported".into();
        assert!(resolve_args(args, "agent-yes").is_err());
    }

    #[test]
    fn test_resolve_args_with_timeout() {
        let mut args = default_args();
        args.timeout = Some("5m".into());
        let result = resolve_args(args, "agent-yes").unwrap();
        assert_eq!(result.timeout_ms, Some(300000));
    }

    #[test]
    fn test_resolve_args_idle_timeout_alias() {
        let mut args = default_args();
        args.idle_timeout = Some("60s".into());
        let result = resolve_args(args, "agent-yes").unwrap();
        assert_eq!(result.timeout_ms, Some(60000));
    }

    #[test]
    fn test_resolve_args_exit_on_idle_alias() {
        let mut args = default_args();
        args.exit_on_idle = Some("30".into());
        let result = resolve_args(args, "agent-yes").unwrap();
        assert_eq!(result.timeout_ms, Some(30000));
    }

    #[test]
    fn test_resolve_args_with_prompt() {
        let mut args = default_args();
        args.prompt = Some("hello world".into());
        let result = resolve_args(args, "agent-yes").unwrap();
        assert_eq!(result.prompt, Some("hello world".into()));
    }

    #[test]
    fn test_resolve_args_prompt_from_trailing() {
        let mut args = default_args();
        args.args = vec!["--".into(), "my".into(), "prompt".into()];
        let result = resolve_args(args, "agent-yes").unwrap();
        assert_eq!(result.prompt, Some("my prompt".into()));
    }

    #[test]
    fn test_resolve_args_auto_no() {
        let mut args = default_args();
        args.auto = "no".into();
        let result = resolve_args(args, "agent-yes").unwrap();
        assert!(!result.auto_yes);
    }

    #[test]
    fn test_resolve_args_auto_yes_case_insensitive() {
        let mut args = default_args();
        args.auto = "NO".into();
        let result = resolve_args(args, "agent-yes").unwrap();
        assert!(!result.auto_yes);
    }

    #[test]
    fn test_resolve_args_swarm() {
        let mut args = default_args();
        args.swarm = Some("my-topic".into());
        let result = resolve_args(args, "agent-yes").unwrap();
        assert_eq!(result.swarm, Some("my-topic".into()));
    }

    #[test]
    fn test_resolve_args_experimental_swarm_compat() {
        let mut args = default_args();
        args.experimental_swarm = true;
        args.swarm_topic = "custom-topic".into();
        let result = resolve_args(args, "agent-yes").unwrap();
        assert_eq!(result.swarm, Some("custom-topic".into()));
    }

    #[test]
    fn test_resolve_args_continue_session() {
        let mut args = default_args();
        args.continue_session = true;
        let result = resolve_args(args, "agent-yes").unwrap();
        assert!(result.continue_session);
    }

    #[test]
    fn test_resolve_args_verbose() {
        let mut args = default_args();
        args.verbose = true;
        let result = resolve_args(args, "agent-yes").unwrap();
        assert!(result.verbose);
    }

    #[test]
    fn test_resolve_args_cwd_default_none() {
        let result = resolve_args(default_args(), "agent-yes").unwrap();
        assert!(result.cwd.is_none());
    }

    #[test]
    fn test_resolve_args_cwd_explicit() {
        let mut args = default_args();
        args.cwd = Some("/tmp".into());
        let result = resolve_args(args, "agent-yes").unwrap();
        assert_eq!(result.cwd, Some("/tmp".into()));
    }

    #[test]
    fn test_resolve_args_invalid_timeout() {
        let mut args = default_args();
        args.timeout = Some("invalid".into());
        assert!(resolve_args(args, "agent-yes").is_err());
    }
}
