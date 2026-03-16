use crate::state;
use std::io::{self, BufRead, Write};

/// Coding agent choice from the onboarding wizard.
#[derive(Debug, Clone)]
enum CodingAgent {
    ClaudeCode,
    Custom { command: String },
}

/// IDE choice from the onboarding wizard.
#[derive(Debug, Clone)]
enum Ide {
    VsCode,
    Zed,
}

/// Run the interactive onboarding wizard.
/// Returns Ok(()) if settings were written, or Err if the user cancelled / an error occurred.
pub fn run_onboarding() -> Result<(), String> {
    let stdin = io::stdin();
    let mut reader = stdin.lock();

    println!();
    println!("Welcome to Band! Let's set up your environment.");
    println!();

    // --- Step 1: Coding agent ---
    let agent = prompt_coding_agent(&mut reader)?;

    // --- Step 2: IDE ---
    let ide = prompt_ide(&mut reader)?;

    // --- Build settings ---
    let settings = build_settings(&agent, &ide);

    // --- Write ---
    state::save_settings(&settings)?;

    println!();
    println!("Settings saved to {}", state::settings_file().display());
    println!("You're all set! Run `band projects add <path>` to register your first project.");

    Ok(())
}

/// Ask which coding agent to use. Returns a `CodingAgent` variant.
fn prompt_coding_agent(reader: &mut impl BufRead) -> Result<CodingAgent, String> {
    println!("Which coding agent would you like to use?");
    println!();
    println!("  1) Claude Code");
    println!("  2) Custom command");
    println!();

    let choice = read_choice(reader, "Choose [1-2]", 1, 2)?;

    match choice {
        1 => Ok(CodingAgent::ClaudeCode),
        2 => {
            let cmd = read_line_prompt(
                reader,
                "Enter the agent command (e.g. /usr/local/bin/my-agent)",
            )?;
            if cmd.is_empty() {
                return Err("Custom command cannot be empty".to_string());
            }
            Ok(CodingAgent::Custom { command: cmd })
        }
        _ => unreachable!(),
    }
}

/// Ask which IDE to use. Returns an `Ide` variant.
fn prompt_ide(reader: &mut impl BufRead) -> Result<Ide, String> {
    println!("Which IDE do you prefer?");
    println!();
    println!("  1) VS Code");
    println!("  2) Zed");
    println!();

    let choice = read_choice(reader, "Choose [1-2]", 1, 2)?;

    match choice {
        1 => Ok(Ide::VsCode),
        2 => Ok(Ide::Zed),
        _ => unreachable!(),
    }
}

/// Build a `Settings` struct from the user's choices.
fn build_settings(agent: &CodingAgent, ide: &Ide) -> state::Settings {
    let coding_agent = match agent {
        CodingAgent::ClaudeCode => serde_json::json!({
            "type": "claude-code"
        }),
        CodingAgent::Custom { command } => serde_json::json!({
            "type": "claude-code",
            "command": command
        }),
    };

    let agent_watch_command = match agent {
        CodingAgent::ClaudeCode => "band tasks watch && claude --continue".to_string(),
        CodingAgent::Custom { command } => format!("band tasks watch && {command} --continue"),
    };

    let defaults = match ide {
        Ide::VsCode => serde_json::json!({
            "apps": [
                {
                    "type": "vscode",
                    "terminals": [
                        {
                            "name": "agent",
                            "command": agent_watch_command
                        },
                        {
                            "name": "shell",
                            "command": "",
                            "split": "vertical"
                        }
                    ]
                }
            ]
        }),
        Ide::Zed => serde_json::json!({
            "apps": [
                {
                    "type": "zed"
                },
                {
                    "type": "iterm",
                    "commands": [
                        {
                            "name": "agent",
                            "command": agent_watch_command
                        },
                        {
                            "name": "shell",
                            "command": "",
                            "split": "vertical"
                        }
                    ]
                }
            ]
        }),
    };

    state::Settings {
        defaults: Some(defaults),
        coding_agent: Some(coding_agent),
        ..state::Settings::default()
    }
}

// ---------- Prompt helpers ----------

/// Read a numeric choice from the user, retrying on invalid input.
fn read_choice(reader: &mut impl BufRead, prompt: &str, min: u32, max: u32) -> Result<u32, String> {
    loop {
        print!("{prompt}: ");
        io::stdout().flush().ok();

        let line = read_line(reader)?;
        if let Ok(n) = line.trim().parse::<u32>() {
            if n >= min && n <= max {
                return Ok(n);
            }
        }
        println!("Please enter a number between {min} and {max}.");
    }
}

/// Read a line of text with a prompt.
fn read_line_prompt(reader: &mut impl BufRead, prompt: &str) -> Result<String, String> {
    print!("{prompt}: ");
    io::stdout().flush().ok();
    read_line(reader)
}

/// Read a single line from the reader.
fn read_line(reader: &mut impl BufRead) -> Result<String, String> {
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .map_err(|e| format!("Failed to read input: {e}"))?;
    if line.is_empty() {
        return Err("Input closed (EOF)".to_string());
    }
    Ok(line.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_settings_claude_code_vscode() {
        let settings = build_settings(&CodingAgent::ClaudeCode, &Ide::VsCode);

        let agent = settings.coding_agent.unwrap();
        assert_eq!(agent["type"], "claude-code");
        assert!(agent.get("command").is_none());

        let defaults = settings.defaults.unwrap();
        let apps = defaults["apps"].as_array().unwrap();
        assert_eq!(apps.len(), 1);
        assert_eq!(apps[0]["type"], "vscode");

        let terminals = apps[0]["terminals"].as_array().unwrap();
        assert_eq!(terminals.len(), 2);
        assert_eq!(terminals[0]["name"], "agent");
        assert!(terminals[0]["command"]
            .as_str()
            .unwrap()
            .contains("claude --continue"));
    }

    #[test]
    fn build_settings_custom_agent_zed() {
        let agent = CodingAgent::Custom {
            command: "/usr/bin/my-agent".to_string(),
        };
        let settings = build_settings(&agent, &Ide::Zed);

        let coding = settings.coding_agent.unwrap();
        assert_eq!(coding["type"], "claude-code");
        assert_eq!(coding["command"], "/usr/bin/my-agent");

        let defaults = settings.defaults.unwrap();
        let apps = defaults["apps"].as_array().unwrap();
        assert_eq!(apps.len(), 2);
        assert_eq!(apps[0]["type"], "zed");
        assert_eq!(apps[1]["type"], "iterm");

        let commands = apps[1]["commands"].as_array().unwrap();
        assert_eq!(commands.len(), 2);
        assert!(commands[0]["command"]
            .as_str()
            .unwrap()
            .contains("/usr/bin/my-agent --continue"));
    }

    #[test]
    fn prompt_coding_agent_claude_code() {
        let input = b"1\n";
        let mut cursor = io::Cursor::new(input);
        let result = prompt_coding_agent(&mut cursor).unwrap();
        assert!(matches!(result, CodingAgent::ClaudeCode));
    }

    #[test]
    fn prompt_coding_agent_custom() {
        let input = b"2\n/usr/bin/my-agent\n";
        let mut cursor = io::Cursor::new(input);
        let result = prompt_coding_agent(&mut cursor).unwrap();
        match result {
            CodingAgent::Custom { command } => assert_eq!(command, "/usr/bin/my-agent"),
            _ => panic!("Expected Custom agent"),
        }
    }

    #[test]
    fn prompt_ide_vscode() {
        let input = b"1\n";
        let mut cursor = io::Cursor::new(input);
        let result = prompt_ide(&mut cursor).unwrap();
        assert!(matches!(result, Ide::VsCode));
    }

    #[test]
    fn prompt_ide_zed() {
        let input = b"2\n";
        let mut cursor = io::Cursor::new(input);
        let result = prompt_ide(&mut cursor).unwrap();
        assert!(matches!(result, Ide::Zed));
    }

    #[test]
    fn read_choice_retries_on_invalid() {
        // First two lines are invalid, third is valid
        let input = b"abc\n5\n2\n";
        let mut cursor = io::Cursor::new(input);
        let result = read_choice(&mut cursor, "Pick", 1, 2).unwrap();
        assert_eq!(result, 2);
    }
}
