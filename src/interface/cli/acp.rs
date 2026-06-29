use std::path::{Path, PathBuf};

use clap::Subcommand;
use serde_json::{Value, json};

use super::print_json_data;

#[derive(Debug, Clone, Subcommand)]
pub enum AcpCommand {
    /// Install editor ACP client configuration.
    Install {
        #[command(subcommand)]
        target: AcpInstallCommand,
    },
}

#[derive(Debug, Clone, Subcommand)]
pub enum AcpInstallCommand {
    /// Register `siko acp` as a custom Zed agent server.
    Zed {
        /// Path to Zed settings.json. Defaults to the platform Zed settings path.
        #[arg(long)]
        settings_path: Option<PathBuf>,

        /// Command path Zed should execute. Defaults to the current siko binary.
        #[arg(long)]
        command: Option<PathBuf>,

        /// Print the merged settings without writing them.
        #[arg(long)]
        dry_run: bool,

        /// Print structured JSON output.
        #[arg(long)]
        json: bool,
    },
}

pub fn run_acp_command(command: AcpCommand) -> Result<(), Box<dyn std::error::Error>> {
    match command {
        AcpCommand::Install {
            target:
                AcpInstallCommand::Zed {
                    settings_path,
                    command,
                    dry_run,
                    json,
                },
        } => install_zed(settings_path, command, dry_run, json),
    }
}

fn install_zed(
    settings_path: Option<PathBuf>,
    command: Option<PathBuf>,
    dry_run: bool,
    json_output: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let settings_path = settings_path.unwrap_or_else(default_zed_settings_path);
    let command = command.unwrap_or(current_siko_command()?);
    let command = command.to_string_lossy().to_string();
    let existing = read_settings(&settings_path)?;
    let (updated, changed) = zed_settings_with_siko_agent(existing, &command)?;

    if !dry_run {
        write_settings(&settings_path, &updated)?;
    }

    if json_output {
        print_json_data(json!({
            "client": "zed",
            "settings_path": settings_path,
            "command": command,
            "args": ["acp"],
            "dry_run": dry_run,
            "changed": changed,
            "settings": updated,
        }));
    } else if dry_run {
        println!("Would install Sikong ACP for Zed");
        println!("settings: {}", settings_path.display());
        println!("command: {command}");
    } else {
        println!("Installed Sikong ACP for Zed");
        println!("settings: {}", settings_path.display());
        println!("command: {command}");
    }

    Ok(())
}

fn current_siko_command() -> Result<PathBuf, Box<dyn std::error::Error>> {
    Ok(std::env::current_exe()?)
}

fn default_zed_settings_path() -> PathBuf {
    if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(home_dir)
            .join("Zed")
            .join("settings.json")
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir().join(".config"))
            .join("zed")
            .join("settings.json")
    }
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn read_settings(path: &PathBuf) -> Result<Value, Box<dyn std::error::Error>> {
    if !path.exists() {
        return Ok(json!({}));
    }
    let text = std::fs::read_to_string(path)?;
    if text.trim().is_empty() {
        return Ok(json!({}));
    }
    Ok(json5::from_str(&text).map_err(|err| {
        format!(
            "failed to parse {} as Zed settings JSON/JSONC: {err}",
            path.display()
        )
    })?)
}

fn write_settings(path: &PathBuf, settings: &Value) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if path.exists() {
        std::fs::copy(path, backup_path(path))?;
    }
    let text = serde_json::to_string_pretty(settings)? + "\n";
    let temp_path = path.with_extension("json.tmp");
    std::fs::write(&temp_path, text)?;
    std::fs::rename(temp_path, path)?;
    Ok(())
}

fn backup_path(path: &Path) -> PathBuf {
    let mut backup = path.to_path_buf();
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!("{value}.bak"))
        .unwrap_or_else(|| "bak".to_string());
    backup.set_extension(extension);
    backup
}

fn zed_settings_with_siko_agent(
    mut settings: Value,
    command: &str,
) -> Result<(Value, bool), Box<dyn std::error::Error>> {
    if !settings.is_object() {
        return Err("Zed settings root must be a JSON object".into());
    }
    let before = settings.clone();
    let root = settings.as_object_mut().expect("checked object");
    let agent_servers = root
        .entry("agent_servers".to_string())
        .or_insert_with(|| json!({}));
    let Some(agent_servers) = agent_servers.as_object_mut() else {
        return Err("Zed settings field `agent_servers` must be a JSON object".into());
    };

    let siko = agent_servers
        .entry("siko".to_string())
        .or_insert_with(|| json!({}));
    if !siko.is_object() {
        *siko = json!({});
    }
    let siko = siko.as_object_mut().expect("siko entry is object");
    siko.insert("type".to_string(), json!("custom"));
    siko.insert("command".to_string(), json!(command));
    siko.insert("args".to_string(), json!(["acp"]));
    siko.entry("env".to_string()).or_insert_with(|| json!({}));

    let changed = settings != before;
    Ok((settings, changed))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zed_settings_adds_siko_agent_and_preserves_existing_servers() {
        let input = json!({
            "theme": "Ayu Dark",
            "agent_servers": {
                "other": {
                    "type": "custom",
                    "command": "other-agent"
                }
            }
        });

        let (settings, changed) = zed_settings_with_siko_agent(input, "/tmp/siko").unwrap();

        assert!(changed);
        assert_eq!(settings["theme"], "Ayu Dark");
        assert_eq!(settings["agent_servers"]["other"]["command"], "other-agent");
        assert_eq!(settings["agent_servers"]["siko"]["type"], "custom");
        assert_eq!(settings["agent_servers"]["siko"]["command"], "/tmp/siko");
        assert_eq!(settings["agent_servers"]["siko"]["args"], json!(["acp"]));
        assert_eq!(settings["agent_servers"]["siko"]["env"], json!({}));
    }

    #[test]
    fn zed_settings_updates_existing_siko_agent_but_preserves_env() {
        let input = json!({
            "agent_servers": {
                "siko": {
                    "type": "custom",
                    "command": "/old/siko",
                    "args": ["assistant", "--acp"],
                    "env": {"SIKONG_DATA_DIR": "/tmp/data"}
                }
            }
        });

        let (settings, changed) = zed_settings_with_siko_agent(input, "/new/siko").unwrap();

        assert!(changed);
        assert_eq!(settings["agent_servers"]["siko"]["command"], "/new/siko");
        assert_eq!(settings["agent_servers"]["siko"]["args"], json!(["acp"]));
        assert_eq!(
            settings["agent_servers"]["siko"]["env"]["SIKONG_DATA_DIR"],
            "/tmp/data"
        );
    }

    #[test]
    fn zed_settings_rejects_non_object_agent_servers() {
        let input = json!({"agent_servers": []});

        let error = zed_settings_with_siko_agent(input, "/tmp/siko").unwrap_err();

        assert!(
            error
                .to_string()
                .contains("agent_servers` must be a JSON object")
        );
    }

    #[test]
    fn read_settings_accepts_zed_jsonc() {
        let temp_dir = tempfile::tempdir().unwrap();
        let settings_path = temp_dir.path().join("settings.json");
        std::fs::write(
            &settings_path,
            r#"
// Zed settings
{
  "theme": {
    "mode": "system",
    "dark": "One Dark",
  },
}
"#,
        )
        .unwrap();

        let settings = read_settings(&settings_path).unwrap();

        assert_eq!(settings["theme"]["mode"], "system");
        assert_eq!(settings["theme"]["dark"], "One Dark");
    }

    #[test]
    fn write_settings_creates_backup_for_existing_file() {
        let temp_dir = tempfile::tempdir().unwrap();
        let settings_path = temp_dir.path().join("settings.json");
        std::fs::write(&settings_path, "{\"theme\":\"old\"}\n").unwrap();

        write_settings(&settings_path, &json!({"theme": "new"})).unwrap();

        let backup = std::fs::read_to_string(temp_dir.path().join("settings.json.bak")).unwrap();
        let updated = std::fs::read_to_string(settings_path).unwrap();
        assert!(backup.contains("old"));
        assert!(updated.contains("new"));
    }
}
