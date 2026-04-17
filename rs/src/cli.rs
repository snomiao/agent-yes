//! CLI argument parsing module

use anyhow::{anyhow, Result};
use clap::{ArgAction, Parser};
use std::env;

/// Supported CLI tools
pub const SUPPORTED_CLIS: &[&str] = &[
    "claude", "gemini", "codex", "copilot", "cursor", "grok", "qwen", "auggie", "amp", "opencode",
];

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
        assert_eq!(SUPPORTED_CLIS.len(), 10);
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
    fn test_resolve_args_invalid_timeout() {
        let mut args = default_args();
        args.timeout = Some("invalid".into());
        assert!(resolve_args(args, "agent-yes").is_err());
    }
}
