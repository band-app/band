---
paths:
  - "**/quick-commands.test.ts"
  - "**/quick-commands.spec.ts"
  - "apps/hub/src/server/api/quick-commands/**"
  - "apps/hub/src/server/infra/db/queries/quick-commands.ts"
  - "apps/hub/src/server/services/quick-command-service.ts"
  - "apps/mobile/src/lib/quick-commands.ts"
  - "apps/web/src/dashboard/components/QuickCommand*.tsx"
---

# Architecture: quick commands

A person saves terminal commands and agent prompts on the hub and runs them with one tap in a worktree (guide: `docs/quick-commands.md`). `quick_commands` (`infra/db/queries/quick-commands.ts`, `services/quick-command-service.ts`, `api/quick-commands/router.ts`) holds `label`, `repo_name` (null for a global command), `action` (`terminal` with `command` and `append_enter`, or `agent` with `agent_id` and `prompt`) and `last_run_at`. `repo_name` has no foreign key, because `RepoQueries.saveAll` rewrites the repos table and a cascade would wipe the commands, so `repos.remove` calls `quickCommandService.removeForRepo`.

- The hub validates (label up to 80 characters, text up to 4000, a known repo and a known `settings.codingAgents` id, all 400) and orders the list by `last_run_at`, then label. It runs nothing. A client runs a command: a Terminal one is `terminal.create` with `command` (the shell runs it as it starts) or, with Append Enter off, `terminal.create` then `terminal.send` of the text; an Agent one is `agentSessions.launch` with the agent, the prompt and the device's mode. `quickCommands.markRun` moves it to the top.
- `quickCommands.*` is for any device token and left out of the MCP endpoint (`src/mcp/server.ts`) and the relay, so an agent can neither read nor plant a command.
- UI: `QuickCommandDialog.tsx`, `QuickCommandsMenu.tsx` (the tab bar button), the Quick Commands submenu of `TerminalSelectionContextMenu`, Settings > Quick commands. The menu opens Settings on a section through the `band:open-settings-section` window event. Mobile: `QuickCommandsSheet` in the worktree's more sheet, pure parts in `apps/mobile/src/lib/quick-commands.ts`.
- Tests: `apps/hub/tests/quick-commands.test.ts`, the `quick-commands-*` probes in `remote-relay.test.ts` and a check in `mcp.test.ts`, `apps/web/e2e/quick-commands.spec.ts`, `apps/mobile/tests/quick-commands.test.ts`.
- Not done yet: a `band quick-commands` CLI command, default commands, per-worker scope.
