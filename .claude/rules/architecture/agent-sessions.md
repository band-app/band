---
paths:
  - "**/acp-agent-process.ts"
  - "**/dashboard/lib/agent-mode.ts"
  - "apps/hub/src/server/services/agent-launch-service.ts"
  - "apps/hub/src/server/services/agent-session-registry-service.ts"
  - "apps/hub/src/server/services/agent-session-service.ts"
---

# Architecture: agent sessions

An agent session is one run of a coding agent (issue #682). Its mode is how it is displayed: `gui` runs in a chat pane over ACP, `tui` runs the agent's CLI in a terminal. A session keeps its mode for its whole life.

- Rows live in the `agent_sessions` table. `services/agent-session-registry-service.ts` owns them and emits `agent-session-created`, `agent-session-updated` and `agent-session-ended`. A chat's `activeSessionId` is its session's `providerSessionId`. A session ends when its chat or terminal is removed. `services/agent-session-service.ts` is a different thing: it runs the ACP process behind a chat.
- A chat's ACP process is never stopped for being idle, so the agent's own timers (`ScheduleWakeup`, `CronCreate`, `Monitor`, background shells) fire as they do in a terminal. It ends when the chat is stopped or removed, its worktree is removed, the agent exits, or the hub or worker shuts down. `BAND_AGENT_IDLE_TIMEOUT_MS` is an opt-in: with a positive value, a process that sends nothing for that long is stopped and the next prompt reattaches its session. Every update restarts the countdown, and work that lives in the process holds the stop off (`services/_utils/agent-pending-work.ts`): AIR `async_task_*` updates for background Bash, Monitor and workflows (Band lists the `asyncTasks` capability and takes those updates off the stream before the SDK's validator, in `acp-agent-process.ts`), and `ScheduleWakeup` and `CronCreate` tool calls. Each hold lapses after at most 8 hours.
- `services/agent-launch-service.ts` starts agents (`agentSessions.launch`, `worktrees.create` with a prompt). The CLI reaches it through `band agents launch` and `band agents list`. An agent with no TUI invocation (cursor-cli) falls back to `gui`, and the response carries a `notice`.
- Each browser stores its own mode in localStorage (`band.agent-mode`, `dashboard/lib/agent-mode.ts`) and sends it on every launch. With no mode sent, the server uses `agents.defaultMode` from `~/.band/settings.json`. Boot copies the older `cli.defaultVia` into it once and leaves the old key, because the CLI still reads it.
