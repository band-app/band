---
name: band-chat-test
description: Drive a Band coding-agent chat from the CLI against a local dev server for verification or smoke testing. Use when you need to exercise a chat / agent adapter end-to-end without clicking through the dashboard — e.g. verifying a coding agent's ACP integration (`apps/web/src/server/infra/agents/`), regression-testing after a refactor, or capturing structured agent output to assert on. Handles the dev-vs-prod port mismatch (the CLI defaults to port 3456 but `pnpm dev:web` typically lands on 3457/3458 because the production Band server is already on 3456) by pointing the CLI at the dev server via `BAND_SERVER_URL`. Triggers include "smoke-test the codex adapter", "verify the agent works end-to-end", "test the chat from the CLI", "drive a chat from the terminal".
allowed-tools: Bash, Read
---

# Test a Band Chat via CLI

Drive a coding-agent chat session end-to-end from the terminal — start the dev server, point the CLI at it, kick off a workspace or send a message, watch the streaming NDJSON output, and assert on it. Faster and more scriptable than clicking through the dashboard, and produces structured output you can paste into a PR as evidence.

This skill is for **verification**, not for ordinary day-to-day work. Day-to-day chat use is documented in the sibling `band-chat` skill (the global CLI skill auto-generated from the schema). Use this skill when:

- You changed how Band talks to an agent over ACP (`apps/web/src/server/infra/agents/*`, `agent-session-service.ts`) and want to prove it works
- A reviewer asked you to demonstrate runtime behaviour
- You need to capture an agent transcript for a PR or bug report

## The dev-vs-prod port gotcha

`pnpm dev:web` runs Vite on port **3456 by default**, but if that port is already in use (the production Band server installed via the dashboard is almost always bound to 3456) Vite falls forward to 3457, then 3458, etc. Vite logs the port it actually settles on.

The Band CLI picks its server in this order (see `apps/cli/src/api.rs`):

1. `$BAND_SERVER_URL` env var — full URL, e.g. `http://127.0.0.1:3458`
2. else `settings.web_server_port` from `~/.band/settings.json` (default `3456`)

The CLI **does not auto-detect** the dev port. Without `BAND_SERVER_URL`, every `band` invocation talks to the production server on 3456, which means your test results reflect production state, your kickoff lands in the wrong server's database, and the agent you "fixed" never actually ran with the dev-server code. **This is the single most common way to waste 20 minutes on a fake green run.** Always export `BAND_SERVER_URL` for the duration of a test session.

Auth uses the same priority: `$BAND_TOKEN` else `settings.token_secret`. Usually you do not need to set this — the dev server reads the same `~/.band/settings.json` and `runFirstTimeSetup` ensures a token exists, so the fallback works. Only set `BAND_TOKEN` explicitly if the dev server is using a different settings file (rare).

## Prerequisites

- Repo root is the Band worktree you're testing in. Run all commands from there unless noted.
- The agent's binary is installed on PATH and logged in:
  - `codex` agent: `which codex` returns a path, `ls ~/.codex/auth.json` exists
  - `claude-code` agent: `which claude` (or your alias such as `claude-xyz`) returns a path
  - `opencode` agent: `which opencode` returns a path
- The cwd is a registered Band workspace. The worktree you're standing in (where the dev server is serving from) should appear in `band workspaces list --output json` — Band-managed worktrees under `.band/worktrees/<project>/<branch>/` register automatically.

## Workflow

### 1. Start the dev server and capture the port

Run the dev server in the background and tee its stdout/stderr to a log so you can scrape the port out of it. Do NOT kill the production server — Vite will fall forward.

```bash
pnpm dev:web > /tmp/band-dev.log 2>&1 &
DEV_PID=$!

# Wait for Vite to print its Local: line, then extract the port
PORT=""
for _ in $(seq 1 15); do
  sleep 2
  PORT=$(grep -oE 'Local:\s+http://localhost:[0-9]+' /tmp/band-dev.log | grep -oE '[0-9]+$' | head -1)
  if [ -n "$PORT" ]; then break; fi
done

# Fail loudly rather than silently letting the rest of the workflow
# target the wrong server. Slow machines / first-run dep installs can
# push Vite's startup past 30 s — bump the loop bound if needed, but
# never proceed with $PORT empty.
if [ -z "$PORT" ]; then
  echo "ERROR: timed out waiting for Vite to bind a port — dumping /tmp/band-dev.log:" >&2
  cat /tmp/band-dev.log >&2
  kill -TERM "$DEV_PID" 2>/dev/null
  exit 1
fi
echo "Dev server on port $PORT (pid $DEV_PID)"
```

### 2. Point the CLI at the dev server

```bash
export BAND_SERVER_URL="http://127.0.0.1:$PORT"
```

Sanity-check that the CLI is actually talking to the dev server (and not silently falling through to 3456):

```bash
band projects list --output json | head -c 200
```

If this returns project data the connection is good. If it errors with `Cannot connect to Band web server.` then either `$PORT` is wrong or the dev server is still booting — wait a couple more seconds and retry.

### 3. Send the test prompt — always from the current worktree

**Run from the worktree whose code you're testing.** The dev server you started in step 1 is serving from this worktree's source; the chat workspace just needs to be a registered Band workspace and the current worktree already is one. Don't spin up a fresh workspace — it adds setup + cleanup with zero diagnostic value, since the adapter being exercised is the one in the dev server's process, not the one in the workspace's filesystem.

`band chats send` auto-detects the workspace from `cwd`, so no `--workspace` flag is needed. Override the agent and model per-message so you can test an adapter different from the workspace's configured default without mutating the workspace:

```bash
band chats send \
  --agent <agent-type> \
  --model <model-id> \
  --message "<the test prompt>"
```

- `<agent-type>` — one of `codex`, `claude-code`, `opencode`, `cursor-cli` (the latter has no skills directory but is valid for chat). Use the exact type ID; values not in `band settings`'s `codingAgents[].id` list are silently rejected and the workspace's default agent is used instead, so verify with `band settings` first if you're unsure.
- `<model-id>` — call `/trpc/models.listAll` (or the `models.listAll` CLI helper) for the list each adapter accepts. Over ACP the list is the agent's `model` session config option (`band chats` pickers read the same).

Test prompts should be **small and observable** — "list the files in this directory" or "echo 'pong' to a file called pong.txt". Avoid prompts that touch the network or take more than a turn or two; every turn costs API budget and time, and the goal is to confirm the *event pipeline* works, not to evaluate the model.

If the worktree doesn't have an active chat pane yet, `band chats send` will create one and use it. To target a specific existing pane, pass its ID as the positional argument: `band chats send <chat-id> --message ...`. List existing panes with `band chats list`.

### 4. Watch the NDJSON event stream

`band chats watch` defaults to the cwd workspace's first chat pane, so from the same worktree:

```bash
band chats watch > /tmp/chat-stream.ndjson
```

This streams the raw NDJSON events the dashboard subscribes to, and ends when the turn ends (`turn-ended` with nothing queued). For a hands-off run send it to a file.

Tip: for a live tail in another shell, `band chats watch | jq .` is readable. To watch a specific pane, pass its ID: `band chats watch <chat-id>`.

### 5. Assert on the stream

Every agent emits the same ACP event vocabulary; only the tool titles and kinds differ.

```bash
echo "=== events seen ==="
jq -r 'if .type == "update" then "update:" + .update.sessionUpdate else .type end' /tmp/chat-stream.ndjson | sort | uniq -c

echo "=== agent text ==="
jq -rj 'select(.type=="update" and .update.sessionUpdate=="agent_message_chunk") | .update.content.text' /tmp/chat-stream.ndjson; echo

echo "=== turn end ==="
jq -c 'select(.type=="turn-ended")' /tmp/chat-stream.ndjson | tail -1
```

A minimal happy-path stream looks like:

```
prompt           {text: "..."}
turn-started     {taskId: "..."}
update           {update: {sessionUpdate: "agent_message_chunk", content: {type: "text", text: "..."}}}
update           {update: {sessionUpdate: "tool_call", toolCallId: "...", title: "...", kind: "execute"}}   # if the prompt needs a tool
update           {update: {sessionUpdate: "tool_call_update", toolCallId: "...", status: "completed"}}
update           {update: {sessionUpdate: "usage_update", used: ..., size: ...}}
turn-ended       {stopReason: "end_turn", usage: {...}}
```

Fail-fast checks before declaring success:
- `turn-ended.stopReason === "end_turn"` and no `turn-ended.error`
- At least one `agent_message_chunk` arrived (proves the model actually responded)

### 6. Clean up

Nothing to dispose of on the workspace side — we used the current worktree, which you keep regardless. Just kill the dev server and unset the env override so subsequent `band` invocations go back to the production server:

```bash
kill -TERM "$DEV_PID" 2>/dev/null
wait "$DEV_PID" 2>/dev/null
unset BAND_SERVER_URL
```

If you created a one-off chat pane during the test and want to tidy up, list and remove it: `band chats list` then `band chats remove <chat-id>`. Optional — old chat panes are harmless.

## Pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| `band` commands succeed but you don't see the chat in your dev dashboard | CLI is talking to the production server on 3456, not your dev server | Re-export `BAND_SERVER_URL` and re-run; verify with `band settings` |
| `Cannot connect to Band web server` | Wrong port, or dev server not booted yet | Recheck `/tmp/band-dev.log` for the `Local:` line; the port may have moved |
| `turn-ended` with an auth-style `error` (e.g. "Authentication required") | The user is not logged in to the agent CLI | `codex login` (or equivalent for the agent) — auth state is host-wide |
| `chat watch` stops moving after a `permission` or `elicitation` event | The agent's own permission rules asked the user; over ACP Band forwards the request instead of auto-approving | Answer it in the dashboard, or pick a more permissive mode (e.g. Claude Code `acceptEdits` / `bypassPermissions`) |
| `band chats send` succeeds but the stream's events look wrong (claude-code shapes when you asked for codex, etc.) | The agent type was rejected silently and Band fell back to the workspace's default agent | Verify the `--agent <id>` value is one of the IDs in `band settings` under `codingAgents[].id`. When in doubt, query `/trpc/models.listAll` |
| `band chats send` fails with "no workspace at this path" | You're not standing in a registered Band worktree | Run from a Band-managed worktree (anywhere under `.band/worktrees/<project>/<branch>/` or a path that appears in `band workspaces list --output json`). Or pass `--workspace <id>` explicitly |

## Notes on event shapes

Every agent runs as an Agent Client Protocol subprocess (claude-agent-acp, codex-acp, `opencode acp`, `gemini --acp`, `agent acp`). The stream forwards each ACP `session/update` unchanged as an `update` event; Band adds `prompt`, `turn-started`, `turn-ended`, `permission`, `elicitation`, `request-resolved`, `session-attached`, `file` and `notice`. The wire schema is `apps/web/src/shared/chat-events.ts`; what each agent sends is the ACP spec plus the agent's own quirks (see the comments in `apps/web/src/server/infra/agents/acp-launch.ts`).
