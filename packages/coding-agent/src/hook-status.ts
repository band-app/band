import type { AgentHookStatus } from "./types.ts";

/**
 * Claude Code tools that block on the user (`AskUserQuestion`,
 * `ExitPlanMode`). Every other tool is auto-approved by Band and never
 * blocks, so only these drive a `needs_attention` status.
 */
const CLAUDE_CODE_INTERACTIVE_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

/**
 * Translate a Claude Code hook payload (the JSON Claude Code pipes to
 * `band notify` on stdin via the hooks Band registers in
 * `~/.claude/settings.json`) into a Band workspace status.
 *
 * `needs_attention` means the ball is in the user's court — the agent either
 * finished its turn or is blocked waiting for the user to act:
 *
 *   - `Stop`              → the agent finished/exited; it's the user's turn.
 *                           Tool-agnostic; fires once per turn.
 *   - `PreToolUse` / `PermissionRequest` for an interactive tool
 *                           (`CLAUDE_CODE_INTERACTIVE_TOOLS`) → the agent is
 *                           about to block on the user.
 *
 * The attention signal is the TOOL, not the hook event. `PermissionRequest`
 * fires *after* `PreToolUse` for every gated tool (Bash/Write/Edit/…), but
 * Band auto-approves those — they don't block the user — so they must stay
 * `working`. Mapping `PermissionRequest` to `needs_attention` unconditionally
 * chimed the "needs attention" sound on every tool call.
 *
 * Everything else (UserPromptSubmit, PostToolUse, and PreToolUse /
 * PermissionRequest for non-interactive tools) means the agent is actively
 * making progress → `working`.
 */
export function mapClaudeCodeHookStatus(payload: Record<string, unknown>): AgentHookStatus {
  const hookEvent = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "";
  const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "";

  if (hookEvent === "Stop") {
    return "needs_attention";
  }
  if (
    (hookEvent === "PreToolUse" || hookEvent === "PermissionRequest") &&
    CLAUDE_CODE_INTERACTIVE_TOOLS.has(toolName)
  ) {
    return "needs_attention";
  }
  return "working";
}

/**
 * Map a coding agent's lifecycle-notification payload (the JSON its hook pipes
 * to `band notify` on stdin) to a Band workspace status.
 *
 * Adding hook support for a new agent means adding a mapper above and a case
 * here. The Band CLI never changes — it forwards the raw payload and the
 * server dispatches.
 *
 * Agent types without a hook integration (no `case` below) default to
 * `working`: a notification arrived, so the agent is at least active. Today
 * only Claude Code registers hooks, so other types only reach this path in
 * unusual setups. Async for call-site compatibility with the earlier
 * adapter-backed dispatcher.
 */
export async function mapHookPayloadToStatus(
  agentType: string,
  payload: Record<string, unknown>,
): Promise<AgentHookStatus> {
  switch (agentType) {
    case "claude-code":
      return mapClaudeCodeHookStatus(payload);
    default:
      return "working";
  }
}
