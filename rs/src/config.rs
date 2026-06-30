//! CLI tool configuration module

use crate::config_loader::{
    load_cascading_config, CliConfigOverride, ConfigFile, InstallConfigOverride, RegexSource,
};
use anyhow::{anyhow, Context, Result};
use regex::Regex;
use std::collections::HashMap;
#[cfg(test)]
use std::sync::OnceLock;

const BUILTIN_CLI_DEFAULTS: &str = include_str!("../default.config.yaml");

/// Configuration for a CLI tool.
///
/// Several fields (install, version, help, bunx, system_prompt, system,
/// update_available) are populated from the YAML config and consumed by the
/// TS side / external tooling; the Rust runtime reads only a subset today.
/// Keeping them here means a single source of truth for the schema.
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct CliConfig {
    /// How to pass the prompt argument
    pub prompt_arg: String,
    /// Binary name (if different from CLI name)
    pub binary: Option<String>,
    /// Env vars injected into the spawned agent (e.g. glm → Z.AI). Values
    /// support ${VAR} expansion against the launching env at spawn time.
    pub env: HashMap<String, String>,
    /// Install command
    pub install: InstallConfig,
    /// Version command
    pub version: Option<String>,
    /// Help URL or hint
    pub help: Option<String>,
    /// Use bunx metadata
    pub bunx: bool,
    /// System prompt flag
    pub system_prompt: Option<String>,
    /// System prompt content
    pub system: Option<String>,
    /// Ready patterns (agent is ready for input)
    pub ready: Vec<Regex>,
    /// Working patterns (agent is currently processing)
    pub working: Vec<Regex>,
    /// Enter patterns (auto-press Enter)
    pub enter: Vec<Regex>,
    /// Enter exclusion patterns
    pub enter_exclude: Vec<Regex>,
    /// Fatal patterns (exit on match)
    pub fatal: Vec<Regex>,
    /// Auto-retry patterns: on match, type "retry" with exponential backoff
    /// (up to 8h) instead of exiting. Checked before `fatal`.
    pub auto_retry: Vec<Regex>,
    /// Update available banner patterns
    pub update_available: Vec<Regex>,
    /// Typing responses (send text on pattern match)
    pub typing_respond: HashMap<String, Vec<Regex>>,
    /// Restart with continue patterns
    pub restart_without_continue: Vec<Regex>,
    /// Restore args (added on crash restart)
    pub restore_args: Vec<String>,
    /// Exit command
    pub exit_command: Vec<String>,
    /// Default args
    pub default_args: Vec<String>,
    /// Args appended when `-y` / `--yes` is passed — the per-CLI "yolo" flag.
    /// claude maps `-y` to `--dangerously-skip-permissions`; codex maps it to
    /// `--dangerously-bypass-approvals-and-sandbox` (codex rejects the claude
    /// flag, and its bwrap sandbox can't init inside an already-sandboxed/
    /// containerized environment).
    pub yes_args: Vec<String>,
    /// Use cursor-based rendering (no newlines)
    pub no_eol: bool,
    /// No-output watchdog timeout (seconds). While a `working` spinner is on
    /// screen, a live CLI repaints its timer ~every second, so zero visible
    /// output for this long means the API stream silently stalled (the stream
    /// `await` never resolved). On trip: send Esc to cancel; if still stalled,
    /// exit non-zero so a `--robust` run restarts with `--continue`. 0 disables.
    pub stall_timeout_secs: u64,
    /// Liveness window in ms: if we send stdin and the agent produces no PTY
    /// output within this window, mark it `unresponsive`. 0 = disabled.
    pub unresponsive_timeout_ms: u64,
}

/// Built-in no-output watchdog timeout when a CLI doesn't override it. Generous
/// on purpose: real work keeps the spinner's timer ticking (counts as output),
/// so only a frozen render loop reaches this. Override per-CLI via
/// `stallTimeoutSecs` in default.config.yaml or a user config.
pub const DEFAULT_STALL_TIMEOUT_SECS: u64 = 300;

/// Install command catalogue per-platform. Currently consumed only by the TS
/// side; mirrored here so the YAML schema round-trips cleanly through Rust.
#[allow(dead_code)]
#[derive(Debug, Clone, Default)]
pub struct InstallConfig {
    pub single: Option<String>,
    pub npm: Option<String>,
    pub bash: Option<String>,
    pub powershell: Option<String>,
    pub unix: Option<String>,
    pub windows: Option<String>,
}

/// Get configuration for a specific CLI.
/// All configs are compiled once and cached for the process lifetime.
#[cfg(test)]
pub fn get_cli_config(cli: &str) -> Result<CliConfig> {
    static CONFIGS: OnceLock<Result<HashMap<String, CliConfig>, String>> = OnceLock::new();
    let configs = CONFIGS.get_or_init(|| load_builtin_cli_configs().map_err(|err| err.to_string()));
    let configs = configs
        .as_ref()
        .map_err(|err| anyhow!("Failed to load CLI defaults: {}", err))?;

    configs
        .get(cli)
        .cloned()
        .ok_or_else(|| anyhow!("Unknown CLI: {}", cli))
}

/// Get configuration for a specific CLI with runtime cascading overrides applied.
pub fn get_runtime_cli_config(cli: &str) -> Result<CliConfig> {
    let mut merged = load_builtin_config_file()?;
    merged.merge(load_cascading_config());

    build_cli_configs(merged)?
        .remove(cli)
        .ok_or_else(|| anyhow!("Unknown CLI: {}", cli))
}

#[cfg(test)]
fn load_builtin_cli_configs() -> Result<HashMap<String, CliConfig>> {
    build_cli_configs(load_builtin_config_file()?)
}

fn load_builtin_config_file() -> Result<ConfigFile> {
    serde_yaml::from_str(BUILTIN_CLI_DEFAULTS)
        .context("Failed to parse embedded default.config.yaml")
}

fn build_cli_configs(config: ConfigFile) -> Result<HashMap<String, CliConfig>> {
    config
        .clis
        .into_iter()
        .map(|(name, raw)| {
            build_cli_config(raw)
                .with_context(|| format!("Failed to build CLI config for '{}'", name))
                .map(|cfg| (name, cfg))
        })
        .collect()
}

fn build_cli_config(raw: CliConfigOverride) -> Result<CliConfig> {
    Ok(CliConfig {
        prompt_arg: raw.prompt_arg.unwrap_or_else(|| "last-arg".to_string()),
        binary: raw.binary,
        env: raw.env.unwrap_or_default(),
        install: compile_install_config(raw.install),
        version: raw.version,
        help: raw.help,
        bunx: raw.bunx.unwrap_or(false),
        system_prompt: raw.system_prompt,
        system: raw.system,
        ready: compile_regex_list(raw.ready)?,
        working: compile_regex_list(raw.working)?,
        enter: compile_regex_list(raw.enter)?,
        enter_exclude: compile_regex_list(raw.enter_exclude)?,
        fatal: compile_regex_list(raw.fatal)?,
        auto_retry: compile_regex_list(raw.auto_retry)?,
        update_available: compile_regex_list(raw.update_available)?,
        typing_respond: compile_typing_respond(raw.typing_respond)?,
        restart_without_continue: compile_regex_list(raw.restart_without_continue_arg)?,
        restore_args: raw.restore_args.unwrap_or_default(),
        exit_command: raw.exit_commands.unwrap_or_default(),
        default_args: raw.default_args.unwrap_or_default(),
        yes_args: raw.yes_args.unwrap_or_default(),
        no_eol: raw.no_eol.unwrap_or(false),
        stall_timeout_secs: raw.stall_timeout_secs.unwrap_or(DEFAULT_STALL_TIMEOUT_SECS),
        unresponsive_timeout_ms: raw.unresponsive_timeout_ms.unwrap_or(0),
    })
}

fn compile_install_config(install: Option<InstallConfigOverride>) -> InstallConfig {
    match install {
        Some(InstallConfigOverride::Single(command)) => InstallConfig {
            single: Some(command),
            ..InstallConfig::default()
        },
        Some(InstallConfigOverride::Multiple {
            npm,
            bash,
            powershell,
            unix,
            windows,
        }) => InstallConfig {
            single: None,
            npm,
            bash,
            powershell,
            unix,
            windows,
        },
        None => InstallConfig::default(),
    }
}

fn compile_typing_respond(
    typing_respond: Option<HashMap<String, Vec<RegexSource>>>,
) -> Result<HashMap<String, Vec<Regex>>> {
    typing_respond
        .unwrap_or_default()
        .into_iter()
        .map(|(message, sources)| {
            compile_regex_list(Some(sources)).map(|compiled| (message, compiled))
        })
        .collect()
}

fn compile_regex_list(sources: Option<Vec<RegexSource>>) -> Result<Vec<Regex>> {
    sources
        .unwrap_or_default()
        .into_iter()
        .map(compile_regex)
        .collect()
}

fn compile_regex(source: RegexSource) -> Result<Regex> {
    let (pattern, flags) = match source {
        RegexSource::Pattern(pattern) => (pattern, None),
        RegexSource::Structured { pattern, flags } => (pattern, flags),
    };

    let inline_flags = compile_inline_flags(flags.as_deref().unwrap_or(""))?;
    let compiled = format!("{}{}", inline_flags, pattern);
    Regex::new(&compiled).with_context(|| format!("Invalid regex pattern '{}'", pattern))
}

fn compile_inline_flags(flags: &str) -> Result<String> {
    if flags.is_empty() {
        return Ok(String::new());
    }

    let mut normalized = String::new();
    for flag in flags.chars() {
        match flag {
            'i' | 'm' | 's' | 'x' | 'U' => normalized.push(flag),
            'u' => {}
            other => return Err(anyhow!("Unsupported regex flag '{}'", other)),
        }
    }

    if normalized.is_empty() {
        Ok(String::new())
    } else {
        Ok(format!("(?{})", normalized))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn merged_config_from_yaml(cli: &str, yaml: &str) -> CliConfig {
        let mut merged = load_builtin_config_file().unwrap();
        let overrides: ConfigFile = serde_yaml::from_str(yaml).unwrap();
        merged.merge(overrides);
        build_cli_configs(merged).unwrap().remove(cli).unwrap()
    }

    #[test]
    fn test_get_cli_config() {
        let config = get_cli_config("claude").unwrap();
        assert_eq!(config.prompt_arg, "last-arg");
        assert!(!config.ready.is_empty());
        assert!(!config.enter.is_empty());
        // `-y` maps to claude's own permission-skip flag.
        assert_eq!(config.yes_args, vec!["--dangerously-skip-permissions"]);
    }

    #[test]
    fn test_unknown_cli() {
        let result = get_cli_config("unknown");
        assert!(result.is_err());
    }

    #[test]
    fn test_claude_patterns() {
        let config = get_cli_config("claude").unwrap();
        assert!(config.ready[0].is_match("? for shortcuts"));
        // Index-agnostic: the `enter` list grows as new prompts are added.
        assert!(config.enter.iter().any(|rx| rx.is_match("❯ 1. Yes")));
        assert!(config
            .enter
            .iter()
            .any(|rx| rx.is_match("Press Enter to continue")));
        assert!(!config.working.is_empty());
        assert!(config.working[0].is_match("esc to interrupt"));
        assert!(!config.fatal.is_empty());
        assert!(config.fatal[0].is_match("error: unknown option '--foo'"));
        // Usage-limit / overload are now auto-retried (typed "retry"), not fatal.
        assert!(!config.auto_retry.is_empty());
        assert!(config
            .auto_retry
            .iter()
            .any(|rx| rx.is_match("Claude usage limit reached")));
        assert!(config
            .auto_retry
            .iter()
            .any(|rx| rx.is_match("● API Error: Overloaded")));
        // 5xx API errors (e.g. a 529 rendered as a raw JSON blob, no "Overloaded"
        // wording) must also auto-retry…
        assert!(config.auto_retry.iter().any(|rx| rx
            .is_match(r#"● API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}"#)));
        assert!(config
            .auto_retry
            .iter()
            .any(|rx| rx.is_match("API Error: 503 Service Unavailable")));
        // A stalled/aborted SSE stream prints no status code but is just as
        // transient — it must auto-retry too…
        assert!(config.auto_retry.iter().any(|rx| rx.is_match(
            "API Error: Response stalled mid-stream. The response above may be incomplete."
        )));
        // …including when the terminal wraps "mid-stream" across rows…
        assert!(config
            .auto_retry
            .iter()
            .any(|rx| rx.is_match("API Error: Response stalled mid-\nstream.")));
        // …but the agent merely *discussing* a stalled mid-stream (docs, commit
        // messages, this feature's own PR) must NOT self-trigger a retry — the
        // "API Error:" chrome anchor is what separates the real banner from prose.
        assert!(!config.auto_retry.iter().any(
            |rx| rx.is_match("shipped the Response stalled mid-stream auto-retry in v1.153.0")
        ));
        assert!(!config
            .auto_retry
            .iter()
            .any(|rx| rx.is_match("the download stalled mid-stream so I retried it")));
        // A dropped connection mid-response is the same transient class — it must
        // auto-retry too…
        assert!(config.auto_retry.iter().any(|rx| rx.is_match(
            "API Error: Connection closed mid-response. The response above may be incomplete."
        )));
        // …including when the terminal wraps "mid-response" across rows…
        assert!(config
            .auto_retry
            .iter()
            .any(|rx| rx.is_match("API Error: Connection closed mid-\nresponse.")));
        // …but an agent merely *discussing* a closed connection (prose, commit
        // messages) must NOT self-trigger a retry — the "API Error:" anchor is
        // what separates the real banner from narration.
        assert!(!config.auto_retry.iter().any(|rx| rx
            .is_match("the connection closed mid-response so claude lost the tail of the answer")));
        assert!(!config
            .auto_retry
            .iter()
            .any(|rx| rx.is_match("added a Connection closed mid-response auto-retry pattern")));
        // …but a stray status-like number in normal output must NOT.
        assert!(!config
            .auto_retry
            .iter()
            .any(|rx| rx.is_match("processed 529 files in 500ms")));
        assert!(!config.typing_respond.is_empty());
        assert!(config.typing_respond.contains_key("1\n"));
        assert_eq!(config.restore_args, vec!["--continue"]);
        assert!(!config.restart_without_continue.is_empty());
        assert_eq!(config.exit_command, vec!["/exit"]);
        assert!(config.default_args.is_empty());
        assert!(!config.no_eol);
        assert!(config.binary.is_none());
        assert_eq!(config.system_prompt, Some("--append-system-prompt".into()));
        assert!(config.system.is_none());
        assert!(config.bunx);
        assert!(config.enter_exclude.is_empty());
        assert!(config.update_available.is_empty());
        assert!(config.install.single.is_none());
        assert!(config.install.bash.is_some());
        assert!(config.install.powershell.is_some());
        assert!(config.install.npm.is_some());
    }

    #[test]
    fn test_gemini_config() {
        let config = get_cli_config("gemini").unwrap();
        assert_eq!(config.prompt_arg, "last-arg");
        assert!(config.binary.is_none());
        assert!(config.install.npm.is_some());
        assert!(config.install.bash.is_none());
        assert!(!config.ready.is_empty());
        assert!(config.ready[0].is_match("Type your message"));
        assert!(config.working.is_empty());
        assert!(!config.enter.is_empty());
        assert!(!config.fatal.is_empty());
        assert!(config.fatal[0].is_match("Error resuming session"));
        assert_eq!(config.restore_args, vec!["--resume"]);
        assert!(!config.restart_without_continue.is_empty());
        assert!(!config.exit_command.is_empty());
        assert!(config.update_available.is_empty());
        assert!(!config.no_eol);
        assert!(config.typing_respond.is_empty());
    }

    #[test]
    fn test_codex_config() {
        let config = get_cli_config("codex").unwrap();
        assert_eq!(config.prompt_arg, "first-arg");
        assert!(config.binary.is_none());
        assert!(config.install.npm.is_some());
        assert!(!config.ready.is_empty());
        assert!(config.ready[0].is_match("⏎ send"));
        assert!(config.ready.iter().any(|rx| rx.is_match("› ")));
        assert!(!config.enter.is_empty());
        // codex 0.140 highlights the selected option with "›" (U+203A); the
        // enter patterns must match that glyph (the old ASCII ">" never did).
        assert!(config
            .enter
            .iter()
            .any(|rx| rx.is_match("› 1. Yes, proceed (y)")));
        assert!(config
            .enter
            .iter()
            .any(|rx| rx.is_match("› 1. Approve and run now")));
        // …and not the non-affirmative option when it is the highlighted one.
        assert!(!config
            .enter
            .iter()
            .any(|rx| rx.is_match("› 3. No, and tell Codex what to do differently (esc)")));
        assert!(!config.working.is_empty());
        assert!(config.working[0].is_match("Working (10s • esc to interrupt)"));
        assert!(!config.fatal.is_empty());
        assert!(!config.update_available.is_empty());
        assert!(config.update_available[0].is_match("✨⬆️ Update available!"));
        assert!(config.restore_args.is_empty());
        assert!(config.restart_without_continue.is_empty());
        assert!(config.exit_command.is_empty());
        assert_eq!(config.default_args, vec!["--search"]);
        // `-y` maps to codex's bypass flag — NOT claude's --dangerously-skip-
        // permissions (codex rejects it) — and it also skips codex's bwrap
        // sandbox, which can't init inside an already-sandboxed container.
        assert_eq!(
            config.yes_args,
            vec!["--dangerously-bypass-approvals-and-sandbox"]
        );
        assert!(config.no_eol);
    }

    #[test]
    fn test_copilot_config() {
        let config = get_cli_config("copilot").unwrap();
        assert_eq!(config.prompt_arg, "-i");
        assert!(config.binary.is_none());
        assert!(config.install.npm.is_some());
        assert!(!config.ready.is_empty());
        assert!(config.ready[1].is_match("Ctrl+c Exit"));
        assert!(!config.enter.is_empty());
        assert!(config.fatal.is_empty());
        assert!(config.restore_args.is_empty());
        assert_eq!(
            config.system,
            Some("IMPORTANT: USE TOOLS TO RESEARCH/EXPLORE/WORKAROUND your self, except you need approve on DESTRUCTIVE OPERATIONS, DONT ASK QUESTIONS ON USERS REQUEST, JUST SOLVE IT.".into())
        );
        assert!(!config.no_eol);
    }

    #[test]
    fn test_cursor_config() {
        let config = get_cli_config("cursor").unwrap();
        assert_eq!(config.prompt_arg, "last-arg");
        assert_eq!(config.binary, Some("cursor-agent".to_string()));
        assert!(config.install.npm.is_none());
        assert!(config.install.bash.is_some());
        assert!(!config.ready.is_empty());
        assert!(config.ready[0].is_match("/ commands"));
        assert!(!config.enter.is_empty());
        assert!(!config.fatal.is_empty());
        assert!(config.fatal[0].is_match("Error: You've hit your usage limit"));
        assert!(config.bunx);
        assert!(!config.no_eol);
    }

    #[test]
    fn test_grok_config() {
        let config = get_cli_config("grok").unwrap();
        assert_eq!(config.prompt_arg, "last-arg");
        assert!(config.binary.is_none());
        assert!(config.install.npm.is_some());
        assert!(!config.ready.is_empty());
        assert!(!config.enter.is_empty());
        assert!(config.fatal.is_empty());
        assert!(config.restore_args.is_empty());
        assert!(!config.no_eol);
    }

    #[test]
    fn test_qwen_config() {
        let config = get_cli_config("qwen").unwrap();
        assert_eq!(config.prompt_arg, "last-arg");
        assert!(config.binary.is_none());
        assert!(config.install.npm.is_some());
        assert_eq!(config.version, Some("qwen --version".into()));
        assert!(config.ready.is_empty());
        assert!(config.working.is_empty());
        assert!(config.enter.is_empty());
        assert!(config.fatal.is_empty());
        assert!(config.typing_respond.is_empty());
        assert!(!config.no_eol);
    }

    #[test]
    fn test_auggie_config() {
        let config = get_cli_config("auggie").unwrap();
        assert_eq!(config.prompt_arg, "first-arg");
        assert!(config.binary.is_none());
        assert!(config.install.npm.is_some());
        assert!(!config.ready.is_empty());
        assert!(config.ready[1].is_match("? to show shortcuts"));
        assert!(!config.typing_respond.is_empty());
        assert!(config.typing_respond.contains_key("y\n"));
        assert_eq!(
            config.help,
            Some("https://docs.augmentcode.com/cli/overview".into())
        );
        assert!(config.enter.is_empty());
        assert!(!config.no_eol);
    }

    #[test]
    fn test_amp_config() {
        let config = get_cli_config("amp").unwrap();
        assert_eq!(config.prompt_arg, "last-arg");
        assert!(config.binary.is_none());
        assert!(config.install.bash.is_some());
        assert!(config.install.npm.is_some());
        assert_eq!(config.help, Some("https://ampcode.com/".into()));
        assert!(config.ready.is_empty());
        assert!(!config.enter.is_empty());
        assert!(config.enter[0].is_match("  Approve "));
        assert!(config.fatal.is_empty());
        assert!(!config.no_eol);
    }

    #[test]
    fn test_opencode_config() {
        let config = get_cli_config("opencode").unwrap();
        assert_eq!(config.prompt_arg, "last-arg");
        assert!(config.binary.is_none());
        assert!(config.install.bash.is_some());
        assert!(config.install.npm.is_some());
        assert_eq!(config.help, Some("https://opencode.ai/".into()));
        assert!(config.ready.is_empty());
        assert!(config.enter.is_empty());
        assert!(config.fatal.is_empty());
        assert!(!config.no_eol);
    }

    #[test]
    fn test_install_config_default() {
        let ic = InstallConfig::default();
        assert!(ic.single.is_none());
        assert!(ic.npm.is_none());
        assert!(ic.bash.is_none());
        assert!(ic.powershell.is_none());
        assert!(ic.unix.is_none());
        assert!(ic.windows.is_none());
    }

    #[test]
    fn test_merged_config_compiles_runtime_overrides() {
        let config = merged_config_from_yaml(
            "codex",
            r#"
clis:
  codex:
    install: npm install -g custom-codex
    ready:
      - pattern: '^custom ready$'
        flags: m
    enterExclude:
      - '^skip-enter$'
    updateAvailable:
      - '^custom update$'
    exitCommands:
      - /quit
"#,
        );

        assert_eq!(
            config.install.single,
            Some("npm install -g custom-codex".into())
        );
        assert!(config.install.npm.is_none());
        assert_eq!(config.exit_command, vec!["/quit"]);
        assert_eq!(config.ready.len(), 1);
        assert!(config.ready[0].is_match("custom ready"));
        assert_eq!(config.enter_exclude.len(), 1);
        assert!(config.enter_exclude[0].is_match("skip-enter"));
        assert_eq!(config.update_available.len(), 1);
        assert!(config.update_available[0].is_match("custom update"));
    }

    #[test]
    fn test_all_supported_clis() {
        let clis = vec![
            "claude", "gemini", "codex", "copilot", "cursor", "grok", "qwen", "auggie", "amp",
            "opencode",
        ];
        for cli in clis {
            let result = get_cli_config(cli);
            assert!(result.is_ok(), "Failed for CLI: {}", cli);
        }
    }
}
