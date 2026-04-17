//! Config file loader with cascading support
//! Supports JSON, YAML, YML formats
//! Priority: project-dir > home-dir > package-dir

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use tracing::{debug, warn};

const CONFIG_FILENAME: &str = ".agent-yes.config";
const CONFIG_EXTENSIONS: &[&str] = &[".json", ".yml", ".yaml"];

/// Regex source as a raw pattern or explicit pattern + flags pair.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum RegexSource {
    Pattern(String),
    Structured {
        pattern: String,
        #[serde(default)]
        flags: Option<String>,
    },
}

/// Configuration for a CLI tool (matches TypeScript AgentCliConfig)
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CliConfigOverride {
    /// Installation command(s)
    #[serde(default)]
    pub install: Option<InstallConfigOverride>,
    /// Version command
    #[serde(default)]
    pub version: Option<String>,
    /// Binary name (if different from CLI name)
    #[serde(default)]
    pub binary: Option<String>,
    /// Default args
    #[serde(default)]
    pub default_args: Option<Vec<String>>,
    /// Help URL or hint
    #[serde(default)]
    pub help: Option<String>,
    /// Use bunx metadata
    #[serde(default)]
    pub bunx: Option<bool>,
    /// System prompt flag
    #[serde(default)]
    pub system_prompt: Option<String>,
    /// System prompt content
    #[serde(default)]
    pub system: Option<String>,
    /// Ready patterns
    #[serde(default)]
    pub ready: Option<Vec<RegexSource>>,
    /// Fatal patterns
    #[serde(default)]
    pub fatal: Option<Vec<RegexSource>>,
    /// Working patterns
    #[serde(default)]
    pub working: Option<Vec<RegexSource>>,
    /// Update available patterns
    #[serde(default)]
    pub update_available: Option<Vec<RegexSource>>,
    /// Exit commands
    #[serde(default, alias = "exitCommand")]
    pub exit_commands: Option<Vec<String>>,
    /// Enter patterns
    #[serde(default)]
    pub enter: Option<Vec<RegexSource>>,
    /// Enter exclusion patterns
    #[serde(default)]
    pub enter_exclude: Option<Vec<RegexSource>>,
    /// Prompt argument style
    #[serde(default)]
    pub prompt_arg: Option<String>,
    /// No EOL mode
    #[serde(default, alias = "noEOL")]
    pub no_eol: Option<bool>,
    /// Typing responses (pattern -> response)
    #[serde(default)]
    pub typing_respond: Option<HashMap<String, Vec<RegexSource>>>,
    /// Restore args (for crash recovery)
    #[serde(default)]
    pub restore_args: Option<Vec<String>>,
    /// Restart without continue arg patterns
    #[serde(default)]
    pub restart_without_continue_arg: Option<Vec<RegexSource>>,
}

/// Install configuration override
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum InstallConfigOverride {
    /// Single command string
    Single(String),
    /// Multiple install options
    Multiple {
        #[serde(default)]
        npm: Option<String>,
        #[serde(default)]
        bash: Option<String>,
        #[serde(default)]
        powershell: Option<String>,
        #[serde(default)]
        unix: Option<String>,
        #[serde(default)]
        windows: Option<String>,
    },
}

impl InstallConfigOverride {
    fn merge(&mut self, other: InstallConfigOverride) {
        match other {
            InstallConfigOverride::Single(command) => {
                *self = InstallConfigOverride::Single(command)
            }
            InstallConfigOverride::Multiple {
                npm,
                bash,
                powershell,
                unix,
                windows,
            } => match self {
                InstallConfigOverride::Single(_) => {
                    *self = InstallConfigOverride::Multiple {
                        npm,
                        bash,
                        powershell,
                        unix,
                        windows,
                    };
                }
                InstallConfigOverride::Multiple {
                    npm: existing_npm,
                    bash: existing_bash,
                    powershell: existing_powershell,
                    unix: existing_unix,
                    windows: existing_windows,
                } => {
                    if npm.is_some() {
                        *existing_npm = npm;
                    }
                    if bash.is_some() {
                        *existing_bash = bash;
                    }
                    if powershell.is_some() {
                        *existing_powershell = powershell;
                    }
                    if unix.is_some() {
                        *existing_unix = unix;
                    }
                    if windows.is_some() {
                        *existing_windows = windows;
                    }
                }
            },
        }
    }
}

impl CliConfigOverride {
    fn merge(&mut self, other: CliConfigOverride) {
        let CliConfigOverride {
            install,
            version,
            binary,
            default_args,
            help,
            bunx,
            system_prompt,
            system,
            ready,
            fatal,
            working,
            update_available,
            exit_commands,
            enter,
            enter_exclude,
            prompt_arg,
            no_eol,
            typing_respond,
            restore_args,
            restart_without_continue_arg,
        } = other;

        if let Some(install) = install {
            if let Some(existing_install) = self.install.as_mut() {
                existing_install.merge(install);
            } else {
                self.install = Some(install);
            }
        }
        if version.is_some() {
            self.version = version;
        }
        if binary.is_some() {
            self.binary = binary;
        }
        if default_args.is_some() {
            self.default_args = default_args;
        }
        if help.is_some() {
            self.help = help;
        }
        if bunx.is_some() {
            self.bunx = bunx;
        }
        if system_prompt.is_some() {
            self.system_prompt = system_prompt;
        }
        if system.is_some() {
            self.system = system;
        }
        if ready.is_some() {
            self.ready = ready;
        }
        if fatal.is_some() {
            self.fatal = fatal;
        }
        if working.is_some() {
            self.working = working;
        }
        if update_available.is_some() {
            self.update_available = update_available;
        }
        if exit_commands.is_some() {
            self.exit_commands = exit_commands;
        }
        if enter.is_some() {
            self.enter = enter;
        }
        if enter_exclude.is_some() {
            self.enter_exclude = enter_exclude;
        }
        if prompt_arg.is_some() {
            self.prompt_arg = prompt_arg;
        }
        if no_eol.is_some() {
            self.no_eol = no_eol;
        }
        if let Some(typing_respond) = typing_respond {
            if let Some(existing_typing_respond) = self.typing_respond.as_mut() {
                for (message, patterns) in typing_respond {
                    existing_typing_respond.insert(message, patterns);
                }
            } else {
                self.typing_respond = Some(typing_respond);
            }
        }
        if restore_args.is_some() {
            self.restore_args = restore_args;
        }
        if restart_without_continue_arg.is_some() {
            self.restart_without_continue_arg = restart_without_continue_arg;
        }
    }
}

/// Root configuration structure
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigFile {
    /// Config directory override
    #[serde(default)]
    pub config_dir: Option<String>,
    /// Logs directory override
    #[serde(default)]
    pub logs_dir: Option<String>,
    /// CLI-specific overrides
    #[serde(default)]
    pub clis: HashMap<String, CliConfigOverride>,
}

impl ConfigFile {
    /// Merge another config into this one (other takes precedence)
    pub fn merge(&mut self, other: ConfigFile) {
        if other.config_dir.is_some() {
            self.config_dir = other.config_dir;
        }
        if other.logs_dir.is_some() {
            self.logs_dir = other.logs_dir;
        }
        for (cli_name, cli_config) in other.clis {
            if let Some(existing) = self.clis.get_mut(&cli_name) {
                existing.merge(cli_config);
            } else {
                self.clis.insert(cli_name, cli_config);
            }
        }
    }
}

/// Find config file in a directory (checks all supported extensions)
fn find_config_in_dir(dir: &Path) -> Option<PathBuf> {
    for ext in CONFIG_EXTENSIONS {
        let filepath = dir.join(format!("{}{}", CONFIG_FILENAME, ext));
        if filepath.exists() {
            return Some(filepath);
        }
    }
    None
}

/// Parse config file based on extension
fn parse_config_file(filepath: &Path) -> Result<ConfigFile> {
    let content = fs::read_to_string(filepath)?;
    let ext = filepath.extension().and_then(|e| e.to_str()).unwrap_or("");

    match ext {
        "json" => serde_json::from_str(&content).map_err(|e| anyhow!("JSON parse error: {}", e)),
        "yml" | "yaml" => {
            serde_yaml::from_str(&content).map_err(|e| anyhow!("YAML parse error: {}", e))
        }
        _ => Err(anyhow!("Unsupported config file extension: {}", ext)),
    }
}

/// Load config from a directory if it exists
fn load_config_from_dir(dir: &Path) -> ConfigFile {
    if let Some(filepath) = find_config_in_dir(dir) {
        match parse_config_file(&filepath) {
            Ok(config) => {
                debug!("Loaded config from: {:?}", filepath);
                return config;
            }
            Err(e) => {
                warn!("Failed to parse config file {:?}: {}", filepath, e);
            }
        }
    }
    ConfigFile::default()
}

/// Get the home directory
fn get_home_dir() -> Option<PathBuf> {
    dirs::home_dir()
}

/// Load configs from cascading locations and merge them
/// Priority (highest to lowest): project-dir > home-dir > exe-dir
pub fn load_cascading_config() -> ConfigFile {
    let mut merged = ConfigFile::default();

    // 1. Load from executable directory (lowest priority)
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let config = load_config_from_dir(exe_dir);
            merged.merge(config);
        }
    }

    // 2. Load from home directory
    if let Some(home_dir) = get_home_dir() {
        let config = load_config_from_dir(&home_dir);
        merged.merge(config);
    }

    // 3. Load from current working directory (highest priority)
    if let Ok(cwd) = std::env::current_dir() {
        let config = load_config_from_dir(&cwd);
        merged.merge(config);
    }

    merged
}

/// Get all possible config file paths (for debugging/user info)
pub fn get_config_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();

    // Executable directory
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            for ext in CONFIG_EXTENSIONS {
                paths.push(exe_dir.join(format!("{}{}", CONFIG_FILENAME, ext)));
            }
        }
    }

    // Home directory
    if let Some(home_dir) = get_home_dir() {
        for ext in CONFIG_EXTENSIONS {
            paths.push(home_dir.join(format!("{}{}", CONFIG_FILENAME, ext)));
        }
    }

    // Current working directory
    if let Ok(cwd) = std::env::current_dir() {
        for ext in CONFIG_EXTENSIONS {
            paths.push(cwd.join(format!("{}{}", CONFIG_FILENAME, ext)));
        }
    }

    paths
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::tempdir;

    fn pattern(value: &str) -> RegexSource {
        RegexSource::Pattern(value.to_string())
    }

    fn structured(pattern: &str, flags: &str) -> RegexSource {
        RegexSource::Structured {
            pattern: pattern.to_string(),
            flags: Some(flags.to_string()),
        }
    }

    #[test]
    fn test_parse_json_config() {
        let dir = tempdir().unwrap();
        let config_path = dir.path().join(".agent-yes.config.json");
        let mut file = fs::File::create(&config_path).unwrap();
        writeln!(
            file,
            r#"{{
            "configDir": "/custom/config",
            "clis": {{
                "claude": {{
                    "defaultArgs": ["--verbose"]
                }}
            }}
        }}"#
        )
        .unwrap();

        let config = load_config_from_dir(dir.path());
        assert_eq!(config.config_dir, Some("/custom/config".to_string()));
        assert!(config.clis.contains_key("claude"));
    }

    #[test]
    fn test_parse_yaml_config() {
        let dir = tempdir().unwrap();
        let config_path = dir.path().join(".agent-yes.config.yaml");
        let mut file = fs::File::create(&config_path).unwrap();
        writeln!(
            file,
            r#"
configDir: /custom/config
clis:
  claude:
    defaultArgs:
      - --verbose
"#
        )
        .unwrap();

        let config = load_config_from_dir(dir.path());
        assert_eq!(config.config_dir, Some("/custom/config".to_string()));
        assert!(config.clis.contains_key("claude"));
    }

    #[test]
    fn test_parse_yml_config() {
        let dir = tempdir().unwrap();
        let config_path = dir.path().join(".agent-yes.config.yml");
        let mut file = fs::File::create(&config_path).unwrap();
        writeln!(
            file,
            r#"
logsDir: /custom/logs
"#
        )
        .unwrap();

        let config = load_config_from_dir(dir.path());
        assert_eq!(config.logs_dir, Some("/custom/logs".to_string()));
    }

    #[test]
    fn test_parse_invalid_json() {
        let dir = tempdir().unwrap();
        let config_path = dir.path().join(".agent-yes.config.json");
        let mut file = fs::File::create(&config_path).unwrap();
        writeln!(file, "{{invalid json}}").unwrap();

        // Should return default config on parse error
        let config = load_config_from_dir(dir.path());
        assert!(config.config_dir.is_none());
        assert!(config.clis.is_empty());
    }

    #[test]
    fn test_parse_config_file_unsupported_ext() {
        let dir = tempdir().unwrap();
        let config_path = dir.path().join("config.toml");
        fs::File::create(&config_path).unwrap();

        let result = parse_config_file(&config_path);
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_config_file_no_extension() {
        let dir = tempdir().unwrap();
        let config_path = dir.path().join("config");
        let mut file = fs::File::create(&config_path).unwrap();
        writeln!(file, "{{}}").unwrap();

        let result = parse_config_file(&config_path);
        assert!(result.is_err());
    }

    #[test]
    fn test_find_config_in_dir_none() {
        let dir = tempdir().unwrap();
        assert!(find_config_in_dir(dir.path()).is_none());
    }

    #[test]
    fn test_find_config_in_dir_json_priority() {
        let dir = tempdir().unwrap();
        // Create .json config - should be found first
        fs::File::create(dir.path().join(".agent-yes.config.json")).unwrap();
        let found = find_config_in_dir(dir.path());
        assert!(found.is_some());
        assert!(found.unwrap().to_str().unwrap().ends_with(".json"));
    }

    #[test]
    fn test_load_config_from_dir_missing() {
        let dir = tempdir().unwrap();
        let config = load_config_from_dir(dir.path());
        assert!(config.config_dir.is_none());
        assert!(config.clis.is_empty());
    }

    #[test]
    fn test_merge_configs() {
        let mut base = ConfigFile {
            config_dir: Some("/base".to_string()),
            logs_dir: Some("/base/logs".to_string()),
            clis: HashMap::new(),
        };
        base.clis.insert(
            "claude".to_string(),
            CliConfigOverride {
                binary: Some("claude-bin".to_string()),
                ..Default::default()
            },
        );

        let override_config = ConfigFile {
            config_dir: Some("/override".to_string()),
            logs_dir: None,
            clis: {
                let mut clis = HashMap::new();
                clis.insert(
                    "claude".to_string(),
                    CliConfigOverride {
                        default_args: Some(vec!["--verbose".to_string()]),
                        ..Default::default()
                    },
                );
                clis
            },
        };

        base.merge(override_config);

        assert_eq!(base.config_dir, Some("/override".to_string()));
        assert_eq!(base.logs_dir, Some("/base/logs".to_string()));
        let claude = base.clis.get("claude").unwrap();
        assert_eq!(claude.binary, Some("claude-bin".to_string()));
        assert_eq!(claude.default_args, Some(vec!["--verbose".to_string()]));
    }

    #[test]
    fn test_merge_logs_dir_override() {
        let mut base = ConfigFile {
            config_dir: None,
            logs_dir: Some("/old/logs".to_string()),
            clis: HashMap::new(),
        };
        base.merge(ConfigFile {
            config_dir: None,
            logs_dir: Some("/new/logs".to_string()),
            clis: HashMap::new(),
        });
        assert_eq!(base.logs_dir, Some("/new/logs".to_string()));
    }

    #[test]
    fn test_merge_all_cli_fields() {
        let mut base = ConfigFile::default();
        base.clis.insert(
            "test".to_string(),
            CliConfigOverride {
                install: Some(InstallConfigOverride::Multiple {
                    npm: Some("old".into()),
                    bash: Some("old-bash".into()),
                    powershell: None,
                    unix: None,
                    windows: None,
                }),
                version: Some("old-version".into()),
                binary: Some("old-bin".into()),
                default_args: Some(vec!["old-arg".into()]),
                help: Some("old-help".into()),
                bunx: Some(false),
                system_prompt: Some("--old-system".into()),
                system: Some("old-system-text".into()),
                ready: Some(vec![pattern("old-ready")]),
                fatal: Some(vec![pattern("old-fatal")]),
                working: Some(vec![pattern("old-working")]),
                update_available: Some(vec![pattern("old-update")]),
                exit_commands: Some(vec!["old-exit".into()]),
                enter: Some(vec![pattern("old-enter")]),
                enter_exclude: Some(vec![pattern("old-enter-exclude")]),
                prompt_arg: Some("old-prompt".into()),
                no_eol: Some(false),
                typing_respond: Some(HashMap::from([("1".into(), vec![pattern("old-pattern")])])),
                restore_args: Some(vec!["old-restore".into()]),
                restart_without_continue_arg: Some(vec![pattern("old-restart")]),
            },
        );

        let mut override_clis = HashMap::new();
        let mut tr = HashMap::new();
        tr.insert("y".into(), vec![pattern("pattern")]);
        override_clis.insert(
            "test".to_string(),
            CliConfigOverride {
                install: Some(InstallConfigOverride::Multiple {
                    npm: Some("new".into()),
                    bash: None,
                    powershell: Some("new-ps".into()),
                    unix: Some("new-unix".into()),
                    windows: None,
                }),
                version: Some("new-version".into()),
                binary: Some("new-bin".into()),
                default_args: Some(vec!["new-arg".into()]),
                help: Some("new-help".into()),
                bunx: Some(true),
                system_prompt: Some("--new-system".into()),
                system: Some("new-system-text".into()),
                ready: Some(vec![pattern("new-ready")]),
                fatal: Some(vec![pattern("new-fatal")]),
                working: Some(vec![pattern("new-working")]),
                update_available: Some(vec![pattern("new-update")]),
                exit_commands: Some(vec!["new-exit".into()]),
                enter: Some(vec![pattern("new-enter")]),
                enter_exclude: Some(vec![pattern("new-enter-exclude")]),
                prompt_arg: Some("new-prompt".into()),
                no_eol: Some(true),
                restore_args: Some(vec!["new-restore".into()]),
                typing_respond: Some(tr),
                restart_without_continue_arg: Some(vec![pattern("new-restart")]),
            },
        );

        base.merge(ConfigFile {
            config_dir: None,
            logs_dir: None,
            clis: override_clis,
        });

        let t = base.clis.get("test").unwrap();
        assert_eq!(
            t.install,
            Some(InstallConfigOverride::Multiple {
                npm: Some("new".into()),
                bash: Some("old-bash".into()),
                powershell: Some("new-ps".into()),
                unix: Some("new-unix".into()),
                windows: None,
            })
        );
        assert_eq!(t.version, Some("new-version".into()));
        assert_eq!(t.binary, Some("new-bin".into()));
        assert_eq!(t.default_args, Some(vec!["new-arg".into()]));
        assert_eq!(t.help, Some("new-help".into()));
        assert_eq!(t.bunx, Some(true));
        assert_eq!(t.system_prompt, Some("--new-system".into()));
        assert_eq!(t.system, Some("new-system-text".into()));
        assert_eq!(t.ready, Some(vec![pattern("new-ready")]));
        assert_eq!(t.fatal, Some(vec![pattern("new-fatal")]));
        assert_eq!(t.working, Some(vec![pattern("new-working")]));
        assert_eq!(t.update_available, Some(vec![pattern("new-update")]));
        assert_eq!(t.enter, Some(vec![pattern("new-enter")]));
        assert_eq!(t.enter_exclude, Some(vec![pattern("new-enter-exclude")]));
        assert_eq!(t.prompt_arg, Some("new-prompt".into()));
        assert_eq!(t.restore_args, Some(vec!["new-restore".into()]));
        assert_eq!(t.exit_commands, Some(vec!["new-exit".into()]));
        assert_eq!(t.no_eol, Some(true));
        assert_eq!(
            t.restart_without_continue_arg,
            Some(vec![pattern("new-restart")])
        );
        assert!(t.typing_respond.as_ref().unwrap().contains_key("y"));
        assert!(t.typing_respond.as_ref().unwrap().contains_key("1"));
    }

    #[test]
    fn test_merge_new_cli() {
        let mut base = ConfigFile::default();
        let mut override_clis = HashMap::new();
        override_clis.insert(
            "newcli".to_string(),
            CliConfigOverride {
                binary: Some("new-binary".into()),
                ..Default::default()
            },
        );

        base.merge(ConfigFile {
            config_dir: None,
            logs_dir: None,
            clis: override_clis,
        });

        assert!(base.clis.contains_key("newcli"));
        assert_eq!(
            base.clis.get("newcli").unwrap().binary,
            Some("new-binary".into())
        );
    }

    #[test]
    fn test_config_file_default() {
        let config = ConfigFile::default();
        assert!(config.config_dir.is_none());
        assert!(config.logs_dir.is_none());
        assert!(config.clis.is_empty());
    }

    #[test]
    fn test_get_config_paths() {
        let paths = get_config_paths();
        // Should have paths for exe dir, home dir, and cwd (3 extensions each)
        assert!(!paths.is_empty());
        // All paths should contain the config filename
        for path in &paths {
            assert!(path.to_str().unwrap().contains(".agent-yes.config"));
        }
    }

    #[test]
    fn test_load_cascading_config() {
        // Just ensure it doesn't panic
        let config = load_cascading_config();
        // Returns a valid ConfigFile (may be empty/default)
        let _ = config.config_dir;
        let _ = config.clis;
    }

    #[test]
    fn test_install_config_override_single() {
        let json = r#""npm install -g something""#;
        let parsed: InstallConfigOverride = serde_json::from_str(json).unwrap();
        match parsed {
            InstallConfigOverride::Single(s) => assert_eq!(s, "npm install -g something"),
            _ => panic!("Expected Single variant"),
        }
    }

    #[test]
    fn test_install_config_override_multiple() {
        let json = r#"{"npm": "npm i -g foo", "bash": "curl install.sh"}"#;
        let parsed: InstallConfigOverride = serde_json::from_str(json).unwrap();
        match parsed {
            InstallConfigOverride::Multiple {
                npm,
                bash,
                powershell,
                unix,
                windows,
            } => {
                assert_eq!(npm, Some("npm i -g foo".into()));
                assert_eq!(bash, Some("curl install.sh".into()));
                assert!(powershell.is_none());
                assert!(unix.is_none());
                assert!(windows.is_none());
            }
            _ => panic!("Expected Multiple variant"),
        }
    }

    #[test]
    fn test_parse_structured_regex_and_canonical_exit_commands() {
        let json = r#"{
            "clis": {
                "codex": {
                    "ready": [{"pattern": "^› ", "flags": "m"}],
                    "enterExclude": ["skip me"],
                    "updateAvailable": ["^update$"],
                    "exitCommands": ["/quit"],
                    "noEOL": true
                }
            }
        }"#;

        let parsed: ConfigFile = serde_json::from_str(json).unwrap();
        let codex = parsed.clis.get("codex").unwrap();
        assert_eq!(codex.ready, Some(vec![structured("^› ", "m")]));
        assert_eq!(codex.enter_exclude, Some(vec![pattern("skip me")]));
        assert_eq!(codex.update_available, Some(vec![pattern("^update$")]));
        assert_eq!(codex.exit_commands, Some(vec!["/quit".into()]));
        assert_eq!(codex.no_eol, Some(true));
    }

    #[test]
    fn test_full_json_config_with_all_fields() {
        let dir = tempdir().unwrap();
        let config_path = dir.path().join(".agent-yes.config.json");
        let mut file = fs::File::create(&config_path).unwrap();
        file.write_all(
            br#"{
            "configDir": "/cfg",
            "logsDir": "/logs",
            "clis": {
                "claude": {
                    "binary": "claude-bin",
                    "promptArg": "--prompt",
                    "version": "claude --version",
                    "defaultArgs": ["-v"],
                    "help": "https://example.com/help",
                    "bunx": true,
                    "systemPrompt": "--system",
                    "system": "be strict",
                    "ready": ["ready$"],
                    "fatal": ["fatal$"],
                    "working": ["working$"],
                    "updateAvailable": [{"pattern": "^update$", "flags": "m"}],
                    "enter": ["enter$"],
                    "enterExclude": ["skip-enter$"],
                    "restoreArgs": ["--resume"],
                    "restartWithoutContinueArg": ["session missing"],
                    "exitCommands": ["/quit"],
                    "noEOL": true,
                    "typingRespond": {"y\\n": ["confirm"]},
                    "install": {"npm": "npm i -g claude", "unix": "curl install.sh"}
                }
            }
        }"#,
        )
        .unwrap();

        let config = load_config_from_dir(dir.path());
        assert_eq!(config.config_dir, Some("/cfg".to_string()));
        assert_eq!(config.logs_dir, Some("/logs".to_string()));
        let claude = config.clis.get("claude").unwrap();
        assert_eq!(claude.binary, Some("claude-bin".into()));
        assert_eq!(claude.prompt_arg, Some("--prompt".into()));
        assert_eq!(claude.version, Some("claude --version".into()));
        assert_eq!(claude.help, Some("https://example.com/help".into()));
        assert_eq!(claude.bunx, Some(true));
        assert_eq!(claude.system_prompt, Some("--system".into()));
        assert_eq!(claude.system, Some("be strict".into()));
        assert_eq!(claude.no_eol, Some(true));
        assert_eq!(claude.exit_commands, Some(vec!["/quit".into()]));
        assert_eq!(claude.enter_exclude, Some(vec![pattern("skip-enter$")]));
        assert_eq!(
            claude.update_available,
            Some(vec![structured("^update$", "m")])
        );
        assert_eq!(
            claude.restart_without_continue_arg,
            Some(vec![pattern("session missing")])
        );
        assert!(claude.typing_respond.is_some());
        match claude.install.as_ref().unwrap() {
            InstallConfigOverride::Multiple { npm, unix, .. } => {
                assert_eq!(npm, &Some("npm i -g claude".into()));
                assert_eq!(unix, &Some("curl install.sh".into()));
            }
            _ => panic!("Expected Multiple install config"),
        }
    }
}
