use crate::CommandResult;
use std::env;
use std::fmt::Write;
use std::fs;
use std::path::{Path, PathBuf};

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

/// Supported coding agents that get a per-skill symlink under their
/// own skills directory. Mirrors `SUPPORTED_AGENT_TYPES` on the TS side
/// (`packages/coding-agent/src/install-skills.ts`); both lists must stay
/// in sync. `cursor-cli` is deliberately omitted — it has no documented
/// user-scope skills directory.
const SUPPORTED_AGENTS: &[&str] = &["claude-code", "codex", "gemini-cli", "opencode"];

/// A single rendered skill ready to be written to disk.
struct RenderedSkill {
    name: String,
    description: String,
    command_count: usize,
    content: String,
    prefixes: Vec<String>,
}

/// Render every (filter-matched) skill template against the live CLI
/// schema. Used by both `generate-skills` and `skills install` so the
/// rendering logic is defined once.
fn render_skills(filter: Option<&str>) -> Result<Vec<RenderedSkill>, String> {
    let schema = crate::build_schema(None)?;
    let commands = schema["commands"]
        .as_array()
        .ok_or("Schema has no commands array")?;

    let mut rendered: Vec<RenderedSkill> = Vec::new();

    for (default_name, template) in SKILL_TEMPLATES {
        let name = parse_frontmatter_field(template, "name")
            .unwrap_or_else(|| (*default_name).to_string());
        let description = parse_frontmatter_field(template, "description").unwrap_or_default();
        let prefixes = parse_command_prefixes(template);
        let has_placeholder = template.contains(COMMANDS_PLACEHOLDER);

        if !matches_filter(&name, filter) {
            continue;
        }

        // Defense in depth: parse the YAML frontmatter with a strict parser
        // before we ship the rendered file. A bad template (e.g. an
        // unquoted `argument-hint: [foo] [bar]` that YAML reads as a
        // malformed flow sequence) would otherwise serialise to disk and
        // only surface at agent-load time as "Skipped loading N skill(s)
        // due to invalid SKILL.md files". Fail the build instead.
        validate_frontmatter(&name, template)?;

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
        rendered.push(RenderedSkill {
            name,
            description,
            command_count: matched.len(),
            content,
            prefixes,
        });
    }

    Ok(rendered)
}

pub fn generate_skills(output_dir: &str, filter: Option<&str>) -> Result<CommandResult, String> {
    let output_path = Path::new(output_dir);
    fs::create_dir_all(output_path)
        .map_err(|e| format!("Failed to create output directory {output_dir}: {e}"))?;

    let rendered = render_skills(filter)?;

    let mut generated: Vec<serde_json::Value> = Vec::new();
    for skill in &rendered {
        let dir_path = output_path.join(&skill.name);
        fs::create_dir_all(&dir_path)
            .map_err(|e| format!("Failed to create directory {}: {e}", dir_path.display()))?;
        fs::write(dir_path.join("SKILL.md"), &skill.content)
            .map_err(|e| format!("Failed to write {}/SKILL.md: {e}", skill.name))?;

        generated.push(serde_json::json!({
            "name": skill.name,
            "description": skill.description,
            "commandPrefixes": skill.prefixes,
            "commandCount": skill.command_count,
            "path": format!("{}/SKILL.md", skill.name),
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

/// Outcome of attempting to write a single shared SKILL.md.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SharedWriteOutcome {
    Written,
    Updated,
    Unchanged,
}

/// Outcome of attempting to create a per-agent symlink.
#[derive(Debug, Clone)]
enum SymlinkOutcome {
    Created,
    Already,
    Conflict(String),
}

/// Aggregated result of the shared-write phase.
#[derive(Default)]
struct SharedWriteSummary {
    written: Vec<String>,
    updated: Vec<String>,
    unchanged: Vec<String>,
}

/// Aggregated result of the symlink phase.
#[derive(Default)]
struct SymlinkSummary {
    linked: Vec<String>,
    already_linked: Vec<String>,
    conflicts: Vec<serde_json::Value>,
}

fn write_shared_skills(
    shared_dir: &Path,
    rendered: &[RenderedSkill],
) -> Result<SharedWriteSummary, String> {
    let mut summary = SharedWriteSummary::default();
    for skill in rendered {
        let dest_dir = shared_dir.join(&skill.name);
        let dest_path = dest_dir.join("SKILL.md");
        fs::create_dir_all(&dest_dir).map_err(|e| {
            format!(
                "Failed to create skill directory {}: {e}",
                dest_dir.display()
            )
        })?;

        let outcome = write_shared_skill(&dest_path, skill.content.as_bytes())?;
        let path_str = dest_path.to_string_lossy().into_owned();
        match outcome {
            SharedWriteOutcome::Written => summary.written.push(path_str),
            SharedWriteOutcome::Updated => summary.updated.push(path_str),
            SharedWriteOutcome::Unchanged => summary.unchanged.push(path_str),
        }
    }
    Ok(summary)
}

fn create_agent_symlinks(
    shared_dir: &Path,
    rendered: &[RenderedSkill],
    targets: &[(&'static str, PathBuf)],
) -> Result<SymlinkSummary, String> {
    let mut summary = SymlinkSummary::default();
    for (agent_type, skills_dir) in targets {
        fs::create_dir_all(skills_dir).map_err(|e| {
            format!(
                "Failed to create {agent_type} skills dir {}: {e}",
                skills_dir.display()
            )
        })?;
        for skill in rendered {
            let target = shared_dir.join(&skill.name);
            let link = skills_dir.join(&skill.name);
            let outcome = ensure_symlink(&link, &target);
            let link_str = link.to_string_lossy().into_owned();
            match outcome {
                SymlinkOutcome::Created => summary.linked.push(link_str),
                SymlinkOutcome::Already => summary.already_linked.push(link_str),
                SymlinkOutcome::Conflict(reason) => {
                    summary.conflicts.push(serde_json::json!({
                        "path": link_str,
                        "agentType": agent_type,
                        "reason": reason,
                    }));
                }
            }
        }
    }
    Ok(summary)
}

fn render_install_text(
    shared_dir: &Path,
    rendered: &[RenderedSkill],
    shared: &SharedWriteSummary,
    targets: &[(&'static str, PathBuf)],
    symlinks: &SymlinkSummary,
) -> String {
    let mut text = String::new();
    let _ = writeln!(
        text,
        "Installed {} skill(s) into {}",
        rendered.len(),
        shared_dir.display()
    );
    let _ = writeln!(
        text,
        "  shared: {} written, {} updated, {} unchanged",
        shared.written.len(),
        shared.updated.len(),
        shared.unchanged.len(),
    );
    if targets.is_empty() {
        let _ = writeln!(
            text,
            "  symlinks: no supported coding agents detected on host"
        );
    } else {
        let _ = writeln!(
            text,
            "  symlinks: {} created, {} already-linked, {} conflict(s)",
            symlinks.linked.len(),
            symlinks.already_linked.len(),
            symlinks.conflicts.len(),
        );
        for (agent_type, dir) in targets {
            let _ = writeln!(text, "    {agent_type} → {}", dir.display());
        }
    }
    for conflict in &symlinks.conflicts {
        let _ = writeln!(
            text,
            "  conflict: {} ({})",
            conflict["path"].as_str().unwrap_or(""),
            conflict["reason"].as_str().unwrap_or(""),
        );
    }
    text
}

/// Install (or refresh) skills into the canonical shared location
/// `~/.agents/skills/<name>/SKILL.md` and create a directory-level
/// symlink at each detected coding agent's `skills/<name>` →
/// `~/.agents/skills/<name>`.
///
/// Idempotent:
///   - Shared SKILL.md whose bytes already match is left alone.
///   - Symlink already pointing at the correct shared dir is left alone.
///   - Symlink pointing elsewhere or a real directory at the path:
///     reported as a conflict and **not** overwritten.
///
/// `home_override` lets tests redirect the destination away from the
/// real `$HOME`. When `None`, falls back to `$HOME` then `dirs::home_dir`.
pub fn install_skills(
    home_override: Option<&str>,
    filter: Option<&str>,
) -> Result<CommandResult, String> {
    let home = resolve_home(home_override)?;
    let shared_dir = home.join(".agents").join("skills");

    let rendered = render_skills(filter)?;

    fs::create_dir_all(&shared_dir).map_err(|e| {
        format!(
            "Failed to create shared skills directory {}: {e}",
            shared_dir.display()
        )
    })?;

    let shared = write_shared_skills(&shared_dir, &rendered)?;
    let targets = detect_agent_targets(&home);
    let symlinks = create_agent_symlinks(&shared_dir, &rendered, &targets)?;

    let text = render_install_text(&shared_dir, &rendered, &shared, &targets, &symlinks);

    let agents_json: Vec<serde_json::Value> = targets
        .iter()
        .map(|(t, d)| {
            serde_json::json!({
                "type": t,
                "skillsDir": d.to_string_lossy(),
            })
        })
        .collect();

    Ok(CommandResult {
        text,
        json: serde_json::json!({
            "home": home.to_string_lossy(),
            "sharedDir": shared_dir.to_string_lossy(),
            "skills": rendered.iter().map(|s| serde_json::json!({
                "name": s.name,
                "commandCount": s.command_count,
            })).collect::<Vec<_>>(),
            "shared": {
                "written": shared.written,
                "updated": shared.updated,
                "unchanged": shared.unchanged,
            },
            "agents": agents_json,
            "symlinks": {
                "linked": symlinks.linked,
                "alreadyLinked": symlinks.already_linked,
                "conflicts": symlinks.conflicts,
            },
        }),
    })
}

fn resolve_home(home_override: Option<&str>) -> Result<PathBuf, String> {
    if let Some(h) = home_override {
        return Ok(PathBuf::from(h));
    }
    if let Ok(h) = env::var("HOME") {
        if !h.is_empty() {
            return Ok(PathBuf::from(h));
        }
    }
    dirs::home_dir().ok_or_else(|| "Could not resolve user's home directory".to_string())
}

/// Write `content` to `dest` only if the existing bytes differ. Distinguishes
/// fresh-write from drift-overwrite so the caller can report each separately.
fn write_shared_skill(dest: &Path, content: &[u8]) -> Result<SharedWriteOutcome, String> {
    match fs::read(dest) {
        Ok(existing) => {
            if existing == content {
                Ok(SharedWriteOutcome::Unchanged)
            } else {
                fs::write(dest, content)
                    .map_err(|e| format!("Failed to write {}: {e}", dest.display()))?;
                Ok(SharedWriteOutcome::Updated)
            }
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            fs::write(dest, content)
                .map_err(|e| format!("Failed to write {}: {e}", dest.display()))?;
            Ok(SharedWriteOutcome::Written)
        }
        Err(err) => Err(format!("Failed to read {}: {err}", dest.display())),
    }
}

/// Detect which supported coding agents are installed on this host
/// (filesystem-based: the parent config directory exists). Returns
/// `(agent_type, skills_dir)` pairs, deduplicated by `skills_dir` in case
/// two agent types ever resolve to the same directory.
fn detect_agent_targets(home: &Path) -> Vec<(&'static str, PathBuf)> {
    let mut out: Vec<(&'static str, PathBuf)> = Vec::new();
    let mut seen: Vec<PathBuf> = Vec::new();
    for agent in SUPPORTED_AGENTS {
        let Some(config_dir) = agent_config_dir(agent, home) else {
            continue;
        };
        if !config_dir.is_dir() {
            continue;
        }
        let skills_dir = agent_skills_dir(agent, home);
        if seen.iter().any(|p| p == &skills_dir) {
            continue;
        }
        seen.push(skills_dir.clone());
        out.push((agent, skills_dir));
    }
    out
}

fn agent_config_dir(agent: &str, home: &Path) -> Option<PathBuf> {
    match agent {
        "claude-code" => Some(home.join(".claude")),
        "codex" => Some(codex_home(home)),
        "gemini-cli" => Some(home.join(".gemini")),
        "opencode" => Some(home.join(".config").join("opencode")),
        _ => None,
    }
}

fn agent_skills_dir(agent: &str, home: &Path) -> PathBuf {
    match agent {
        "claude-code" => home.join(".claude").join("skills"),
        "codex" => codex_home(home).join("skills"),
        "gemini-cli" => home.join(".gemini").join("skills"),
        "opencode" => home.join(".config").join("opencode").join("skills"),
        // All callers iterate `SUPPORTED_AGENTS`, so any other value
        // is a programming error. Fail loudly rather than constructing
        // a plausible-looking `home/<unknown>/skills` path that would
        // create symlinks in the wrong place if a future caller passes
        // an unvetted string. The `supported_agents_matches_canonical_list`
        // unit test below is the primary guard against that drift.
        _ => unreachable!("agent_skills_dir called with unsupported agent type: {agent}"),
    }
}

fn codex_home(home: &Path) -> PathBuf {
    if let Ok(val) = env::var("CODEX_HOME") {
        if !val.is_empty() {
            return PathBuf::from(val);
        }
    }
    home.join(".codex")
}

/// Create a directory-level symlink at `link` pointing to `target`,
/// idempotently. Refuses to overwrite a real directory, a regular file,
/// or a symlink pointing somewhere else — those become `Conflict`s.
fn ensure_symlink(link: &Path, target: &Path) -> SymlinkOutcome {
    match fs::symlink_metadata(link) {
        Ok(meta) => {
            if meta.file_type().is_symlink() {
                match fs::canonicalize(link) {
                    Ok(resolved_link) => match fs::canonicalize(target) {
                        Ok(resolved_target) => {
                            if resolved_link == resolved_target {
                                SymlinkOutcome::Already
                            } else {
                                let existing = fs::read_link(link).map_or_else(
                                    |_| "<unreadable>".to_string(),
                                    |p| p.to_string_lossy().into_owned(),
                                );
                                SymlinkOutcome::Conflict(format!(
                                    "symlink points to {existing} (expected {})",
                                    target.display()
                                ))
                            }
                        }
                        Err(e) => SymlinkOutcome::Conflict(format!("target unreadable ({e})")),
                    },
                    Err(e) => SymlinkOutcome::Conflict(format!("existing symlink is broken ({e})")),
                }
            } else if meta.is_dir() {
                SymlinkOutcome::Conflict("path is a real directory (not a symlink)".to_string())
            } else {
                SymlinkOutcome::Conflict(
                    "path is a regular file (not a directory or symlink)".to_string(),
                )
            }
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            match create_dir_symlink(target, link) {
                Ok(()) => SymlinkOutcome::Created,
                Err(e) => SymlinkOutcome::Conflict(format!("failed to create symlink: {e}")),
            }
        }
        Err(err) => SymlinkOutcome::Conflict(format!("lstat failed: {err}")),
    }
}

#[cfg(unix)]
fn create_dir_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(windows)]
fn create_dir_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_dir(target, link)
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

/// Extract the YAML frontmatter block (without the `---` delimiters) from a
/// skill template. Returns `None` if the template doesn't open with `---`
/// or doesn't have a closing `---` line — those templates are also invalid,
/// but the caller's job is to validate what's present rather than impose
/// the delimiter convention here.
///
/// **Required shape:** the closing `---` must be followed by a newline
/// (`\n` or `\r\n`). A file ending with `---` at EOF without a trailing
/// newline is treated as missing the closing delimiter and surfaces as
/// "missing YAML frontmatter". Every checked-in template ends with a body
/// paragraph and trailing newline, so this is documentation of the
/// invariant rather than a runtime concern.
fn extract_frontmatter_block(content: &str) -> Option<&str> {
    let rest = content
        .strip_prefix("---\n")
        .or_else(|| content.strip_prefix("---\r\n"))?;
    let end = rest.find("\n---\n").or_else(|| rest.find("\n---\r\n"))?;
    Some(&rest[..end])
}

/// Parse the skill template's YAML frontmatter with a strict parser to
/// catch malformed values before we write the rendered file. Returns
/// an error string of the form
/// `skill '<name>': invalid YAML frontmatter at line N: <msg>`.
fn validate_frontmatter(name: &str, template: &str) -> Result<(), String> {
    let block = extract_frontmatter_block(template).ok_or_else(|| {
        format!("skill '{name}': template is missing YAML frontmatter delimited by `---`")
    })?;
    serde_yml::from_str::<serde_yml::Value>(block).map_err(|err| {
        // serde_yml's Display format already includes the line/column,
        // but the block we hand it starts at the line *after* the opening
        // `---` (whether `\n` or `\r\n`), so adjust the reported line
        // back to the source file's numbering by adding 1.
        let location = err.location();
        let line = location.map(|l| l.line() + 1);
        match line {
            Some(n) => format!("skill '{name}': invalid YAML frontmatter at line {n}: {err}"),
            None => format!("skill '{name}': invalid YAML frontmatter: {err}"),
        }
    })?;
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Drift guard: the Rust `SUPPORTED_AGENTS` list and the TS
    /// `SUPPORTED_AGENT_TYPES` list (`packages/coding-agent/src/install-skills.ts`)
    /// must be identical. If a new agent type is added to one side and not
    /// the other, the web server's boot-time install and the CLI's
    /// `skills install` would silently disagree on which agents get
    /// linked — a bug class that's nearly invisible in normal use.
    ///
    /// Mirrored on the TS side by a matching `node:test` case in
    /// `packages/coding-agent/tests/install-skills.test.ts`. Touching one
    /// list without the other now fails *that side's* test suite, which
    /// CI gates on. Adding a new agent therefore requires:
    ///   1. Wiring up its adapter + `getInstallSkillsDir` + binary detection.
    ///   2. Adding the type name to both lists (and both tests).
    ///   3. Adding it to the supported-agents table in CLAUDE.md.
    #[test]
    fn supported_agents_matches_canonical_list() {
        // Order matters: dispatchers iterate in this order, and tests on
        // both sides assume the same ordering for stable agent-detection
        // priority.
        let expected = ["claude-code", "codex", "gemini-cli", "opencode"];
        assert_eq!(
            SUPPORTED_AGENTS,
            &expected[..],
            "Rust SUPPORTED_AGENTS drifted from the canonical list; update both this slice and \
             packages/coding-agent/src/install-skills.ts::SUPPORTED_AGENT_TYPES (plus the \
             matching test on each side) when adding/removing an agent"
        );
    }

    /// Every checked-in skill template under `apps/cli/skills/` must have
    /// strictly-parseable YAML frontmatter. Catches the regression that
    /// shipped `argument-hint: [command] [args...]` (parsed as a malformed
    /// flow sequence) at `cargo test` time, before the build ever
    /// generates files for a user's coding agent.
    #[test]
    fn checked_in_templates_have_valid_yaml_frontmatter() {
        for (name, template) in SKILL_TEMPLATES {
            validate_frontmatter(name, template)
                .unwrap_or_else(|e| panic!("template `{name}` is invalid: {e}"));
        }
    }

    /// Regression: the exact failure mode that caused Codex to skip the
    /// `band` skill. An unquoted `argument-hint: [command] [args...]` is
    /// parsed as a one-element flow sequence followed by garbage and must
    /// be rejected by the validator.
    #[test]
    fn validate_frontmatter_rejects_unquoted_flow_sequence_then_text() {
        let bad = "---\nname: bad\nargument-hint: [command] [args...]\n---\n\nbody\n";
        let err = validate_frontmatter("bad", bad)
            .expect_err("must reject unquoted flow-sequence-then-text value");
        assert!(
            err.starts_with("skill 'bad': invalid YAML frontmatter"),
            "error should name the skill and signal a YAML parse failure: {err}"
        );
    }

    /// The validator's error message must include a line number so a
    /// future template author can find the offending line without
    /// guessing — and the number must be in the source file's
    /// frame, not the post-strip block's.
    #[test]
    fn validate_frontmatter_error_reports_source_line_number() {
        // Line 1: `---`
        // Line 2: `name: bad`
        // Line 3: `argument-hint: [command] [args...]`  <-- error
        let bad = "---\nname: bad\nargument-hint: [command] [args...]\n---\n";
        let err = validate_frontmatter("bad", bad).expect_err("must reject");
        assert!(
            err.contains("line 3"),
            "expected 'line 3' (source-frame line of the broken value), got: {err}"
        );
    }

    /// Sanity: well-formed templates with bracketed-but-quoted values pass.
    #[test]
    fn validate_frontmatter_accepts_quoted_bracket_value() {
        let ok = "---\nname: ok\nargument-hint: \"[command] [args...]\"\n---\n\nbody\n";
        validate_frontmatter("ok", ok).expect("quoted bracketed value should parse");
    }

    /// A template with no frontmatter at all is invalid — surface a clear
    /// message instead of silently rendering a file with no header.
    #[test]
    fn validate_frontmatter_rejects_missing_block() {
        let no_fm = "# just a markdown body, no frontmatter at all\n";
        let err = validate_frontmatter("no-fm", no_fm).expect_err("must reject");
        assert!(
            err.contains("missing YAML frontmatter"),
            "expected missing-frontmatter error, got: {err}"
        );
    }
}
