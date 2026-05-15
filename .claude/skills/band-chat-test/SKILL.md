---
name: band-chat-test
description: Drive a Band coding-agent chat from the CLI against a local dev server for verification or smoke testing. Use when you need to exercise a chat / agent adapter end-to-end without clicking through the dashboard — e.g. verifying a new adapter in `packages/coding-agent/src/adapters/`, regression-testing after a refactor, or capturing structured agent output to assert on. Handles the dev-vs-prod port mismatch (the CLI defaults to port 3456 but `pnpm dev:web` typically lands on 3457/3458 because the production Band server is already on 3456) by pointing the CLI at the dev server via `BAND_SERVER_URL`. Triggers include "smoke-test the codex adapter", "verify the agent works end-to-end", "test the chat from the CLI", "drive a chat from the terminal".
allowed-tools: Bash, Read
---

# Test a Band Chat via CLI

Drive a coding-agent chat session end-to-end from the terminal — start the dev server, point the CLI at it, kick off a workspace or send a message, watch the streaming NDJSON output, and assert on it. Faster and more scriptable than clicking through the dashboard, and produces structured output you can paste into a PR as evidence.

This skill is for **verification**, not for ordinary day-to-day work. Day-to-day chat use is documented in the sibling `band-chat` skill (the global CLI skill auto-generated from the schema). Use this skill when:

- You changed an adapter in `packages/coding-agent/src/adapters/*` and want to prove it works
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
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 2
  PORT=$(grep -oE 'Local:\s+http://localhost:[0-9]+' /tmp/band-dev.log | grep -oE '[0-9]+$' | head -1)
  if [ -n "$PORT" ]; then break; fi
done
echo "Dev server on port $PORT (pid $DEV_PID)"
```

If `$PORT` is empty after ~20 s, dump `/tmp/band-dev.log` and fix whatever is wrong (port exhaustion, dependency installs, etc.) before continuing.

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
- `<model-id>` — call `/trpc/models.listAll` (or the `models.listAll` CLI helper) for the list each adapter accepts. For `codex` see `CODEX_MODELS` in `packages/coding-agent/src/adapters/codex.ts`.

Test prompts should be **small and observable** — "list the files in this directory" or "echo 'pong' to a file called pong.txt". Avoid prompts that touch the network or take more than a turn or two; every turn costs API budget and time, and the goal is to confirm the *event pipeline* works, not to evaluate the model.

If the worktree doesn't have an active chat pane yet, `band chats send` will create one and use it. To target a specific existing pane, pass its ID as the positional argument: `band chats send <chat-id> --message ...`. List existing panes with `band chats list`.

### 4. Watch the NDJSON event stream

`band chats watch` defaults to the cwd workspace's first chat pane, so from the same worktree:

```bash
band chats watch > /tmp/chat-stream.ndjson
```

This streams the raw NDJSON events the dashboard subscribes to and blocks until the session completes (or you Ctrl-C / `kill` it). For a hands-off run send it to a file and let the agent's `session-result` event end the stream naturally.

Tip: for a live tail in another shell, `band chats watch | jq .` is readable. To watch a specific pane, pass its ID: `band chats watch <chat-id>`.

### 5. Assert on the stream

Look for the canonical event sequence. Adapt the agent-specific event types — different adapters emit slightly different `tool-use` toolNames, but the lifecycle events are uniform.

```bash
echo "=== events seen ==="
jq -r '.type' /tmp/chat-stream.ndjson | sort | uniq -c

echo "=== session-start ==="
jq -c 'select(.type=="session-start")' /tmp/chat-stream.ndjson

echo "=== final session-result ==="
jq -c 'select(.type=="session-result")' /tmp/chat-stream.ndjson | tail -1

echo "=== any errors? ==="
jq -c 'select(.type=="error")' /tmp/chat-stream.ndjson
```

A minimal happy-path stream looks like:

```
session-start    {sessionId: "..."}
text-delta       {text: "..."}
text-delta       {text: "..."}
tool-use         {toolName: "Bash", input: {...}}      # if the prompt requires it
tool-result      {toolCallId: "...", output: "..."}
text-delta       {text: "..."}
usage            {inputTokens: ..., outputTokens: ...}
session-result   {success: true, durationMs: ..., numTurns: ..., errors: []}
```

Fail-fast checks before declaring success:
- `session-result.success === true`
- `session-result.errors` is empty
- At least one `text-delta` event arrived (proves the model actually responded)
- Zero `type: "error"` events

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
| `session-result.success: false` with `Cannot find module "@openai/codex-sdk"` | The adapter's static SDK import is failing. `@openai/codex-sdk` is a concrete peer dep that pnpm auto-installs, so a properly-built Band install always has it — hitting this almost always means you're running against a pre-built bundle that omitted the dep, not the dev source | Confirm `BAND_SERVER_URL` is set to the dev port |
| `session-result.success: false` with auth-style errors from the codex binary | The user is not logged in to the agent CLI | `codex login` (or equivalent for the agent) — auth state is host-wide |
| `chat watch` hangs forever after a tool-use | Agent waiting on an approval the SDK is configured to never grant; or a sandbox-write that needs a different mode | Pass `--mode edit` to `band chats send`; for codex specifically, the adapter passes `approvalPolicy: "never"` so this should be rare |
| `band chats send` succeeds but the stream's events look wrong (claude-code shapes when you asked for codex, etc.) | The agent type was rejected silently and Band fell back to the workspace's default agent | Verify the `--agent <id>` value is one of the IDs in `band settings` under `codingAgents[].id`. When in doubt, query `/trpc/models.listAll` |
| `band chats send` fails with "no workspace at this path" | You're not standing in a registered Band worktree | Run from a Band-managed worktree (anywhere under `.band/worktrees/<project>/<branch>/` or a path that appears in `band workspaces list --output json`). Or pass `--workspace <id>` explicitly |

## Notes on event shapes per adapter

The lifecycle events (`session-start`, `text-delta`, `tool-use`, `tool-result`, `usage`, `session-result`, `error`) are normalized by each adapter into Band's `AgentEvent` union, defined in `packages/coding-agent/src/events.ts`. The adapter source (`packages/coding-agent/src/adapters/*.ts`) is the authoritative mapping from each SDK's raw events to `AgentEvent`. If you're adding a new adapter, reading `codex.ts` is the cleanest reference — it covers thread lifecycle, item lifecycle (started/updated/completed), turn lifecycle (started/completed/failed), and usage accounting.
