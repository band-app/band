import type { AgentHookStatus } from "./types.ts";

/**
 * Claude Code tools that block on the user (`AskUserQuestion`,
 * `ExitPlanMode`). A `PreToolUse` for one of them means the agent is about to
 * wait on an answer.
 */
const CLAUDE_CODE_INTERACTIVE_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

/** `background_tasks` entry statuses that mean the task is over. */
const TERMINAL_TASK_STATUSES = new Set([
  "idle",
  "done",
  "success",
  "succeeded",
  "complete",
  "completed",
  "finished",
  "failed",
  "error",
  "terminated",
  "exited",
  "aborted",
  "expired",
  "skipped",
  "crashed",
  "killed",
  "cancelled",
  "canceled",
  "timed_out",
]);

/**
 * Whether a `Stop` payload says work outlives the turn: a scheduled cron in
 * `session_crons`, or a `background_tasks` entry that has not finished.
 * Teammate entries report "running" for good, so they don't count. An entry
 * without a readable type or status counts as running, so the result fails
 * toward `monitoring`.
 */
function hasBackgroundWork(payload: Record<string, unknown>): boolean {
  const crons = payload.session_crons;
  if (Array.isArray(crons) && crons.length > 0) return true;
  const tasks = payload.background_tasks;
  if (!Array.isArray(tasks)) return false;
  return tasks.some((task) => {
    if (typeof task !== "object" || task === null) return true;
    const { type, status } = task as Record<string, unknown>;
    if (typeof type === "string" && type.trim().toLowerCase() === "teammate") return false;
    const state = typeof status === "string" ? status.trim().toLowerCase() : "";
    return !TERMINAL_TASK_STATUSES.has(state);
  });
}

/**
 * Translate a Claude Code hook payload (the JSON Claude Code pipes to
 * `band notify` on stdin via the hooks Band registers in
 * `~/.claude/settings.json`) into a Band worktree status.
 *
 *   - `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`,
 *     `SubagentStart`, `SubagentStop` → `working`.
 *   - `PermissionRequest` (any tool) and `PreToolUse` for an interactive tool
 *     → `question`. A terminal session is not auto-approved, so a permission
 *     request always waits on the user.
 *   - `SessionStart` → `idle`: the agent is at its prompt. With
 *     `source: "compact"` it is `working`, since compaction runs mid-turn.
 *   - `Stop` → `done`, or `monitoring` while `session_crons` or
 *     `background_tasks` show work that outlives the turn.
 *   - `StopFailure` → `failed`.
 *   - `PostCompact` with `trigger: "manual"` → `done`. A manual `/compact`
 *     ends at an idle prompt and sends no `Stop`.
 *
 * Any other event is unknown and counts as `working`: the agent is at least
 * active.
 */
export function mapClaudeCodeHookStatus(payload: Record<string, unknown>): AgentHookStatus {
  const hookEvent = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "";
  const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "";

  switch (hookEvent) {
    case "SessionStart":
      // A compaction mid-turn fires `SessionStart` with `source: "compact"`; the turn goes on.
      return payload.source === "compact" ? "working" : "idle";
    case "PermissionRequest":
      return "question";
    case "PreToolUse":
      return CLAUDE_CODE_INTERACTIVE_TOOLS.has(toolName) ? "question" : "working";
    case "Stop":
      return hasBackgroundWork(payload) ? "monitoring" : "done";
    case "StopFailure":
      return "failed";
    case "PostCompact":
      return payload.trigger === "manual" ? "done" : "working";
    default:
      return "working";
  }
}

/**
 * Translate a Codex hook payload (recorded against codex-cli 0.153.4; same
 * shape as Claude Code's: `hook_event_name`, `session_id` = the thread id)
 * into a status. `PermissionRequest` waits on the user, `Stop` and
 * `Interrupt` (an Esc-cancelled turn) end the turn, and everything else
 * (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`) is work. Codex has no
 * failed-turn hook, so `failed` is never reported.
 */
export function mapCodexHookStatus(payload: Record<string, unknown>): AgentHookStatus {
  switch (payload.hook_event_name) {
    case "SessionStart":
      return "idle";
    case "PermissionRequest":
      return "question";
    case "Stop":
    case "Interrupt":
      return "done";
    default:
      return "working";
  }
}

/**
 * Translate a Gemini CLI hook payload (`hook_event_name`, `session_id`;
 * recorded against Gemini CLI 0.61.0) into a status. `Notification` with
 * `notification_type: "ToolPermission"` is a permission prompt; any other
 * notification leaves the turn as it was (`working`). `AfterAgent` ends the
 * turn. Gemini reports no failed turn, so `failed` is never reported.
 */
export function mapGeminiHookStatus(payload: Record<string, unknown>): AgentHookStatus {
  switch (payload.hook_event_name) {
    case "SessionStart":
      return "idle";
    case "Notification":
      return payload.notification_type === "ToolPermission" ? "question" : "working";
    case "AfterAgent":
      return "done";
    default:
      return "working";
  }
}

/**
 * Translate the payload Band's OpenCode plugin sends (`hook_event_name`,
 * `session_id`, `cwd`) into a status. OpenCode has no hook config, so the
 * plugin (`hooks-opencode.ts` in host-local) turns session events into these
 * names: `SessionBusy`, `PermissionRequest` (a permission or a question),
 * `SessionIdle` and `SessionError`.
 */
export function mapOpenCodeHookStatus(payload: Record<string, unknown>): AgentHookStatus {
  switch (payload.hook_event_name) {
    case "PermissionRequest":
      return "question";
    case "SessionIdle":
      return "done";
    case "SessionError":
      return "failed";
    default:
      return "working";
  }
}

/** Subagents of one hook session that are running, and the end of the turn they hold back. */
export interface SubagentHold {
  running: Set<string>;
  /** The status the main agent's `Stop` reported while subagents still ran. */
  deferred: AgentHookStatus | null;
}

/**
 * Keep a session `working` while its subagents run after the main turn's
 * `Stop`. `Stop` with subagents running defers its `done` or `monitoring`;
 * the last `SubagentStop` releases it. Returns the status to record. `hold`
 * is the session's state, kept by the caller and changed in place.
 */
export function foldSubagents(
  hold: SubagentHold,
  payload: Record<string, unknown>,
  mapped: AgentHookStatus,
): AgentHookStatus {
  const hookEvent = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "";
  const agentId = typeof payload.agent_id === "string" ? payload.agent_id : "";
  if (hookEvent === "SubagentStart") {
    if (agentId) hold.running.add(agentId);
    return hold.deferred ? "working" : mapped;
  }
  if (hookEvent === "SubagentStop") {
    hold.running.delete(agentId);
    if (hold.running.size === 0 && hold.deferred) {
      const settled = hold.deferred;
      hold.deferred = null;
      return settled;
    }
    return mapped;
  }
  if ((hookEvent === "Stop" || hookEvent === "StopFailure") && !agentId) {
    if (hold.running.size > 0 && (mapped === "done" || mapped === "monitoring")) {
      hold.deferred = mapped;
      return "working";
    }
    hold.deferred = null;
    return mapped;
  }
  // A new prompt starts a turn of its own; a deferred end no longer applies.
  if (hookEvent === "UserPromptSubmit") hold.deferred = null;
  return mapped;
}

/**
 * Map a coding agent's lifecycle-notification payload (the JSON its hook pipes
 * to `band notify` on stdin) to a Band worktree status.
 *
 * Adding hook support for a new agent means adding a mapper above and a case
 * here. The Band CLI never changes — it forwards the raw payload and the
 * server dispatches.
 *
 * Agent types without a hook integration (no `case` below) default to
 * `working`: a notification arrived, so the agent is at least active. Async for call-site compatibility with the earlier
 * adapter-backed dispatcher.
 */
export async function mapHookPayloadToStatus(
  agentType: string,
  payload: Record<string, unknown>,
): Promise<AgentHookStatus> {
  switch (agentType) {
    case "claude-code":
      return mapClaudeCodeHookStatus(payload);
    case "codex":
      return mapCodexHookStatus(payload);
    case "gemini-cli":
      return mapGeminiHookStatus(payload);
    case "opencode":
      return mapOpenCodeHookStatus(payload);
    default:
      return "working";
  }
}

/**
 * Identify the agent that sent a hook payload from the payload alone, or
 * `null` when it can't tell. Used when the hook command didn't name its
 * agent (`band notify` without `--agent`, as installed before that flag
 * existed). Several agents share Claude Code's hook payload shape
 * (`hook_event_name`, `session_id`), so the fingerprint is Claude Code's
 * transcript location, `~/.claude/projects/…`.
 */
export function detectHookAgentType(payload: Record<string, unknown>): string | null {
  const transcript = typeof payload.transcript_path === "string" ? payload.transcript_path : "";
  if (/[/\\]\.claude[/\\]projects[/\\]/.test(transcript)) return "claude-code";
  return null;
}

/**
 * The agent session behind this hook is over (Claude Code's `SessionEnd`:
 * exit, `/clear`, logout). Its status should stop counting toward the
 * worktree's.
 */
export function isHookSessionEnd(agentType: string, payload: Record<string, unknown>): boolean {
  return (
    (agentType === "claude-code" || agentType === "gemini-cli" || agentType === "opencode") &&
    payload.hook_event_name === "SessionEnd"
  );
}

/** The session a hook payload belongs to, when the agent reports one. */
export function hookSessionId(payload: Record<string, unknown>): string | null {
  return typeof payload.session_id === "string" && payload.session_id ? payload.session_id : null;
}
