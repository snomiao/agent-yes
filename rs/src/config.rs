//! CLI tool configuration module

use anyhow::{anyhow, Result};
use regex::Regex;
use std::collections::HashMap;

/// Configuration for a CLI tool
#[derive(Debug, Clone)]
pub struct CliConfig {
    /// How to pass the prompt argument
    pub prompt_arg: String,
    /// Binary name (if different from CLI name)
    pub binary: Option<String>,
    /// Install command
    pub install: InstallConfig,
    /// Ready patterns (agent is ready for input)
    pub ready: Vec<Regex>,
    /// Working patterns (agent is currently processing)
    pub working: Vec<Regex>,
    /// Enter patterns (auto-press Enter)
    pub enter: Vec<Regex>,
    /// Fatal patterns (exit on match)
    pub fatal: Vec<Regex>,
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

#[derive(Debug, Clone)]
pub struct InstallConfig {
    pub npm: Option<String>,
    pub bash: Option<String>,
    pub powershell: Option<String>,
}

impl Default for InstallConfig {
    fn default() -> Self {
        Self {
            npm: None,
            bash: None,
            powershell: None,
        }
    }
}

/// Get configuration for a specific CLI
pub fn get_cli_config(cli: &str) -> Result<CliConfig> {
    match cli {
        "claude" => Ok(claude_config()),
        "gemini" => Ok(gemini_config()),
        "codex" => Ok(codex_config()),
        "copilot" => Ok(copilot_config()),
        "cursor" => Ok(cursor_config()),
        "grok" => Ok(grok_config()),
        "qwen" => Ok(qwen_config()),
        "auggie" => Ok(auggie_config()),
        "amp" => Ok(amp_config()),
        "opencode" => Ok(opencode_config()),
        _ => Err(anyhow!("Unknown CLI: {}", cli)),
    }
}

fn claude_config() -> CliConfig {
    CliConfig {
        prompt_arg: "last-arg".to_string(),
        binary: None,
        install: InstallConfig {
            powershell: Some(
                r#"powershell -Command "irm https://claude.ai/install.ps1 | iex""#.to_string(),
            ),
            bash: Some("curl -fsSL https://claude.ai/install.sh | bash".to_string()),
            npm: Some("npm i -g @anthropic-ai/claude-code@latest".to_string()),
        },
        ready: vec![
            Regex::new(r"\? for shortcuts").unwrap(),
            Regex::new(r"\u{00A0}Try ").unwrap(),
            Regex::new(r"^\? for shortcuts").unwrap(),
            Regex::new(r"^>[ \u{00A0}]").unwrap(),
            Regex::new(r"─{10,}").unwrap(),
        ],
        working: vec![
            Regex::new(r"esc to interrupt").unwrap(),
            Regex::new(r"to run in background").unwrap(),
        ],
        typing_respond: {
            let mut map = HashMap::new();
            map.insert(
                "1\n".to_string(),
                vec![Regex::new(r"Do you want to use this API key\?").unwrap()],
            );
            map
        },
        enter: vec![
            Regex::new(r" > 1\. Yes, I trust this folder").unwrap(),
            Regex::new(r"❯ ?1\. ?Dark mode").unwrap(),
            Regex::new(r"❯ ?1\. ?Yes").unwrap(),
            Regex::new(r"^.{0,4} ?1\. ?Dark mode").unwrap(),
            Regex::new(r"^.{0,4} ?1\. ?Yes").unwrap(),
            Regex::new(r"Press Enter to continue").unwrap(),
        ],
        fatal: vec![
            Regex::new(r"Claude usage limit reached").unwrap(),
            Regex::new(r"^error: unknown option").unwrap(),
        ],
        restore_args: vec!["--continue".to_string()],
        restart_without_continue: vec![
            Regex::new(r"No conversation found to continue").unwrap(),
        ],
        exit_command: vec!["/exit".to_string()],
        default_args: vec![],
        no_eol: false,
    }
}

fn gemini_config() -> CliConfig {
    CliConfig {
        prompt_arg: "last-arg".to_string(),
        binary: None,
        install: InstallConfig {
            npm: Some("npm install -g @google/gemini-cli@latest".to_string()),
            bash: None,
            powershell: None,
        },
        ready: vec![Regex::new(r"Type your message").unwrap()],
        working: vec![],
        typing_respond: HashMap::new(),
        enter: vec![
            Regex::new(r"│ ● 1\. Yes, allow once").unwrap(),
            Regex::new(r"│ ● 1\. Allow once").unwrap(),
        ],
        fatal: vec![
            Regex::new(r"Error resuming session").unwrap(),
            Regex::new(r"No previous sessions found for this project").unwrap(),
        ],
        restore_args: vec!["--resume".to_string()],
        restart_without_continue: vec![
            Regex::new(r"No previous sessions found for this project").unwrap(),
            Regex::new(r"Error resuming session").unwrap(),
        ],
        exit_command: vec!["/chat save ${PWD}".to_string(), "/quit".to_string()],
        default_args: vec![],
        no_eol: false,
    }
}

fn codex_config() -> CliConfig {
    CliConfig {
        prompt_arg: "first-arg".to_string(),
        binary: None,
        install: InstallConfig {
            npm: Some("npm install -g @openai/codex@latest".to_string()),
            bash: None,
            powershell: None,
        },
        ready: vec![
            Regex::new(r"⏎ send").unwrap(),
            Regex::new(r"\? for shortcuts").unwrap(),
        ],
        working: vec![],
        typing_respond: HashMap::new(),
        enter: vec![
            Regex::new(r"› 1\. Yes,").unwrap(),
            Regex::new(r"> 1\. Yes,").unwrap(),
            Regex::new(r"> 1\. Approve and run now").unwrap(),
            Regex::new(r"› 1\. Approve and run now").unwrap(),
        ],
        fatal: vec![Regex::new(r"Error: The cursor position could not be read within").unwrap()],
        restore_args: vec![],
        restart_without_continue: vec![],
        exit_command: vec![],
        default_args: vec!["--search".to_string()],
        no_eol: true,
    }
}

fn copilot_config() -> CliConfig {
    CliConfig {
        prompt_arg: "-i".to_string(),
        binary: None,
        install: InstallConfig {
            npm: Some("npm install -g @github/copilot".to_string()),
            bash: None,
            powershell: None,
        },
        ready: vec![
            Regex::new(r"^ +> ").unwrap(),
            Regex::new(r"Ctrl\+c Exit").unwrap(),
        ],
        working: vec![],
        typing_respond: HashMap::new(),
        enter: vec![
            Regex::new(r" │ ❯ +1\. Yes, proceed").unwrap(),
            Regex::new(r" ❯ +1\. Yes").unwrap(),
        ],
        fatal: vec![],
        restore_args: vec![],
        restart_without_continue: vec![],
        exit_command: vec![],
        default_args: vec![],
        no_eol: false,
    }
}

fn cursor_config() -> CliConfig {
    CliConfig {
        prompt_arg: "last-arg".to_string(),
        binary: Some("cursor-agent".to_string()),
        install: InstallConfig {
            npm: None,
            bash: Some("open https://cursor.com/ja/docs/cli/installation".to_string()),
            powershell: None,
        },
        ready: vec![Regex::new(r"/ commands").unwrap()],
        working: vec![],
        typing_respond: HashMap::new(),
        enter: vec![
            Regex::new(r"→ Run \(once\) \(y\) \(enter\)").unwrap(),
            Regex::new(r"▶ \[a\] Trust this workspace").unwrap(),
        ],
        fatal: vec![Regex::new(r"Error: You've hit your usage limit").unwrap()],
        restore_args: vec![],
        restart_without_continue: vec![],
        exit_command: vec![],
        default_args: vec![],
        no_eol: false,
    }
}

fn grok_config() -> CliConfig {
    CliConfig {
        prompt_arg: "last-arg".to_string(),
        binary: None,
        install: InstallConfig {
            npm: Some("npm install -g @vibe-kit/grok-cli@latest".to_string()),
            bash: None,
            powershell: None,
        },
        ready: vec![Regex::new(r"^  │ ❯ +").unwrap()],
        working: vec![],
        typing_respond: HashMap::new(),
        enter: vec![Regex::new(r"^   1\. Yes").unwrap()],
        fatal: vec![],
        restore_args: vec![],
        restart_without_continue: vec![],
        exit_command: vec![],
        default_args: vec![],
        no_eol: false,
    }
}

fn qwen_config() -> CliConfig {
    CliConfig {
        prompt_arg: "last-arg".to_string(),
        binary: None,
        install: InstallConfig {
            npm: Some("npm install -g @qwen-code/qwen-code@latest".to_string()),
            bash: None,
            powershell: None,
        },
        ready: vec![],
        working: vec![],
        typing_respond: HashMap::new(),
        enter: vec![],
        fatal: vec![],
        restore_args: vec![],
        restart_without_continue: vec![],
        exit_command: vec![],
        default_args: vec![],
        no_eol: false,
    }
}

fn auggie_config() -> CliConfig {
    CliConfig {
        prompt_arg: "first-arg".to_string(),
        binary: None,
        install: InstallConfig {
            npm: Some("npm install -g @augmentcode/auggie".to_string()),
            bash: None,
            powershell: None,
        },
        ready: vec![
            Regex::new(r" > ").unwrap(),
            Regex::new(r"\? to show shortcuts").unwrap(),
        ],
        working: vec![],
        typing_respond: {
            let mut map = HashMap::new();
            map.insert(
                "y\n".to_string(),
                vec![Regex::new(r"\[Y\] Enable indexing - Unlock full workspace understanding")
                    .unwrap()],
            );
            map
        },
        enter: vec![],
        fatal: vec![],
        restore_args: vec![],
        restart_without_continue: vec![],
        exit_command: vec![],
        default_args: vec![],
        no_eol: false,
    }
}

fn amp_config() -> CliConfig {
    CliConfig {
        prompt_arg: "last-arg".to_string(),
        binary: None,
        install: InstallConfig {
            bash: Some("curl -fsSL https://ampcode.com/install.sh | bash".to_string()),
            npm: Some("npm i -g @sourcegraph/amp".to_string()),
            powershell: None,
        },
        ready: vec![],
        working: vec![],
        typing_respond: HashMap::new(),
        enter: vec![Regex::new(r"^.{0,4} Approve ").unwrap()],
        fatal: vec![],
        restore_args: vec![],
        restart_without_continue: vec![],
        exit_command: vec![],
        default_args: vec![],
        no_eol: false,
    }
}

fn opencode_config() -> CliConfig {
    CliConfig {
        prompt_arg: "last-arg".to_string(),
        binary: None,
        install: InstallConfig {
            bash: Some("curl -fsSL https://opencode.ai/install | bash".to_string()),
            npm: Some("npm i -g opencode-ai".to_string()),
            powershell: None,
        },
        ready: vec![],
        working: vec![],
        typing_respond: HashMap::new(),
        enter: vec![],
        fatal: vec![],
        restore_args: vec![],
        restart_without_continue: vec![],
        exit_command: vec![],
        default_args: vec![],
        no_eol: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(!config.enter.is_empty());
        assert!(!config.fatal.is_empty());
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
        assert!(config.ready.is_empty());
        assert!(config.enter.is_empty());
        assert!(config.fatal.is_empty());
        assert!(!config.no_eol);
    }

    #[test]
    fn test_install_config_default() {
        let ic = InstallConfig::default();
        assert!(ic.npm.is_none());
        assert!(ic.bash.is_none());
        assert!(ic.powershell.is_none());
    }

    #[test]
    fn test_all_supported_clis() {
        // Ensure every CLI in the match returns Ok
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
