use crate::CommandResult;
use std::fmt::Write;
use std::fs;
use std::path::Path;

/// Service skill template with `<!-- COMMANDS -->` placeholder.
const BAND_CLI_TEMPLATE: &str = include_str!("../skills/band-cli.md");

pub fn generate_skills(output_dir: &str, filter: Option<&str>) -> Result<CommandResult, String> {
    let schema = crate::build_schema(None)?;
    let commands = schema["commands"]
        .as_array()
        .ok_or("Schema has no commands array")?;

    let output_path = Path::new(output_dir);
    fs::create_dir_all(output_path)
        .map_err(|e| format!("Failed to create output directory {output_dir}: {e}"))?;

    let mut generated: Vec<serde_json::Value> = Vec::new();

    // Generate service skill
    let svc_name =
        parse_frontmatter_field(BAND_CLI_TEMPLATE, "name").unwrap_or("band-cli".to_string());
    let svc_desc =
        parse_frontmatter_field(BAND_CLI_TEMPLATE, "description").unwrap_or_default();
    if matches_filter(&svc_name, filter) {
        let content = generate_service_skill(commands);
        let dir_path = output_path.join(&svc_name);
        fs::create_dir_all(&dir_path)
            .map_err(|e| format!("Failed to create directory {}: {e}", dir_path.display()))?;
        fs::write(dir_path.join("SKILL.md"), &content)
            .map_err(|e| format!("Failed to write {svc_name}/SKILL.md: {e}"))?;
        generated.push(serde_json::json!({
            "name": svc_name,
            "type": "service",
            "description": svc_desc,
            "path": format!("{svc_name}/SKILL.md"),
        }));
    }

    let mut text = String::new();
    let _ = writeln!(text, "Generated {} skill(s) in {output_dir}/", generated.len());
    for entry in &generated {
        let _ = writeln!(
            text,
            "  {} ({})",
            entry["name"].as_str().unwrap_or(""),
            entry["type"].as_str().unwrap_or("")
        );
    }

    Ok(CommandResult {
        text,
        json: serde_json::json!({
            "outputDir": output_dir,
            "skills": generated,
        }),
    })
}

fn matches_filter(name: &str, filter: Option<&str>) -> bool {
    match filter {
        None => true,
        Some(f) => name.to_lowercase().contains(&f.to_lowercase()),
    }
}

/// Parse a single field from YAML frontmatter delimited by `---`.
fn parse_frontmatter_field(content: &str, key: &str) -> Option<String> {
    let mut in_frontmatter = false;
    for line in content.lines() {
        if line.trim() == "---" {
            if in_frontmatter {
                break;
            }
            in_frontmatter = true;
            continue;
        }
        if in_frontmatter {
            if let Some(rest) = line.strip_prefix(key) {
                if let Some(value) = rest.strip_prefix(':') {
                    return Some(value.trim().to_string());
                }
            }
        }
    }
    None
}

const COMMANDS_PLACEHOLDER: &str = "<!-- COMMANDS -->";

fn generate_service_skill(commands: &[serde_json::Value]) -> String {
    let mut cmds = String::new();
    let _ = writeln!(cmds, "## Commands");
    let _ = writeln!(cmds);

    for cmd in commands {
        let desc = cmd["description"].as_str().unwrap_or("");
        let usage = format_usage_line(cmd);

        let _ = writeln!(cmds, "### {desc}");
        let _ = writeln!(cmds);
        let _ = writeln!(cmds, "```sh");
        let _ = writeln!(cmds, "{usage}");
        let _ = writeln!(cmds, "```");
        let _ = writeln!(cmds);

        if let Some(notes) = cmd.get("notes").and_then(|v| v.as_str()) {
            let _ = writeln!(cmds, "{notes}");
            let _ = writeln!(cmds);
        }
    }

    BAND_CLI_TEMPLATE.replace(COMMANDS_PLACEHOLDER, cmds.trim_end())
}

fn format_usage_line(cmd: &serde_json::Value) -> String {
    let name = cmd["name"].as_str().unwrap_or("");
    let mut parts = vec![format!("band {name}")];

    if let Some(params) = cmd["parameters"].as_array() {
        for param in params {
            let pname = param["name"].as_str().unwrap_or("");
            let ptype = param["type"].as_str().unwrap_or("string");
            let required = param["required"].as_bool().unwrap_or(false);
            let positional = param["positional"].as_bool().unwrap_or(false);

            if positional {
                if required {
                    parts.push(format!("<{pname}>"));
                } else {
                    parts.push(format!("[{pname}]"));
                }
            } else if ptype == "boolean" {
                if required {
                    parts.push(pname.to_string());
                } else {
                    parts.push(format!("[{pname}]"));
                }
            } else if required {
                parts.push(format!("{pname} <{ptype}>"));
            } else {
                parts.push(format!("[{pname} <{ptype}>]"));
            }
        }
    }

    parts.join(" ")
}
