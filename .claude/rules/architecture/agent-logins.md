---
paths:
  - "**/AgentLoginsSettings.tsx"
  - "**/ChatLoginMenu.tsx"
  - "**/agent-logins-worker.test.ts"
  - "**/agent-session-service.ts"
  - "**/follow-service.ts"
  - "apps/hub/src/mcp/server.ts"
  - "apps/hub/tests/agent-logins.test.ts"
  - "apps/web/e2e/settings-agent-logins.spec.ts"
  - "docs/agent-logins.md"
  - "packages/shared/src/agent-logins.ts"
---

# Architecture: agent logins

An admin gives coding agents credentials from the vault (guide: `docs/agent-logins.md`). A login is `agent_logins { id, agentType, label, kind, vaultItemId }`, and `agent_login_choices { agentType, repo, loginId }` holds the default (`repo` is `""`) and the per-repo overrides. Neither table holds a secret. `AgentLoginService.create` with a `secret` writes a global `api_key` vault item named `agent-login:<id>`, and `remove` deletes that item.

- Kinds (`packages/shared/src/agent-logins.ts`, `AGENT_LOGIN_KINDS`) say which variable carries the secret and which inherited variables of the same agent are removed. The UI and the hub read the same table.
- Resolution at every agent start (`AgentLoginService.resolve`): the chat's `loginId` (stored in the chat's panel state), the repo's override, the agent's default, else nothing. It reads the vault each time, skips a login whose item is gone, and returns `{ env, unsetEnv }`.
- Injection: `withAgentLogin` in `agent-session-service.ts` (`ensureProcess`, `probe`, `oneShot`), `launchForOwner` (the `unsetEnv` field of `ChatLaunchReply`), and `TerminalService.spawn` with `opts.agentType` (set by `AgentLaunchService.launchTui`; the login goes in the backend request and not in `addTerminalToLayout`). `AcpLaunch.unsetEnv` and `SpawnOptions.unsetEnv` carry the removals through `acp.spawn` and `pty.spawn`, and `spawnAgentProcess` and `TerminalPool` apply them before `env` is merged.
- A worker that reports an agent as not logged in still counts as able to run it when a login exists for the agent type (`hasUsableLogin`, used by `usableAgents`, `follow-service.ts` and `workers.list`).
- API: `agentLogins.list | create | update | remove | setDefault | setRepoOverride`, all `adminProcedure`, left out of the MCP endpoint and the relay. `models.listAll` returns each agent's `logins` (id, label, kind label, `isDefault`) for the chat picker, and `chats.update { loginId }` sets the chat's pick (only a login of the chat's agent type, and a chat that switches agent drops it).
- UI: Settings > Agent logins (`AgentLoginsSettings.tsx`), the repo override in Settings > Repos (`RepoLoginOverrides`), and `ChatLoginMenu.tsx` beside the model menu.
- Codex: a login or model provider already configured on the machine still wins over a Codex API key login, because the adapter signs in with the key only when Codex needs authentication. Per-login `CODEX_HOME` is a later phase.
- Trust: restricted workers receive logins too. The relay refuses `agentLogins.*` and `chats.update { loginId }` at every level, and the MCP handler (`apps/hub/src/mcp/server.ts`) refuses `chats.update { loginId }`. `AcpAgentProcess` scrubs login secret values from stderr and error messages (`loginSecretScrubber`).
- Terms: a Claude setup token is a Claude.ai credential. See the warning in `docs/agent-logins.md`.
- Tests: `apps/hub/tests/agent-logins.test.ts`, `agent-logins-worker.test.ts`, `apps/web/e2e/settings-agent-logins.spec.ts`. The ACP stub records variables named in `BAND_TEST_ACP_LOG_ENV` under `env.NAMED`.
- Not done yet: `band agent-logins` in the CLI, logging in on a worker from the UI, the Codex `auth.json` pool, gateway logins and a model API proxy.
