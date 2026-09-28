---
name: band-loop
version: 0.1.0
description: Schedule a recurring prompt against a Band workspace's coding agent via a cronjob, with an optional self-deleting "stop when criteria is met" wrapper. Use when the user wants to "loop on X every 10m", "keep retrying until Y", "poll the deploy every 5 minutes", "check in every hour until tests pass", "run this prompt on a recurring interval", or otherwise asks for an iterative/repeating agent task. Wraps `band cronjobs create` so the agent re-runs the same prompt on a fixed cadence (default 10m), and optionally appends a stop-condition that makes the agent delete its own cronjob with `band cronjobs delete` when done. Caps loop lifetime at 7 days by default to match the safety horizon Claude Code's built-in `/loop` uses.
allowed-tools: Bash
argument-hint: <prompt> [--every <duration>] [--until <stop condition>] [--max-iterations <n>] [--via chat|terminal]
---

# Band Loop

Recurring agent tasks via `band cronjobs`. The agent fires on a cron schedule against a target workspace — dispatching each iteration to the workspace's chat pane (default) or the agent's terminal CLI (`--via terminal`) — optionally checks a stop condition each iteration, and deletes its own cronjob when the condition is met.

This is the **native answer** for users who reach for Claude Code's built-in `/loop`: that command is gated behind `scheduledTasksEnabled`, which is always `false` in SDK / Band sessions. `band cronjobs` runs server-side and survives session restarts.

This skill is focused on the **scheduled-loop pattern**. For broader operations see the sibling skills:

- **`band`** — workspaces, projects, tunnel, settings (also documents `band cronjobs` for general CRUD).
- **`band-start`** — create a new workspace and kick off the first agent task.
- **`band-chat`** — chat panes inside a workspace (the loop's prompt is dispatched to a chat).

## Prerequisites

- The Band server must be running (started by the Band dashboard app).
- A target workspace must exist (use **`band-start`** to create one first if needed).

## JSON Output

All commands support `--output json` (or `BAND_OUTPUT=json` env var) for structured output.

- **Success**: JSON object to stdout, exit code 0
- **Error**: `{"error": "message"}` to stderr, exit code 1

## Workflow

### 1. Resolve the loop target

A cronjob is scoped to either a **project** or a **workspace**. For an agent loop you almost always want **workspace scope** so the prompt fires into the same chat over and over:

```sh
# Auto-detect the workspace ID from cwd
ws_id=$(band workspaces list --output json \
  | jq -r --arg cwd "$PWD" '.workspaces[] | select(.path == $cwd) | .id' \
  | head -1)
```

If the user is outside a workspace cwd, ask them which workspace to target (or run `band workspaces list` and pick one).

### 2. Parse the interval into a cron expression

Accept human durations (`5m`, `10m`, `1h`, `6h`, `1d`). Default is `10m`. Map to a standard 5-field cron expression in the server's local timezone:

| Duration | Cron expression  | Meaning              |
| -------- | ---------------- | -------------------- |
| `5m`     | `*/5 * * * *`    | every 5 minutes      |
| `10m`    | `*/10 * * * *`   | every 10 minutes     |
| `15m`    | `*/15 * * * *`   | every 15 minutes     |
| `30m`    | `*/30 * * * *`   | every 30 minutes     |
| `1h`     | `7 * * * *`      | hourly at :07        |
| `6h`     | `0 */6 * * *`    | every 6 hours        |
| `1d`     | `0 9 * * *`      | daily at 09:00       |

> **Tip:** for "hourly" or coarser cadences, prefer minute offsets that aren't `:00` or `:30` — every loop in the fleet that lands on `:00` thunders together. Pick a non-round minute like `:07` or `:23` when the user's request is approximate.

If the user passes a literal cron expression (5 whitespace-separated tokens), use it as-is.

### 3. Compose the iteration prompt

Two flavours:

**A. Open-ended loop** — no stop condition. The cronjob just fires the prompt every interval until the user (or the 7-day cap) stops it.

The iteration prompt is the user's prompt verbatim.

**B. Ends-when-done loop** — the user gave a stop condition. Wrap the prompt so the agent **self-deletes** the cronjob once the condition is met:

```text
<user prompt>

---
STOP CONDITION: <user's stop condition>

After completing your work this iteration, evaluate the stop condition.
- If the stop condition is met, run this shell command to terminate the loop:

      band cronjobs delete <key> <cronjob_id>

- If the stop condition is NOT met, do nothing extra — the next iteration
  fires automatically on schedule.

This is iteration of a recurring loop. Do not assume previous iterations
ran successfully; re-check state at the start of each run.
```

The `<key>` and `<cronjob_id>` placeholders must be substituted after the cronjob is created (see step 5 — we don't know the ID until then).

### 4. Create the cronjob

`band cronjobs create` requires `--name`, `--prompt`, and `--cron`. For workspace-scoped loops, set `--scope workspace` and pass the workspace ID twice (once positionally as `key`, once as `--workspace-id`).

**Dispatch target (`--via`).** Each iteration dispatches to either the workspace's chat pane (`--via chat`) or the agent's **headless** CLI in a fresh PTY (`--via terminal`). Omit the flag to inherit the caller's context: the CLI resolves it via the same precedence as `band workspaces create` (`--via` flag → `BAND_DISPATCH` env → `.band/config.json`/`~/.band/settings.json` config → `terminal`), while the web UI / server default is `chat`. So a loop set up from a chat agent stays on chat and one set up from a terminal runs in a terminal. Two things to know about `--via terminal` loops:

- The pane runs the agent's **non-interactive one-shot** mode (`claude -p …`, `codex exec …`, etc.), not the interactive REPL — so it runs the task, streams output, and **exits**. The pane is therefore **self-closing** (runs, then closes when the agent finishes), so a frequent loop doesn't pile up panes (≈1 live pane per loop). Its output isn't retained after completion (the outcome is in the cronjob's `lastRunStatus`).
- An iteration is **skipped** (recorded `skipped`) if the previous run's pane is still active, so an agent that runs longer than the interval is never interrupted mid-work.

For workspace-scoped loops:

```sh
job=$(band cronjobs create "$ws_id" \
  --scope workspace \
  --workspace-id "$ws_id" \
  --name "Loop: <short summary>" \
  --cron "*/10 * * * *" \
  --prompt "<placeholder — will be updated in step 5>" \
  --output json)

cronjob_id=$(echo "$job" | jq -r .id)
```

### 5. Patch the prompt with the cronjob ID (ends-when-done flavour only)

For the open-ended flavour, skip this step — the prompt from step 4 is already final.

For the ends-when-done flavour, substitute the now-known `cronjob_id` into the wrapped prompt and update the cronjob:

```sh
final_prompt="<user prompt>

---
STOP CONDITION: <stop condition>

After completing your work, if the stop condition is met, run:

    band cronjobs delete $ws_id $cronjob_id

Otherwise do nothing extra — the next iteration fires on schedule."

band cronjobs update "$ws_id" "$cronjob_id" --prompt "$final_prompt"
```

### 6. Enforce a safety cap

Cronjobs have no built-in TTL. Apply a 7-day cap to match Claude Code's `/loop` horizon — schedule yourself a reminder, or include the cap directly in the wrapped prompt so the agent self-deletes after a date threshold:

```text
SAFETY: If the current date is on or after <YYYY-MM-DD + 7 days>, treat
the loop as expired and run `band cronjobs delete <key> <cronjob_id>`
regardless of the stop condition.
```

For an explicit `--max-iterations <n>` cap, ask the agent to count iterations in a known file inside the worktree (e.g. `.band/loop-iterations`) and exit when the count reaches `n`.

### 7. Report the result

Tell the user:

- The cronjob ID (`cj_...`) and the cron expression that was scheduled.
- The next firing time (best-effort — compute from the cron expression).
- That the loop will auto-delete when the stop condition is met (if applicable) or at the 7-day cap.
- How to inspect and abort manually:

  ```sh
  band cronjobs list --workspace <ws_id>
  band cronjobs trigger <key> <cronjob_id>   # fire it once right now
  band cronjobs delete  <key> <cronjob_id>   # stop the loop
  ```

- That the agent's output for each iteration streams to the workspace's chat — tail it with:

  ```sh
  cd <workspace-path>
  band chats watch
  ```

## Examples

### Open-ended loop, every 10 minutes

User input: `Loop on improving test coverage in this workspace every 10 minutes`

1. Resolve `ws_id` from cwd.
2. Interval `10m` → cron `*/10 * * * *`.
3. Iteration prompt is the user prompt verbatim.
4. Create cronjob:

   ```sh
   band cronjobs create "$ws_id" \
     --scope workspace --workspace-id "$ws_id" \
     --name "Loop: improve test coverage" \
     --cron "*/10 * * * *" \
     --prompt "Improve test coverage in this workspace. Pick the lowest-coverage file each iteration and add tests; commit when green."
   ```

5. Report cronjob ID, schedule, and `band chats watch` instructions.

### Ends-when-done loop, hourly

User input: `Every hour, check whether the deploy in #ops-deploys turned green. Stop once it's green.`

1. Resolve `ws_id` from cwd (or ask).
2. Interval `1h` → cron `7 * * * *` (off-zero minute).
3. Create the cronjob with a placeholder prompt and capture the ID:

   ```sh
   job=$(band cronjobs create "$ws_id" \
     --scope workspace --workspace-id "$ws_id" \
     --name "Loop: poll deploy until green" \
     --cron "7 * * * *" \
     --prompt "<placeholder>" \
     --output json)
   cronjob_id=$(echo "$job" | jq -r .id)
   ```

4. Patch with the wrapped, self-deleting prompt:

   ```sh
   band cronjobs update "$ws_id" "$cronjob_id" --prompt "Check whether the deploy in #ops-deploys turned green.

   ---
   STOP CONDITION: deploy status is 'green' or 'success'.

   After completing your work, if the stop condition is met, run:

       band cronjobs delete $ws_id $cronjob_id

   Otherwise do nothing extra — the next iteration fires on schedule.

   SAFETY: If the current date is on or after $(date -v+7d +%Y-%m-%d), run
   the same delete command regardless of the stop condition."
   ```

5. Report cronjob ID, the 1-hour cadence, and that the loop self-terminates on green or after 7 days.

### Cancel a loop early

```sh
# Find the cronjob
band cronjobs list --workspace "$ws_id"

# Delete it
band cronjobs delete "$ws_id" cj_1234567890
```

## Invariants

- The cronjob's `--prompt` is what the agent sees on every firing — keep it self-contained (no shell variables, no implicit "previous iteration" context).
- Workspace-scoped cronjobs (`--scope workspace --workspace-id <ws_id>`) dispatch into the workspace — the cronjob's dedicated chat pane by default, or a fresh terminal pane with `--via terminal`. Project-scoped jobs fire against the project's main-branch workspace.
- `--via terminal` loops run the agent's headless CLI in a self-closing PTY per iteration and skip a tick while the previous run is still active — the self-deleting stop-condition pattern still works, since the agent runs `band cronjobs delete` from inside the headless run just as it would from a chat.
- The self-deleting pattern requires the agent itself to run `band cronjobs delete` — the cron engine has no built-in stop condition. The agent needs `band` on its `PATH` (true by default after `band` is installed).
- Cap loop lifetime at **7 days** unless the user explicitly overrides — same horizon as Claude Code's `/loop`.
- For an iteration-count cap, the agent must persist a counter to a file inside the worktree (cronjobs are stateless across runs).

## Cross-references

- General `band cronjobs` CRUD (list / update / trigger / delete) is also documented under the **`band`** skill.
- To send a one-off message to a chat instead of a recurring one, use **`band-chat`** (`band chats send`).
- To create the workspace the loop runs against, see **`band-start`**.

## Configuration

See the `band` skill for environment variables (`BAND_SERVER_URL`, `BAND_TOKEN`, `BAND_OUTPUT`, `BAND_HOME`).
