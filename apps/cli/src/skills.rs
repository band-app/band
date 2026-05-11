use crate::CommandResult;
use std::fmt::Write;
use std::fs;
use std::path::Path;

/// Skill templates rendered by `band generate-skills`.
///
/// Two shapes are supported:
///
/// 1. **Reference-shaped** (e.g. `band`, `band-chat`) — the template body
///    contains a `<!-- COMMANDS -->` placeholder, and the `commands:`
///    frontmatter field lists the comma-separated command-name prefixes from
///    the CLI schema that should be embedded into that skill's auto-generated
///    Commands section.
/// 2. **Workflow-shaped** (e.g. `band-start`, `band-loop`) — the template
///    body contains no `<!-- COMMANDS -->` placeholder; the skill is a
///    self-contained recipe rather than a command reference. Such templates
///    may omit the `commands:` frontmatter field entirely.
///
/// Splitting the monolithic skill into focused per-domain skills improves
/// trigger precision and keeps each generated SKILL.md scoped to one task
/// type (issue #331).
const SKILL_TEMPLATES: &[(&str, &str)] = &[
    ("band", include_str!("../skills/band.md")),
    ("band-chat", include_str!("../skills/band-chat.md")),
    ("band-terminal", include_str!("../skills/band-terminal.md")),
    ("band-browser", include_str!("../skills/band-browser.md")),
    ("band-start", include_str!("../skills/band-start.md")),
    ("band-loop", include_str!("../skills/band-loop.md")),
];

pub fn generate_skills(output_dir: &str, filter: Option<&str>) -> Result<CommandResult, String> {
    let schema = crate::build_schema(None)?;
    let commands = schema["commands"]
        .as_array()
        .ok_or("Schema has no commands array")?;

    let output_path = Path::new(output_dir);
    fs::create_dir_all(output_path)
        .map_err(|e| format!("Failed to create output directory {output_dir}: {e}"))?;

    let mut generated: Vec<serde_json::Value> = Vec::new();

    for (default_name, template) in SKILL_TEMPLATES {
        let name = parse_frontmatter_field(template, "name")
            .unwrap_or_else(|| (*default_name).to_string());
        let description = parse_frontmatter_field(template, "description").unwrap_or_default();
        let prefixes = parse_command_prefixes(template);
        let has_placeholder = template.contains(COMMANDS_PLACEHOLDER);

        if !matches_filter(&name, filter) {
            continue;
        }

        // `commands:` frontmatter and the `<!-- COMMANDS -->` placeholder are
        // a pair: reference-shaped skills need both, workflow-shaped skills
        // need neither. Reject mismatches so a template can't silently lose
        // its rendered Commands section through a typo.
        match (has_placeholder, prefixes.is_empty()) {
            (true, true) => {
                return Err(format!(
                    "Skill template '{name}' has '<!-- COMMANDS -->' placeholder but is missing a non-empty 'commands:' frontmatter field"
                ));
            }
            (false, false) => {
                return Err(format!(
                    "Skill template '{name}' declares 'commands:' frontmatter ({prefixes:?}) but has no '<!-- COMMANDS -->' placeholder in the body"
                ));
            }
            _ => {}
        }

        let matched: Vec<&serde_json::Value> = if prefixes.is_empty() {
            Vec::new()
        } else {
            commands
                .iter()
                .filter(|c| {
                    c["name"]
                        .as_str()
                        .is_some_and(|cn| matches_any_prefix(cn, &prefixes))
                })
                .collect()
        };

        if has_placeholder && matched.is_empty() {
            return Err(format!(
                "Skill template '{name}' matched no commands from the schema (prefixes: {prefixes:?})"
            ));
        }

        let content = generate_skill_content(template, &matched);
        let dir_path = output_path.join(&name);
        fs::create_dir_all(&dir_path)
            .map_err(|e| format!("Failed to create directory {}: {e}", dir_path.display()))?;
        fs::write(dir_path.join("SKILL.md"), &content)
            .map_err(|e| format!("Failed to write {name}/SKILL.md: {e}"))?;

        generated.push(serde_json::json!({
            "name": name,
            "description": description,
            "commandPrefixes": prefixes,
            "commandCount": matched.len(),
            "path": format!("{name}/SKILL.md"),
        }));
    }

    let mut text = String::new();
    let _ = writeln!(
        text,
        "Generated {} skill(s) in {output_dir}/",
        generated.len()
    );
    for entry in &generated {
        let _ = writeln!(
            text,
            "  {} ({} command(s))",
            entry["name"].as_str().unwrap_or(""),
            entry["commandCount"].as_u64().unwrap_or(0),
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

/// Returns true when `command_name` matches any of the prefixes.
///
/// A "match" is either exact equality or `command_name` starting with
/// `prefix + " "` so that `terminal` matches `terminal list` but not
/// `terminal-something-else`.
fn matches_any_prefix(command_name: &str, prefixes: &[String]) -> bool {
    prefixes
        .iter()
        .any(|p| command_name == p || command_name.starts_with(&format!("{p} ")))
}

/// Parse the `commands:` frontmatter field as a list of comma-separated prefixes.
fn parse_command_prefixes(content: &str) -> Vec<String> {
    parse_frontmatter_field(content, "commands")
        .map(|raw| {
            raw.split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default()
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

fn generate_skill_content(template: &str, commands: &[&serde_json::Value]) -> String {
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

    template.replace(COMMANDS_PLACEHOLDER, cmds.trim_end())
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
