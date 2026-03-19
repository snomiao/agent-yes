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

/// Configuration for a CLI tool (matches TypeScript AgentCliConfig)
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliConfigOverride {
    /// Installation command(s)
    #[serde(default)]
    pub install: Option<InstallConfigOverride>,
    /// Binary name (if different from CLI name)
    #[serde(default)]
    pub binary: Option<String>,
    /// Default args
    #[serde(default)]
    pub default_args: Option<Vec<String>>,
    /// Ready patterns (regex strings)
    #[serde(default)]
    pub ready: Option<Vec<String>>,
    /// Fatal patterns (regex strings)
    #[serde(default)]
    pub fatal: Option<Vec<String>>,
    /// Working patterns (regex strings)
    #[serde(default)]
    pub working: Option<Vec<String>>,
    /// Enter patterns (regex strings)
    #[serde(default)]
    pub enter: Option<Vec<String>>,
    /// Prompt argument style
    #[serde(default)]
    pub prompt_arg: Option<String>,
    /// Restore args (for crash recovery)
    #[serde(default)]
    pub restore_args: Option<Vec<String>>,
    /// Exit commands
    #[serde(default)]
    pub exit_command: Option<Vec<String>>,
    /// Typing responses (pattern -> response)
    #[serde(default)]
    pub typing_respond: Option<HashMap<String, Vec<String>>>,
    /// No EOL mode
    #[serde(default)]
    pub no_eol: Option<bool>,
}

/// Install configuration override
#[derive(Debug, Clone, Serialize, Deserialize)]
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
    },
}

/// Root configuration structure
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
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
                // Merge CLI config
                if cli_config.install.is_some() {
                    existing.install = cli_config.install;
                }
                if cli_config.binary.is_some() {
                    existing.binary = cli_config.binary;
                }
                if cli_config.default_args.is_some() {
                    existing.default_args = cli_config.default_args;
                }
                if cli_config.ready.is_some() {
                    existing.ready = cli_config.ready;
                }
                if cli_config.fatal.is_some() {
                    existing.fatal = cli_config.fatal;
                }
                if cli_config.working.is_some() {
                    existing.working = cli_config.working;
                }
                if cli_config.enter.is_some() {
                    existing.enter = cli_config.enter;
                }
                if cli_config.prompt_arg.is_some() {
                    existing.prompt_arg = cli_config.prompt_arg;
                }
                if cli_config.restore_args.is_some() {
                    existing.restore_args = cli_config.restore_args;
                }
                if cli_config.exit_command.is_some() {
                    existing.exit_command = cli_config.exit_command;
                }
                if cli_config.typing_respond.is_some() {
                    existing.typing_respond = cli_config.typing_respond;
                }
                if cli_config.no_eol.is_some() {
                    existing.no_eol = cli_config.no_eol;
                }
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
    let ext = filepath
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");

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
        assert_eq!(
            claude.default_args,
            Some(vec!["--verbose".to_string()])
        );
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
        base.clis.insert("test".to_string(), CliConfigOverride {
            install: Some(InstallConfigOverride::Single("old".into())),
            binary: Some("old-bin".into()),
            default_args: Some(vec!["old-arg".into()]),
            ready: Some(vec!["old-ready".into()]),
            fatal: Some(vec!["old-fatal".into()]),
            working: Some(vec!["old-working".into()]),
            enter: Some(vec!["old-enter".into()]),
            prompt_arg: Some("old-prompt".into()),
            restore_args: Some(vec!["old-restore".into()]),
            exit_command: Some(vec!["old-exit".into()]),
            typing_respond: Some(HashMap::new()),
            no_eol: Some(false),
        });

        let mut override_clis = HashMap::new();
        let mut tr = HashMap::new();
        tr.insert("y".into(), vec!["pattern".into()]);
        override_clis.insert("test".to_string(), CliConfigOverride {
            install: Some(InstallConfigOverride::Single("new".into())),
            binary: Some("new-bin".into()),
            default_args: Some(vec!["new-arg".into()]),
            ready: Some(vec!["new-ready".into()]),
            fatal: Some(vec!["new-fatal".into()]),
            working: Some(vec!["new-working".into()]),
            enter: Some(vec!["new-enter".into()]),
            prompt_arg: Some("new-prompt".into()),
            restore_args: Some(vec!["new-restore".into()]),
            exit_command: Some(vec!["new-exit".into()]),
            typing_respond: Some(tr),
            no_eol: Some(true),
        });

        base.merge(ConfigFile {
            config_dir: None,
            logs_dir: None,
            clis: override_clis,
        });

        let t = base.clis.get("test").unwrap();
        assert_eq!(t.binary, Some("new-bin".into()));
        assert_eq!(t.default_args, Some(vec!["new-arg".into()]));
        assert_eq!(t.ready, Some(vec!["new-ready".into()]));
        assert_eq!(t.fatal, Some(vec!["new-fatal".into()]));
        assert_eq!(t.working, Some(vec!["new-working".into()]));
        assert_eq!(t.enter, Some(vec!["new-enter".into()]));
        assert_eq!(t.prompt_arg, Some("new-prompt".into()));
        assert_eq!(t.restore_args, Some(vec!["new-restore".into()]));
        assert_eq!(t.exit_command, Some(vec!["new-exit".into()]));
        assert_eq!(t.no_eol, Some(true));
        assert!(t.typing_respond.as_ref().unwrap().contains_key("y"));
    }

    #[test]
    fn test_merge_new_cli() {
        let mut base = ConfigFile::default();
        let mut override_clis = HashMap::new();
        override_clis.insert("newcli".to_string(), CliConfigOverride {
            binary: Some("new-binary".into()),
            ..Default::default()
        });

        base.merge(ConfigFile {
            config_dir: None,
            logs_dir: None,
            clis: override_clis,
        });

        assert!(base.clis.contains_key("newcli"));
        assert_eq!(base.clis.get("newcli").unwrap().binary, Some("new-binary".into()));
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
            InstallConfigOverride::Multiple { npm, bash, powershell } => {
                assert_eq!(npm, Some("npm i -g foo".into()));
                assert_eq!(bash, Some("curl install.sh".into()));
                assert!(powershell.is_none());
            }
            _ => panic!("Expected Multiple variant"),
        }
    }

    #[test]
    fn test_full_json_config_with_all_fields() {
        let dir = tempdir().unwrap();
        let config_path = dir.path().join(".agent-yes.config.json");
        let mut file = fs::File::create(&config_path).unwrap();
        writeln!(
            file,
            r#"{{
            "configDir": "/cfg",
            "logsDir": "/logs",
            "clis": {{
                "claude": {{
                    "binary": "claude-bin",
                    "promptArg": "--prompt",
                    "defaultArgs": ["-v"],
                    "ready": ["ready$"],
                    "fatal": ["fatal$"],
                    "working": ["working$"],
                    "enter": ["enter$"],
                    "restoreArgs": ["--resume"],
                    "exitCommand": ["/quit"],
                    "noEol": true,
                    "typingRespond": {{"y\\n": ["confirm"]}}
                }}
            }}
        }}"#
        )
        .unwrap();

        let config = load_config_from_dir(dir.path());
        assert_eq!(config.config_dir, Some("/cfg".to_string()));
        assert_eq!(config.logs_dir, Some("/logs".to_string()));
        let claude = config.clis.get("claude").unwrap();
        assert_eq!(claude.binary, Some("claude-bin".into()));
        assert_eq!(claude.prompt_arg, Some("--prompt".into()));
        assert_eq!(claude.no_eol, Some(true));
        assert!(claude.typing_respond.is_some());
    }
}
