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
        assert_eq!(base.logs_dir, Some("/base/logs".to_string())); // Not overridden
        let claude = base.clis.get("claude").unwrap();
        assert_eq!(claude.binary, Some("claude-bin".to_string())); // Not overridden
        assert_eq!(
            claude.default_args,
            Some(vec!["--verbose".to_string()])
        ); // Overridden
    }
}
