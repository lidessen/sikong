use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct SikoConfig {
    pub version: u32,
    pub assistant: AssistantConfig,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct AssistantConfig {
    pub max_parallel_tasks: usize,
}

impl Default for SikoConfig {
    fn default() -> Self {
        Self {
            version: 1,
            assistant: AssistantConfig::default(),
        }
    }
}

impl Default for AssistantConfig {
    fn default() -> Self {
        Self {
            max_parallel_tasks: 2,
        }
    }
}

impl SikoConfig {
    pub fn load() -> Result<Self, config::ConfigError> {
        let path = config_path_from_env();
        Self::load_from_path_and_env(&path)
    }

    pub fn load_from_path_and_env(path: &Path) -> Result<Self, config::ConfigError> {
        let builder = config::Config::builder()
            .set_default("version", 1)?
            .set_default("assistant.max_parallel_tasks", 2)?
            .add_source(config::File::from(path).required(false))
            .add_source(
                config::Environment::with_prefix("SIKONG_CONFIG")
                    .prefix_separator("__")
                    .separator("__"),
            );

        builder.build()?.try_deserialize()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DebugConfig {
    pub data_dir: Option<PathBuf>,
    pub runtime_dir: Option<PathBuf>,
    pub bun_command: Option<String>,
    pub agent_host_command: Option<String>,
    pub agent_host_script: Option<String>,
}

impl DebugConfig {
    pub fn from_env() -> Self {
        Self::from_lookup(&|name| std::env::var(name).ok())
    }

    pub fn from_lookup(env: &dyn Fn(&str) -> Option<String>) -> Self {
        Self {
            data_dir: non_empty_env(env, "SIKONG_DATA_DIR")
                .map(|path| expand_home(Path::new(&path))),
            runtime_dir: non_empty_env(env, "SIKONG_RUNTIME_DIR")
                .map(|path| expand_home(Path::new(&path))),
            bun_command: non_empty_env(env, "SIKONG_BUN_COMMAND"),
            agent_host_command: non_empty_env(env, "SIKONG_AGENT_HOST_COMMAND"),
            agent_host_script: non_empty_env(env, "SIKONG_AGENT_HOST_SCRIPT"),
        }
    }

    pub fn data_dir(&self) -> PathBuf {
        self.data_dir.clone().unwrap_or_else(default_data_dir)
    }

    pub fn bun_command(&self) -> String {
        self.bun_command
            .clone()
            .unwrap_or_else(|| "bun".to_string())
    }
}

pub fn default_config_path() -> PathBuf {
    DebugConfig::from_env().data_dir().join("config.yaml")
}

fn config_path_from_env() -> PathBuf {
    std::env::var_os("SIKONG_CONFIG_FILE")
        .map(PathBuf::from)
        .map(|path| expand_home(&path))
        .unwrap_or_else(default_config_path)
}

fn default_data_dir() -> PathBuf {
    std::env::var_os("SIKONG_DATA_DIR")
        .map(PathBuf::from)
        .map(|path| expand_home(&path))
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".sikong")))
        .unwrap_or_else(|| PathBuf::from(".sikong"))
}

fn expand_home(path: &Path) -> PathBuf {
    let raw = path.to_string_lossy();
    if raw == "~" {
        return std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| path.to_path_buf());
    }
    if let Some(rest) = raw.strip_prefix("~/") {
        return std::env::var_os("HOME")
            .map(|home| PathBuf::from(home).join(rest))
            .unwrap_or_else(|| path.to_path_buf());
    }
    path.to_path_buf()
}

fn non_empty_env(env: &dyn Fn(&str) -> Option<String>, name: &str) -> Option<String> {
    env(name).and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use config::{Config, Environment, File};
    use std::collections::BTreeMap;
    use std::collections::HashMap;
    use std::fs;

    #[test]
    fn loads_user_config_from_yaml() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("config.yaml");
        fs::write(&path, "version: 1\nassistant:\n  max_parallel_tasks: 3\n").unwrap();

        let loaded = SikoConfig::load_from_path_and_env(&path).unwrap();

        assert_eq!(loaded.assistant.max_parallel_tasks, 3);
    }

    #[test]
    fn rejects_debug_fields_in_user_config_yaml() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("config.yaml");
        fs::write(
            &path,
            "version: 1\nagent_host:\n  command: /tmp/siko-agent-host\n",
        )
        .unwrap();

        let error = SikoConfig::load_from_path_and_env(&path).unwrap_err();

        assert!(error.to_string().contains("unknown field"));
    }

    #[test]
    fn debug_env_fields_do_not_pollute_user_config() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("missing.yaml");
        let config = Config::builder()
            .set_default("version", 1)
            .unwrap()
            .set_default("assistant.max_parallel_tasks", 2)
            .unwrap()
            .add_source(File::from(path).required(false))
            .add_source(
                Environment::with_prefix("SIKONG_CONFIG")
                    .prefix_separator("__")
                    .separator("__")
                    .source(Some(HashMap::from([(
                        "SIKONG_AGENT_HOST_COMMAND".to_string(),
                        "/tmp/siko-agent-host".to_string(),
                    )]))),
            )
            .build()
            .unwrap()
            .try_deserialize::<SikoConfig>()
            .unwrap();

        assert_eq!(config.assistant.max_parallel_tasks, 2);
    }

    #[test]
    fn debug_config_reads_only_debug_env_shape() {
        let env = BTreeMap::from([
            ("SIKONG_AGENT_HOST_COMMAND", "/tmp/siko-agent-host"),
            ("SIKONG_CONFIG__ASSISTANT__MAX_PARALLEL_TASKS", "3"),
        ]);
        let debug = DebugConfig::from_lookup(&|name| env.get(name).map(|value| value.to_string()));

        assert_eq!(
            debug.agent_host_command,
            Some("/tmp/siko-agent-host".to_string())
        );
        assert_eq!(debug.agent_host_script, None);
    }
}
