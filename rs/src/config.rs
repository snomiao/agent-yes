//! CLI tool configuration module

use crate::config_loader::{
    load_cascading_config, CliConfigOverride, ConfigFile, InstallConfigOverride, RegexSource,
};
use anyhow::{anyhow, Context, Result};
use regex::Regex;
use std::collections::HashMap;
#[cfg(test)]
use std::sync::OnceLock;

const BUILTIN_CLI_DEFAULTS: &str = include_str!("../../default.config.yaml");

/// Configuration for a CLI tool
#[derive(Debug, Clone)]
pub struct CliConfig {
    /// How to pass the prompt argument
    pub prompt_arg: String,
    /// Binary name (if different from CLI name)
    pub binary: Option<String>,
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
    /// Use cursor-based rendering (no newlines)
    pub no_eol: bool,
}

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
        update_available: compile_regex_list(raw.update_available)?,
        typing_respond: compile_typing_respond(raw.typing_respond)?,
        restart_without_continue: compile_regex_list(raw.restart_without_continue_arg)?,
        restore_args: raw.restore_args.unwrap_or_default(),
        exit_command: raw.exit_commands.unwrap_or_default(),
        default_args: raw.default_args.unwrap_or_default(),
        no_eol: raw.no_eol.unwrap_or(false),
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
        assert!(config.enter[2].is_match("❯ 1. Yes"));
        assert!(config
            .enter
            .iter()
            .any(|rx| rx.is_match("Press Enter to continue")));
        assert!(!config.working.is_empty());
        assert!(config.working[0].is_match("esc to interrupt"));
        assert!(!config.fatal.is_empty());
        assert!(config.fatal[0].is_match("Claude usage limit reached"));
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
        assert!(!config.fatal.is_empty());
        assert!(!config.update_available.is_empty());
        assert!(config.update_available[0].is_match("✨⬆️ Update available!"));
        assert!(config.restore_args.is_empty());
        assert!(config.restart_without_continue.is_empty());
        assert!(config.exit_command.is_empty());
        assert_eq!(config.default_args, vec!["--search"]);
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
