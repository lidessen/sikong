use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct SikoConfig {
    pub version: u32,
    /// Active provider (deepseek, claude, codex, etc.)
    pub provider: Option<String>,
    /// Active backend (ai-sdk, claude-code, codex)
    pub backend: Option<String>,
    pub assistant: AssistantConfig,
    pub worker: WorkerConfig,
    /// Per-provider configuration (model, env, etc.)
    #[serde(default)]
    pub providers: std::collections::HashMap<String, ProviderConfig>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Default)]
#[serde(default)]
pub struct ProviderConfig {
    /// Model for this provider
    pub model: Option<String>,
    /// Environment overrides for this provider
    #[serde(default)]
    pub env: std::collections::HashMap<String, String>,
}


#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct AssistantConfig {
    /// Override provider for assistant (inherits from global if not set)
    pub provider: Option<String>,
    /// Override backend for assistant (inherits from global if not set)
    pub backend: Option<String>,
    pub max_parallel_tasks: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
pub struct WorkerConfig {
    /// Override provider for engine/worker tasks (inherits from global if not set)
    pub provider: Option<String>,
    /// Override backend for engine/worker tasks (inherits from global if not set)
    pub backend: Option<String>,
}

/// Resolve effective provider for a component.
/// Priority: component override > global > env var > default
pub fn resolve_provider(
    component: &Option<String>,
    global: &Option<String>,
) -> String {
    component
        .clone()
        .or_else(|| global.clone())
        .or_else(|| std::env::var("SIKONG_PROVIDER").ok())
        .unwrap_or_else(|| "deepseek".to_string())
}

/// Resolve effective backend for a component.
/// Priority: component override > global > env var > default
pub fn resolve_backend(
    component: &Option<String>,
    global: &Option<String>,
) -> String {
    component
        .clone()
        .or_else(|| global.clone())
        .or_else(|| std::env::var("SIKONG_BACKEND").ok())
        .unwrap_or_else(|| "ai-sdk".to_string())
}

impl Default for SikoConfig {
    fn default() -> Self {
        Self {
            version: 1,
            provider: None,
            backend: None,
            assistant: AssistantConfig::default(),
            worker: WorkerConfig::default(),
            providers: std::collections::HashMap::new(),
        }
    }
}

impl Default for AssistantConfig {
    fn default() -> Self {
        Self {
            provider: None,
            backend: None,
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

    /// Apply env overrides from the current provider's config.
    pub fn apply_env(&self) {
        if let Some(active) = &self.provider
            && let Some(pc) = self.providers.get(active)
        {
            for (key, value) in &pc.env {
                if std::env::var(key).is_err() {
                    unsafe { std::env::set_var(key, value) };
                }
            }
        }
    }

    /// Get the model for the current provider.
    pub fn current_model(&self) -> Option<&str> {
        self.provider
            .as_ref()
            .and_then(|p| self.providers.get(p))
            .and_then(|pc| pc.model.as_deref())
    }

    pub fn assistant_provider(&self) -> String {
        resolve_provider(&self.assistant.provider, &self.provider)
    }

    pub fn assistant_backend(&self) -> String {
        resolve_backend(&self.assistant.backend, &self.backend)
    }

    pub fn worker_provider(&self) -> String {
        resolve_provider(&self.worker.provider, &self.provider)
    }

    pub fn worker_backend(&self) -> String {
        resolve_backend(&self.worker.backend, &self.backend)
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

pub fn non_empty_env(env: &dyn Fn(&str) -> Option<String>, name: &str) -> Option<String> {
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

    // ── expand_home tests ───────────────────────────────────────────────

    #[test]
    fn expand_home_tilde_alone_resolves_to_home() {
        let result = expand_home(Path::new("~"));
        let home = std::env::var_os("HOME").map(PathBuf::from).unwrap();
        assert_eq!(result, home);
    }

    #[test]
    fn expand_home_tilde_slash_prepends_home() {
        let result = expand_home(Path::new("~/sikong"));
        let home = std::env::var_os("HOME").map(PathBuf::from).unwrap();
        assert_eq!(result, home.join("sikong"));
    }

    #[test]
    fn expand_home_tilde_slash_nested_path() {
        let result = expand_home(Path::new("~/workspaces/sikong/config.yaml"));
        let home = std::env::var_os("HOME").map(PathBuf::from).unwrap();
        assert_eq!(result, home.join("workspaces/sikong/config.yaml"));
    }

    #[test]
    fn expand_home_absolute_path_unchanged() {
        let result = expand_home(Path::new("/usr/local/etc"));
        assert_eq!(result, PathBuf::from("/usr/local/etc"));
    }

    #[test]
    fn expand_home_relative_path_unchanged() {
        let result = expand_home(Path::new("relative/path/to/config.yaml"));
        assert_eq!(result, PathBuf::from("relative/path/to/config.yaml"));
    }

    #[test]
    fn expand_home_tilde_username_not_expanded() {
        // ~user should not be expanded — only bare ~ and ~/ are expanded
        let result = expand_home(Path::new("~other/config.yaml"));
        assert_eq!(result, PathBuf::from("~other/config.yaml"));
    }

    #[test]
    fn expand_home_empty_path_unchanged() {
        let result = expand_home(Path::new(""));
        assert_eq!(result, PathBuf::from(""));
    }

    #[test]
    fn expand_home_double_tilde_not_expanded() {
        let result = expand_home(Path::new("~~"));
        assert_eq!(result, PathBuf::from("~~"));
    }

    #[test]
    fn expand_home_tilde_with_trailing_slash() {
        let result = expand_home(Path::new("~/"));
        let home = std::env::var_os("HOME").map(PathBuf::from).unwrap();
        assert_eq!(result, home.join(""));
    }

    // ── non_empty_env tests ──────────────────────────────────────────────

    #[test]
    fn non_empty_env_returns_value_for_normal_input() {
        let env = |name: &str| -> Option<String> {
            match name {
                "MY_VAR" => Some("hello".to_string()),
                _ => None,
            }
        };
        assert_eq!(non_empty_env(&env, "MY_VAR"), Some("hello".to_string()));
    }

    #[test]
    fn non_empty_env_returns_none_for_empty_value() {
        let env = |name: &str| -> Option<String> {
            match name {
                "EMPTY" => Some("".to_string()),
                _ => None,
            }
        };
        assert_eq!(non_empty_env(&env, "EMPTY"), None);
    }

    #[test]
    fn non_empty_env_returns_none_for_whitespace_value() {
        let env = |name: &str| -> Option<String> {
            match name {
                "WS" => Some("   ".to_string()),
                _ => None,
            }
        };
        assert_eq!(non_empty_env(&env, "WS"), None);
    }

    #[test]
    fn non_empty_env_trims_whitespace() {
        let env = |name: &str| -> Option<String> {
            match name {
                "PADDED" => Some("  value  ".to_string()),
                _ => None,
            }
        };
        assert_eq!(non_empty_env(&env, "PADDED"), Some("value".to_string()));
    }

    #[test]
    fn non_empty_env_returns_none_for_missing_var() {
        let env = |_: &str| -> Option<String> { None };
        assert_eq!(non_empty_env(&env, "MISSING"), None);
    }

    #[test]
    fn config_resolves_component_inheritance() {
        // Global only — both components inherit
        let cfg = SikoConfig {
            version: 1,
            provider: Some("deepseek".to_string()),
            backend: Some("ai-sdk".to_string()),
            providers: std::collections::HashMap::new(),
            assistant: AssistantConfig::default(),
            worker: WorkerConfig::default(),
        };
        assert_eq!(cfg.assistant_provider(), "deepseek");
        assert_eq!(cfg.assistant_backend(), "ai-sdk");
        assert_eq!(cfg.worker_provider(), "deepseek");
        assert_eq!(cfg.worker_backend(), "ai-sdk");
    }

    #[test]
    fn config_component_override_beats_global() {
        // Component overrides global
        let cfg = SikoConfig {
            version: 1,
            provider: Some("deepseek".to_string()),
            backend: Some("ai-sdk".to_string()),
            providers: std::collections::HashMap::new(),
            assistant: AssistantConfig {
                provider: Some("kimi".to_string()),
                backend: Some("claude-code".to_string()),
                max_parallel_tasks: 2,
            },
            worker: WorkerConfig::default(),
        };
        assert_eq!(cfg.assistant_provider(), "kimi");
        assert_eq!(cfg.assistant_backend(), "claude-code");
        assert_eq!(cfg.worker_provider(), "deepseek"); // inherits global
        assert_eq!(cfg.worker_backend(), "ai-sdk");     // inherits global
    }

    #[test]
    fn config_defaults_when_none_set() {
        let cfg = SikoConfig::default();
        assert_eq!(cfg.assistant_provider(), "deepseek");
        assert_eq!(cfg.assistant_backend(), "ai-sdk");
        assert_eq!(cfg.worker_provider(), "deepseek");
        assert_eq!(cfg.worker_backend(), "ai-sdk");
    }

    // ── resolve_provider tests ──────────────────────────────────────────

    #[test]
    fn resolve_provider_component_override_beats_global() {
        let result = resolve_provider(&Some("claude".to_string()), &Some("deepseek".to_string()));
        assert_eq!(result, "claude");
    }

    #[test]
    fn resolve_provider_global_used_when_component_none() {
        let result = resolve_provider(&None, &Some("deepseek".to_string()));
        assert_eq!(result, "deepseek");
    }

    #[test]
    fn resolve_provider_default_when_both_none() {
        let result = resolve_provider(&None, &None);
        assert_eq!(result, "deepseek");
    }

    #[test]
    fn resolve_provider_component_none_with_empty_global_returns_default() {
        let result = resolve_provider(&None, &None);
        assert_eq!(result, "deepseek");
    }

    // ── resolve_backend tests ──────────────────────────────────────────

    #[test]
    fn resolve_backend_component_override_beats_global() {
        let result = resolve_backend(&Some("claude-code".to_string()), &Some("ai-sdk".to_string()));
        assert_eq!(result, "claude-code");
    }

    #[test]
    fn resolve_backend_global_used_when_component_none() {
        let result = resolve_backend(&None, &Some("ai-sdk".to_string()));
        assert_eq!(result, "ai-sdk");
    }

    #[test]
    fn resolve_backend_default_when_both_none() {
        let result = resolve_backend(&None, &None);
        assert_eq!(result, "ai-sdk");
    }

    #[test]
    fn resolve_backend_component_none_with_empty_global_returns_default() {
        let result = resolve_backend(&None, &None);
        assert_eq!(result, "ai-sdk");
    }

    #[test]
    fn resolve_provider_and_backend_are_independent() {
        let provider = resolve_provider(&Some("claude".to_string()), &Some("deepseek".to_string()));
        let backend = resolve_backend(&None, &Some("ai-sdk".to_string()));
        assert_eq!(provider, "claude");
        assert_eq!(backend, "ai-sdk");
    }
}
