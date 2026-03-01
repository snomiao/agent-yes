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
    pub robust: bool,
    pub continue_session: bool,
    pub verbose: bool,
    pub auto_yes: bool,
    pub install: bool,
    pub queue: bool,
    pub use_skills: bool,
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

    let cli_from_name = detect_cli_from_name(&exe_name);

    let args = Args::parse();

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
        robust: args.robust,
        continue_session: args.continue_session,
        verbose: args.verbose,
        auto_yes: args.auto.to_lowercase() != "no",
        install: args.install,
        queue: args.queue,
        use_skills: args.use_skills,
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

/// Extract prompt from args (handles -- separator)
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

    (args, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_cli_from_name() {
        assert_eq!(detect_cli_from_name("claude-yes"), Some("claude".into()));
        assert_eq!(detect_cli_from_name("gemini-yes"), Some("gemini".into()));
        assert_eq!(detect_cli_from_name("agent-yes"), None);
    }

    #[test]
    fn test_parse_duration() {
        assert_eq!(parse_duration("60s").unwrap(), 60000);
        assert_eq!(parse_duration("1m").unwrap(), 60000);
        assert_eq!(parse_duration("5m").unwrap(), 300000);
        assert_eq!(parse_duration("60").unwrap(), 60000);
    }

    #[test]
    fn test_extract_prompt() {
        let args = vec!["--flag".into(), "--".into(), "my".into(), "prompt".into()];
        let (cli_args, prompt) = extract_prompt_from_args(args, None);
        assert_eq!(cli_args, vec!["--flag"]);
        assert_eq!(prompt, Some("my prompt".into()));
    }

    #[test]
    fn test_extract_cli_from_args() {
        // CLI as first arg
        let args = vec!["codex".into(), "hello".into(), "world".into()];
        let (cli, remaining) = extract_cli_from_args(&args);
        assert_eq!(cli, Some("codex".into()));
        assert_eq!(remaining, vec!["hello", "world"]);

        // CLI with -yes suffix
        let args = vec!["codex-yes".into(), "hello".into()];
        let (cli, remaining) = extract_cli_from_args(&args);
        assert_eq!(cli, Some("codex".into()));
        assert_eq!(remaining, vec!["hello"]);

        // No CLI in args
        let args = vec!["--flag".into(), "value".into()];
        let (cli, remaining) = extract_cli_from_args(&args);
        assert_eq!(cli, None);
        assert_eq!(remaining, vec!["--flag", "value"]);

        // Empty args
        let args: Vec<String> = vec![];
        let (cli, remaining) = extract_cli_from_args(&args);
        assert_eq!(cli, None);
        assert!(remaining.is_empty());
    }
}
