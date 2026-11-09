---
paths:
  - "**/DashboardShell.tsx"
  - "**/agent-hooks.spec.ts"
  - "**/agent-status-sources.test.ts"
  - "**/agent-status-states.test.ts"
  - "**/claude-hooks-install.test.ts"
  - "**/dashboard-store.ts"
  - "**/hook-host-routing.test.ts"
  - "**/lib/unread.ts"
  - "**/remote-relay.test.ts"
  - "**/state.ts"
  - "apps/cli/tests/integration.rs"
  - "apps/hub/src/server/services/background-wake-service.ts"
  - "apps/hub/src/server/services/chat-status-service.ts"
  - "apps/hub/tests/background-wake-stall.test.ts"
  - "apps/hub/tests/needs-attention.test.ts"
  - "apps/hub/tests/worktree-unread.test.ts"
  - "apps/mobile/tests/unread.test.ts"
  - "apps/web/e2e/agent-status-states.spec.ts"
  - "apps/web/e2e/chat-stalled.spec.ts"
  - "apps/web/e2e/worktree-unread.spec.ts"
  - "packages/coding-agent/src/hook-status.ts"
  - "packages/coding-agent/src/types.ts"
  - "packages/coding-agent/tests/hook-status.test.ts"
  - "packages/host-local/src/agents/hooks-install.ts"
  - "packages/host-local/tests/hooks-install.test.ts"
---

# Architecture: agent status states

A worktree's agent status is one of `working`, `monitoring`, `question`, `done`, `failed` and `idle` (`AgentHookStatus`, `packages/coding-agent/src/types.ts`). Each agent session (`agent_sessions.status`, a chat's or a terminal's) carries its own status. `worktree_statuses.agent_status` is derived from the worktree's open sessions plus the manual source (`statuses.update`, the only row left in `worktree_status_sources`) with priority question > failed > working > monitoring > done > idle (`state.ts`). Hub boot makes every session and manual status but `done` and `failed` idle, and deletes older `chat:` and `hook:` source rows. A tab's status is its session's, so two terminals in one worktree each show their own. A terminal session that said `working` and went quiet for 15 minutes stops counting. Subagent holds key by session id, and a session ending (`agent-session-ended`) re-derives the worktree (`startStatusSourceCleanup`). `statuses.clearNeedsAttention` turns `done` and `failed` sessions and sources into `idle` and never clears a `question`.

- Chats: `services/chat-status-service.ts` sets the status. `task-service` calls `beginBandTurn` and `endBandTurn` (`end_turn` is `done`, or `monitoring` while the chat's `PendingWork` has holds, `refusal`, `max_tokens`, `max_turn_requests` and a thrown prompt are `failed`, a stopped turn is `idle`). A permission or form request is `question` and its answer `working`. The Claude adapter sends no marker when a turn it started itself ends (a cron, `ScheduleWakeup`, a task notification), so updates outside a Band turn show `working` and the chat settles after `BAND_AGENT_QUIET_MS` (default 10 s) of silence. A background task ending (an AIR `async_task_state_update`) or the soonest hold lapsing moves `monitoring` to `done`.
- Background work (issue #1039, `services/background-wake-service.ts`). When an AIR async task the agent announced ends while no Band turn runs, the service waits `BAND_BACKGROUND_WAKE_MS` (default 5 s, read on every task end) and, if the agent has started no turn of its own by then, sends one short message naming the ended tasks (`submitOrQueueTask`). An agent-started turn (an update outside a Band turn), a running or queued turn, and a stopped, exited or removed process cancel it. A task the process never announced is not woken for. Hub-run chats only; a worker-owned chat has the same gap. `chats.list` returns `lastActivityAt` (when the agent last sent an update, an async task update or got an answer, null for an owned chat) and `stalled` (a turn runs, no request waits on the user, and the agent was silent for `BAND_TURN_QUIET_STALL_MS`, default 20 minutes, read on every call). Band never stops a stalled turn itself. The web shows `StalledPill` (polls `chats.list` every 30 s), the CLI shows `running (stalled)`. Tests: `apps/hub/tests/background-wake-stall.test.ts`, `apps/web/e2e/chat-stalled.spec.ts`.
- Hooks: `packages/coding-agent/src/hook-status.ts` maps each Claude Code event (`mapClaudeCodeHookStatus`, `foldSubagents` for subagents that outlive the main `Stop`). `band notify` never fails: it prints nothing, exits 0 and returns within one second. A hook belongs to the agent session of its terminal (see the `agent-sessions` note) and matches a worktree by worker and cwd (`resolveWorktreeIdByCwd(cwd, hostId)`); the worker relay writes the worker's id into `statuses.notify`.
- Nothing installs hooks by itself. `hooks.hosts | check | install | remove` (admin, per worker through `host.agentEnv.hooksStatus | installHooks | removeHooks`) back the banner in `DashboardShell.tsx` and Settings > Agent hooks. `packages/host-local/src/agents/hooks-install.ts` edits Band's entries only, refuses an unparsable settings file and writes through a temporary file. The hook command is `"<band>" notify --agent claude-code >/dev/null 2>&1 || true` with `async: true` and `timeout: 5`. The banner's dismissal is the client-state key `band:agent-hooks-banner-dismissed` holding the hooks version (`HOOKS_VERSION`), so a newer set shows it once more.
- Tests: `apps/hub/tests/needs-attention.test.ts`, `agent-status-sources.test.ts`, `agent-status-states.test.ts`, `hook-host-routing.test.ts`, `claude-hooks-install.test.ts`, `packages/coding-agent/tests/hook-status.test.ts`, `packages/host-local/tests/hooks-install.test.ts`, `notify_is_silent_*` in `apps/cli/tests/integration.rs`, `apps/web/e2e/agent-status-states.spec.ts` and `agent-hooks.spec.ts`.
- Unread mark. `worktrees.unread` (boolean, default false) is a person's manual mark, shared by every device. Only `RepoQueries.setUnread` writes it, `saveAll` copies it from the rows it replaces, and `CheckpointService.restoreFrom` carries it to the restored copy. `repos.list` returns `unread` per worktree. `worktrees.setUnread { worktreeId, unread, hostId? }` sets it and emits `worktree-origin-changed`, which refreshes the sidebar on other devices. `unread: false` also clears `done` and `failed` like `statuses.clearNeedsAttention`. `statuses.clearNeedsAttention { clearUnread: true }` is how opening a worktree drops the mark (`WorktreeService.clearUnreadOnOpen`, silent when the flag is not set). `worktrees.setUnread` is left out of the MCP endpoint and the relay's list, so an agent gets 403. The web store (`dashboard-store.ts`) keeps `protectedUnreadId`: a worktree marked while it is open keeps the mark until another worktree is opened. `AgentStatusIndicator` draws one dot: an agent state over the unread dot, the unread dot (the `done` color) over the idle dot. The dot is a button that toggles the mark, and the card menu has "Mark as read" or "Mark as unread". CLI: `band worktrees mark-unread | mark-read <id>`, and `worktrees list` shows `unread`. Mobile: `lib/unread.ts`, the row action sheet and the idle dot in `StateIcon`; its list re-reads `repos.list` every 30 s, so a mark from another device shows within that time. Tests: `apps/hub/tests/worktree-unread.test.ts`, the `set-unread` probe in `remote-relay.test.ts`, `apps/web/e2e/worktree-unread.spec.ts`, `worktrees_mark_unread_*` in `apps/cli/tests/integration.rs`, `apps/mobile/tests/unread.test.ts`.
- Not done yet: presence (the stuck dot), OS notifications and push, and a mark raised automatically when a turn ends on a worktree the user has open.
