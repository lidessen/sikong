use std::path::PathBuf;

use super::print_json_data;

pub fn run_setup(json_output: bool) -> Result<(), Box<dyn std::error::Error>> {
    let config_dir = std::env::var("HOME")
        .map(PathBuf::from)
        .map(|home| home.join(".sikong"))
        .unwrap_or_else(|_| PathBuf::from(".sikong"));
    let config_path = config_dir.join("config.yaml");

    // For JSON mode, output current config/detection status as structured data
    if json_output {
        let has_deepseek_key = std::env::var("DEEPSEEK_API_KEY")
            .ok()
            .filter(|k| !k.is_empty())
            .is_some();
        let has_kimi_key = std::env::var("KIMI_CODE_API_KEY")
            .ok()
            .filter(|k| !k.is_empty())
            .is_some();
        let has_claude_code = std::process::Command::new("which")
            .arg("claude")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        let has_codex = std::process::Command::new("which")
            .arg("codex")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        let has_cursor = std::process::Command::new("which")
            .arg("cursor")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        let config_exists = config_path.exists();
        let config_content = if config_exists {
            std::fs::read_to_string(&config_path).ok()
        } else {
            None
        };

        let data = serde_json::json!({
            "config_path": config_path.to_string_lossy(),
            "config_exists": config_exists,
            "config": config_content,
            "detection": {
                "deepseek_api_key": has_deepseek_key,
                "kimi_api_key": has_kimi_key,
                "claude_code_cli": has_claude_code,
                "codex_cli": has_codex,
                "cursor_cli": has_cursor
            }
        });
        print_json_data(data);
        return Ok(());
    }

    use dialoguer::{Input, Select, theme::ColorfulTheme};
    let theme = ColorfulTheme::default();

    println!("╔══════════════════════════════════════════════╗");
    println!("║         Sikong Setup                         ║");
    println!("╚══════════════════════════════════════════════╝");
    println!();

    let has_deepseek_key = std::env::var("DEEPSEEK_API_KEY")
        .ok()
        .filter(|k| !k.is_empty())
        .is_some();
    let has_kimi_key = std::env::var("KIMI_CODE_API_KEY")
        .ok()
        .filter(|k| !k.is_empty())
        .is_some();
    let has_claude_code = std::process::Command::new("which")
        .arg("claude")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    let _has_bun = std::process::Command::new("which")
        .arg("bun")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    let has_codex = std::process::Command::new("which")
        .arg("codex")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    let codex_logged_in = if has_codex {
        std::process::Command::new("codex")
            .args(["login", "status"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    } else {
        false
    };
    let has_cursor = std::process::Command::new("which")
        .arg("cursor")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    println!(
        "{} Auto-detection:",
        console::style("[DETECT]").cyan().bold()
    );
    println!(
        "   DEEPSEEK_API_KEY       {}",
        if has_deepseek_key {
            format!("{} found", console::style("[OK]").green().bold())
        } else {
            format!("{} not set", console::style("[MISS]").red().bold())
        }
    );
    println!(
        "   KIMI_CODE_API_KEY      {}",
        if has_kimi_key {
            format!("{} found", console::style("[OK]").green().bold())
        } else {
            format!("{} not set", console::style("[MISS]").red().bold())
        }
    );
    println!(
        "   Claude Code CLI        {}",
        if has_claude_code {
            format!("{} detected", console::style("[OK]").green().bold())
        } else {
            format!("{} not found", console::style("[MISS]").red().bold())
        }
    );
    println!(
        "   Codex CLI              {}  {}",
        if has_codex {
            format!("{} detected", console::style("[OK]").green().bold())
        } else {
            format!("{} not found", console::style("[MISS]").red().bold())
        },
        if has_codex && codex_logged_in {
            format!("{} logged in", console::style("[KEY]").yellow().bold())
        } else if has_codex && !codex_logged_in {
            format!("{} not logged in", console::style("[!]").yellow().bold())
        } else {
            "".to_string()
        }
    );
    println!(
        "   Cursor CLI             {}",
        if has_cursor {
            format!("{} detected", console::style("[OK]").green().bold())
        } else {
            format!("{} not found", console::style("[MISS]").red().bold())
        }
    );
    println!();

    // Step 1: Select provider
    let mut provider_opts: Vec<(&str, &str)> = Vec::new();
    if has_deepseek_key {
        provider_opts.push(("DeepSeek v4 Flash (needs API key)", "deepseek"));
    }
    if has_kimi_key {
        provider_opts.push(("Kimi (needs API key)", "kimi"));
    }
    if has_claude_code {
        provider_opts.push((
            "Claude Code (uses your subscription, no API key needed)",
            "claude",
        ));
    }
    if has_codex {
        provider_opts.push(("Codex (uses your subscription, no API key needed)", "codex"));
    }
    if has_cursor {
        provider_opts.push((
            "Cursor (uses your subscription, no API key needed)",
            "cursor",
        ));
    }
    if provider_opts.is_empty() {
        provider_opts.push(("No API keys or tools detected — configure later", "none"));
    }

    let prov_idx = Select::with_theme(&theme)
        .with_prompt("Select LLM provider")
        .default(0)
        .items(&provider_opts.iter().map(|(l, _)| *l).collect::<Vec<_>>())
        .interact()?;
    let provider = provider_opts[prov_idx].1;

    // Step 2: Determine backend (some providers have fixed backends)
    let (backend, needs_api_key) = match provider {
        "claude" => {
            println!(
                "   {} Claude Code backend — uses the `claude` CLI with your existing subscription.",
                console::style("[INFO]").cyan()
            );
            ("claude-code".to_string(), false)
        }
        "codex" => {
            if codex_logged_in {
                println!(
                    "   {} Codex backend — uses the `codex` CLI with your existing subscription.",
                    console::style("[INFO]").cyan()
                );
            } else {
                println!(
                    "{} Codex CLI found but not logged in. Run 'codex login' first, or choose another provider.",
                    console::style("[!]").yellow().bold()
                );
            }
            ("codex".to_string(), false)
        }
        "cursor" => {
            println!(
                "   {} Cursor backend — uses the `cursor` CLI with your existing subscription.",
                console::style("[INFO]").cyan()
            );
            ("cursor".to_string(), false)
        }
        "kimi" => {
            if has_claude_code {
                println!(
                    "   {} Kimi requires Claude Code runtime.",
                    console::style("[INFO]").cyan()
                );
                ("claude-code".to_string(), true)
            } else {
                println!(
                    "{} Kimi requires Claude Code CLI. Install: npm i -g @anthropic-ai/claude-code",
                    console::style("[!]").yellow().bold()
                );
                return Ok(());
            }
        }
        _ => {
            // deepseek — let user choose backend
            let mut backend_opts: Vec<(&str, &str)> = Vec::new();
            backend_opts.push(("ai-sdk (fast, cost-effective)", "ai-sdk"));
            if has_claude_code {
                backend_opts.push(("Claude Code runtime (richer tool access)", "claude-code"));
            }
            let b_idx = Select::with_theme(&theme)
                .with_prompt("Select execution backend")
                .default(0)
                .items(&backend_opts.iter().map(|(l, _)| *l).collect::<Vec<_>>())
                .interact()?;
            (backend_opts[b_idx].1.to_string(), true)
        }
    };

    // Step 3: Model selection (if provider has choices)
    let model = match provider {
        "deepseek" => {
            let models = vec!["deepseek-v4-flash", "deepseek-v4", "deepseek-r1"];
            let m_idx = Select::with_theme(&theme)
                .with_prompt("Select model")
                .default(0)
                .items(&models)
                .interact()?;
            models[m_idx].to_string()
        }
        "claude" => {
            let models = vec!["claude-sonnet-4-20250514", "claude-4-20250514"];
            let m_idx = Select::with_theme(&theme)
                .with_prompt("Select model")
                .default(0)
                .items(&models)
                .interact()?;
            models[m_idx].to_string()
        }
        _ => String::new(),
    };

    // Step 4: API key prompt if needed
    let mut env_entries: Vec<(String, String)> = Vec::new();
    if needs_api_key {
        let key_var = match provider {
            "deepseek" => "DEEPSEEK_API_KEY",
            "kimi" => "KIMI_CODE_API_KEY",
            _ => "DEEPSEEK_API_KEY",
        };
        let has_key = std::env::var(key_var)
            .ok()
            .filter(|k| !k.is_empty())
            .is_some();
        if !has_key {
            println!();
            println!(
                "{} {} is not set.",
                console::style("[KEY]").yellow().bold(),
                key_var
            );
            let api_key: String = Input::with_theme(&theme)
                .with_prompt("Enter your API key (or leave empty to skip)")
                .allow_empty(true)
                .interact_text()?;
            if !api_key.is_empty() {
                env_entries.push((key_var.to_string(), api_key.clone()));
                let masked = if api_key.len() > 4 {
                    format!("{}...", &api_key[..4])
                } else {
                    String::new()
                };
                println!(
                    "   {} Saved to config. Also add to shell: export {}={}",
                    console::style("[INFO]").cyan(),
                    key_var,
                    masked
                );
            }
        }
    }

    // Step 5: Write config
    let use_real_agent = has_claude_code || has_codex || backend == "claude-code";
    std::fs::create_dir_all(&config_dir)?;
    let mut config_lines = vec![
        "version: 1".to_string(),
        format!("provider: {}", provider),
        format!("backend: {}", backend),
    ];
    // Per-provider config
    let has_model = !model.is_empty();
    let has_env = !env_entries.is_empty();
    if has_model || has_env {
        config_lines.push("providers:".to_string());
        config_lines.push(format!("  {}:", provider));
        if has_model {
            config_lines.push(format!("    model: {}", model));
        }
        if has_env {
            config_lines.push("    env:".to_string());
            for (k, v) in &env_entries {
                config_lines.push(format!("      {}: \"{}\"", k, v));
            }
        }
    }
    config_lines.push("assistant:".to_string());
    config_lines.push("  max_parallel_tasks: 2".to_string());
    let config_content = config_lines.join("\n") + "\n";
    std::fs::write(&config_path, config_content)?;

    println!();
    println!(
        "{} Config written to {}",
        console::style("[OK]").green().bold(),
        config_path.display()
    );
    println!();
    println!("{} Summary:", console::style("[SUMMARY]").magenta().bold());
    println!("   Provider:   {}", provider);
    println!("   Backend:    {}", backend);
    println!(
        "   Worker:     {}",
        if use_real_agent {
            "agent-loop (real agents)"
        } else {
            "mock (default)"
        }
    );
    println!();
    println!("{} Quick start:", console::style("[START]").green().bold());
    println!("   siko send \"analyze this\"     # Send a task");
    println!("   siko assistant --acp       # ACP server for external tools");
    if needs_api_key
        && std::env::var(match provider {
            "deepseek" => "DEEPSEEK_API_KEY",
            "kimi" => "KIMI_CODE_API_KEY",
            _ => "",
        })
        .ok()
        .filter(|k| !k.is_empty())
        .is_none()
    {
        println!();
        println!(
            "{} No API key configured. Set it: export DEEPSEEK_API_KEY=sk-...",
            console::style("[!]").yellow().bold()
        );
    }
    Ok(())
}
