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

    /// Deprecated: Exit on idle
    #[arg(long, hide = true)]
    exit_on_idle: Option<String>,

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

    // Use detected CLI if not explicitly set
    let cli = if cli_from_name.is_some() && args.cli == "claude" {
        cli_from_name.unwrap()
    } else {
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

    // Parse timeout
    let timeout_str = args.timeout.or(args.exit_on_idle);
    let timeout_ms = timeout_str.map(|s| parse_duration(&s)).transpose()?;

    // Parse prompt from trailing args (after --)
    let (cli_args, prompt) = extract_prompt_from_args(args.args, args.prompt);

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
    })
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
}
