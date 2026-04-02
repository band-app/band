use std::collections::HashMap;
use std::io::{IsTerminal, Write as IoWrite};

// ── Display configuration ──────────────────────────────────────────

/// Controls how tool calls are displayed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolDisplay {
    /// Show one-line tool summaries with status indicators (default).
    Auto,
    /// Hide tool call output entirely.
    Off,
    /// Show full tool input and output.
    Full,
}

/// Configuration for the human-readable renderer.
#[derive(Debug, Clone)]
pub struct RenderConfig {
    /// Whether ANSI color codes are enabled (auto-detected from TTY).
    pub color: bool,
    /// Verbose mode: show full tool input + output.
    pub verbose: bool,
    /// How to display tool calls.
    pub tools: ToolDisplay,
}

impl RenderConfig {
    /// Create a config with sensible defaults.
    /// Colors are auto-enabled when stderr is a terminal.
    pub fn new(verbose: bool, tools: ToolDisplay) -> Self {
        let color = std::io::stderr().is_terminal();
        Self {
            color,
            verbose,
            tools,
        }
    }

    /// Returns effective tool display mode, accounting for --verbose override.
    fn effective_tool_display(&self) -> ToolDisplay {
        if self.verbose {
            ToolDisplay::Full
        } else {
            self.tools
        }
    }
}

// ── Interactive input types ────────────────────────────────────────

/// What the SSE loop should do after rendering a chunk.
pub enum RenderAction {
    /// Keep reading SSE events.
    Continue,
    /// Stream finished (received "finish" chunk).
    Finish,
    /// An interactive tool needs user input before continuing.
    NeedsInput(InteractiveRequest),
}

/// A request for user input from an interactive tool.
pub struct InteractiveRequest {
    /// The approval ID to send back with the answer (equals toolCallId).
    pub approval_id: String,
    /// What kind of interactive input is needed.
    pub kind: InteractiveKind,
}

/// The specific kind of interactive input.
pub enum InteractiveKind {
    /// `ExitPlanMode` — user must approve or reject the plan.
    /// The plan content is already displayed by the renderer before this is returned.
    PlanApproval,
    /// `AskUserQuestion` — user must answer one or more questions.
    AskUserQuestion { questions: Vec<QuestionData> },
}

/// A single question from `AskUserQuestion`.
pub struct QuestionData {
    pub question: String,
    pub header: Option<String>,
    pub options: Vec<OptionData>,
    pub multi_select: bool,
}

/// A single option for a question.
pub struct OptionData {
    pub label: String,
    pub description: Option<String>,
}

// ── ANSI escape helpers ────────────────────────────────────────────

struct Ansi {
    color: bool,
}

impl Ansi {
    const fn new(color: bool) -> Self {
        Self { color }
    }

    fn reset(&self) -> &str {
        if self.color {
            "\x1b[0m"
        } else {
            ""
        }
    }

    fn bold(&self) -> &str {
        if self.color {
            "\x1b[1m"
        } else {
            ""
        }
    }

    fn dim(&self) -> &str {
        if self.color {
            "\x1b[2m"
        } else {
            ""
        }
    }

    fn red(&self) -> &str {
        if self.color {
            "\x1b[31m"
        } else {
            ""
        }
    }

    fn green(&self) -> &str {
        if self.color {
            "\x1b[32m"
        } else {
            ""
        }
    }

    fn yellow(&self) -> &str {
        if self.color {
            "\x1b[33m"
        } else {
            ""
        }
    }

    fn cyan(&self) -> &str {
        if self.color {
            "\x1b[36m"
        } else {
            ""
        }
    }
}

// ── Tool call tracking ─────────────────────────────────────────────

struct ToolCallInfo {
    summary: String,
}

// ── Renderer state machine ─────────────────────────────────────────

pub struct Renderer {
    config: RenderConfig,
    ansi: Ansi,
    /// Maps `toolCallId` -> tool info for correlating output with input.
    pending_tools: HashMap<String, ToolCallInfo>,
    /// Whether we are currently in the middle of streaming text.
    in_text: bool,
    /// Whether stdout needs a newline before the next stderr line.
    /// Set when text-delta writes something that doesn't end with `\n`.
    needs_newline: bool,
    /// Whether the task succeeded (set to false on error chunks).
    pub task_succeeded: bool,
}

impl Renderer {
    pub fn new(config: RenderConfig) -> Self {
        let ansi = Ansi::new(config.color);
        Self {
            config,
            ansi,
            pending_tools: HashMap::new(),
            in_text: false,
            needs_newline: false,
            task_succeeded: true,
        }
    }

    /// Main dispatch: render a single SSE chunk.
    /// Returns a `RenderAction` indicating what the caller should do next.
    pub fn render_chunk(&mut self, chunk: &serde_json::Value) -> RenderAction {
        let chunk_type = chunk.get("type").and_then(|t| t.as_str()).unwrap_or("");

        match chunk_type {
            "text-delta" => self.on_text_delta(chunk),
            "text-end" => self.on_text_end(),
            "tool-input-available" => {
                if let Some(req) = self.on_tool_input(chunk) {
                    return RenderAction::NeedsInput(req);
                }
            }
            "tool-output-available" => self.on_tool_output(chunk),
            "error" => self.on_error(chunk),
            "data-result" => self.on_data_result(chunk),
            "finish" => return RenderAction::Finish,
            // text-start, data-session, data-prompt, finish-step, file — no rendering
            _ => {}
        }

        RenderAction::Continue
    }

    // ── Chunk handlers ─────────────────────────────────────────────

    fn on_text_delta(&mut self, chunk: &serde_json::Value) {
        self.in_text = true;
        let delta = chunk.get("delta").and_then(|d| d.as_str()).unwrap_or("");
        print!("{delta}");
        std::io::stdout().flush().ok();
        self.needs_newline = !delta.ends_with('\n');
    }

    fn on_text_end(&mut self) {
        self.in_text = false;
    }

    /// Handle a tool-input-available chunk.
    /// Returns `Some(InteractiveRequest)` if this is an interactive tool that needs user input.
    fn on_tool_input(&mut self, chunk: &serde_json::Value) -> Option<InteractiveRequest> {
        let tool_display = self.config.effective_tool_display();

        // If stdout cursor is mid-line, add a newline so the tool line starts fresh.
        if self.needs_newline {
            println!();
            self.needs_newline = false;
        }
        self.in_text = false;

        let tool_name = chunk
            .get("toolName")
            .and_then(|n| n.as_str())
            .unwrap_or("tool");
        let tool_call_id = chunk
            .get("toolCallId")
            .and_then(|n| n.as_str())
            .unwrap_or("");
        let input = chunk.get("input").unwrap_or(&serde_json::Value::Null);

        // Check for interactive tools first.
        match tool_name {
            "ExitPlanMode" => {
                let plan = input
                    .get("plan")
                    .and_then(|p| p.as_str())
                    .unwrap_or("")
                    .to_string();
                self.display_plan_review(&plan);
                return Some(InteractiveRequest {
                    approval_id: tool_call_id.to_string(),
                    kind: InteractiveKind::PlanApproval,
                });
            }
            "AskUserQuestion" => {
                let questions = parse_questions(input);
                self.display_questions(&questions);
                return Some(InteractiveRequest {
                    approval_id: tool_call_id.to_string(),
                    kind: InteractiveKind::AskUserQuestion { questions },
                });
            }
            _ => {}
        }

        // Regular tool — show normal summary.
        if tool_display == ToolDisplay::Off {
            return None;
        }

        let summary = tool_summary(tool_name, input);

        // Store for later correlation with output.
        if !tool_call_id.is_empty() {
            self.pending_tools.insert(
                tool_call_id.to_string(),
                ToolCallInfo {
                    summary: summary.clone(),
                },
            );
        }

        let a = &self.ansi;
        eprintln!(
            "  {}{}\u{25b8}{} {summary}",
            a.yellow(),
            a.bold(),
            a.reset(),
        );

        // In full mode, show the complete input.
        if tool_display == ToolDisplay::Full {
            if let Some(obj) = input.as_object() {
                let formatted =
                    serde_json::to_string_pretty(&serde_json::Value::Object(obj.clone()))
                        .unwrap_or_default();
                for line in formatted.lines() {
                    eprintln!("    {}{}{}", a.dim(), line, a.reset());
                }
            }
        }

        None
    }

    fn on_tool_output(&mut self, chunk: &serde_json::Value) {
        let tool_display = self.config.effective_tool_display();
        if tool_display != ToolDisplay::Full {
            // In default/auto mode, the start line is enough.
            // Still remove from pending map to avoid memory buildup.
            if let Some(id) = chunk.get("toolCallId").and_then(|n| n.as_str()) {
                self.pending_tools.remove(id);
            }
            return;
        }

        let tool_call_id = chunk
            .get("toolCallId")
            .and_then(|n| n.as_str())
            .unwrap_or("");
        let output = chunk.get("output").and_then(|o| o.as_str()).unwrap_or("");

        // Look up the tool name from our pending map.
        let info = self.pending_tools.remove(tool_call_id);
        let summary = info.as_ref().map_or("tool", |i| i.summary.as_str());

        let a = &self.ansi;
        eprintln!(
            "  {}\u{2713}{} {}{summary}{}",
            a.green(),
            a.reset(),
            a.dim(),
            a.reset(),
        );

        // Show truncated output.
        if !output.is_empty() {
            let max_chars = 2000;
            let max_lines = 50;
            let truncated = if output.len() > max_chars {
                // Find the nearest char boundary at or before max_chars.
                let mut end = max_chars;
                while !output.is_char_boundary(end) {
                    end -= 1;
                }
                &output[..end]
            } else {
                output
            };
            let line_count = truncated.lines().count();
            for line in truncated.lines().take(max_lines) {
                eprintln!("    {}{}{}", a.dim(), line, a.reset());
            }
            if output.len() > max_chars || line_count > max_lines {
                eprintln!("    {}[...truncated]{}", a.dim(), a.reset());
            }
        }
    }

    fn on_error(&mut self, chunk: &serde_json::Value) {
        if self.needs_newline {
            println!();
            self.needs_newline = false;
        }
        let text = chunk
            .get("errorText")
            .and_then(|t| t.as_str())
            .unwrap_or("Unknown error");
        let a = &self.ansi;
        eprintln!("\n{}{}Error:{} {text}", a.red(), a.bold(), a.reset(),);
        self.task_succeeded = false;
    }

    fn on_data_result(&mut self, chunk: &serde_json::Value) {
        if self.needs_newline {
            println!();
            self.needs_newline = false;
        }
        let Some(data) = chunk.get("data") else {
            return;
        };
        let a = &self.ansi;

        // Duration
        let duration_str = data
            .get("durationMs")
            .and_then(serde_json::Value::as_f64)
            .map(|ms| {
                #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                let total_secs = (ms / 1000.0) as u64;
                let mins = total_secs / 60;
                let secs = total_secs % 60;
                if mins > 0 {
                    format!("{mins}m {secs}s")
                } else {
                    format!("{secs}s")
                }
            });

        // Cost (if available)
        let cost_str = data
            .get("costUsd")
            .and_then(serde_json::Value::as_f64)
            .map(|c| format!(" (${c:.2})"))
            .unwrap_or_default();

        // Turns (if available)
        let turns_str = data
            .get("numTurns")
            .and_then(serde_json::Value::as_u64)
            .map(|t| format!(", {t} turns"))
            .unwrap_or_default();

        if let Some(dur) = &duration_str {
            eprintln!(
                "\n{}{}Task completed in {dur}{cost_str}{turns_str}.{}",
                a.green(),
                a.bold(),
                a.reset(),
            );
        } else {
            eprintln!("\n{}{}Task completed.{}", a.green(), a.bold(), a.reset(),);
        }
    }

    // ── Interactive display helpers ─────────────────────────────────

    fn display_plan_review(&self, plan: &str) {
        let a = &self.ansi;
        let separator = "\u{2500}".repeat(50);
        eprintln!("\n  {}{}{separator}{}", a.cyan(), a.bold(), a.reset(),);
        eprintln!("  {}{}  Plan Review{}", a.cyan(), a.bold(), a.reset(),);
        eprintln!("  {}{}{separator}{}", a.cyan(), a.bold(), a.reset(),);
        if !plan.is_empty() {
            eprintln!();
            for line in plan.lines() {
                eprintln!("  {line}");
            }
            eprintln!();
        }
        eprintln!("  {}{}{separator}{}", a.cyan(), a.bold(), a.reset(),);
    }

    fn display_questions(&self, questions: &[QuestionData]) {
        let a = &self.ansi;
        let separator = "\u{2500}".repeat(50);

        for q in questions {
            eprintln!("\n  {}{}{separator}{}", a.cyan(), a.bold(), a.reset(),);
            if let Some(header) = &q.header {
                eprintln!("  {}{}  {header}{}", a.cyan(), a.bold(), a.reset(),);
            }
            eprintln!("  {}{}  {}{}", a.cyan(), a.bold(), q.question, a.reset(),);
            eprintln!("  {}{}{separator}{}", a.cyan(), a.bold(), a.reset(),);
            for (i, opt) in q.options.iter().enumerate() {
                let num = i + 1;
                if let Some(desc) = &opt.description {
                    eprintln!(
                        "  {}{}  {num}){} {} {}\u{2014} {desc}{}",
                        a.yellow(),
                        a.bold(),
                        a.reset(),
                        opt.label,
                        a.dim(),
                        a.reset(),
                    );
                } else {
                    eprintln!(
                        "  {}{}  {num}){} {}",
                        a.yellow(),
                        a.bold(),
                        a.reset(),
                        opt.label,
                    );
                }
            }
        }
    }
}

// ── Helpers ────────────────────────────────────────────────────────

/// Build a one-line summary of a tool call from its name and input arguments.
pub fn tool_summary(name: &str, args: &serde_json::Value) -> String {
    if let Some(obj) = args.as_object() {
        for key in &[
            "command",
            "file_path",
            "file",
            "path",
            "query",
            "pattern",
            "url",
        ] {
            if let Some(val) = obj.get(*key).and_then(|v| v.as_str()) {
                let display = if val.len() > 80 { &val[..80] } else { val };
                return format!("{name}: {display}");
            }
        }
    }
    name.to_string()
}

/// Parse the `input.questions` JSON array into typed `QuestionData` structs.
fn parse_questions(input: &serde_json::Value) -> Vec<QuestionData> {
    let Some(questions) = input.get("questions").and_then(|q| q.as_array()) else {
        return Vec::new();
    };

    questions
        .iter()
        .map(|q| {
            let question = q
                .get("question")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let header = q.get("header").and_then(|v| v.as_str()).map(String::from);
            let multi_select = q
                .get("multiSelect")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            let options = q
                .get("options")
                .and_then(|v| v.as_array())
                .map(|opts| {
                    opts.iter()
                        .map(|o| OptionData {
                            label: o
                                .get("label")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                            description: o
                                .get("description")
                                .and_then(|v| v.as_str())
                                .map(String::from),
                        })
                        .collect()
                })
                .unwrap_or_default();

            QuestionData {
                question,
                header,
                options,
                multi_select,
            }
        })
        .collect()
}
