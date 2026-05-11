---
name: band-start
version: 0.1.0
description: Kick off work on a new feature, bug fix, or task in a fresh Band workspace. Use when the user describes a piece of work and wants an agent to start on it — "start working on X", "create a workspace and implement Y", "kick off a task for ABCD-1234", "spin up a worktree to fix #42". Auto-detects the project from the cwd, parses any Jira (e.g. `ABCD-1234`) or GitHub (`#123`) ticket reference out of the prompt, fetches richer context with `acli` / `gh`, picks a Conventional Commits branch prefix (`feat/`, `fix/`, or `chore/`) based on the work, generates a kebab-case branch name, and creates the workspace with `--prompt` so the agent starts immediately.
allowed-tools: Bash
argument-hint: <prompt describing what to work on>
---

# Start a Band Workspace

Creates a Band workspace (git worktree) and submits a task to the coding agent in a single step. The only required input is the **prompt** — a natural-language description of what the agent should work on. This skill figures out the project, branch name, and any ticket context automatically.

This skill is focused on the **kickoff flow**. For broader operations see the sibling skills:

- **`band`** — workspaces, projects, cronjobs, tunnel, settings.
- **`band-chat`** — chat panes inside a workspace (`band chats send/watch/...`).
- **`band-loop`** — schedule a recurring prompt against a workspace (`band cronjobs ...`).
- **`band-terminal`** — terminal sessions inside a workspace.
- **`band-browser`** — browser tabs inside a workspace.

## Prerequisites

- The Band server must be running (started by the Band dashboard app). Connects to `http://localhost:3456` by default.
- The target project must be registered with Band (`band projects list` to check).
- Optional: `acli` for Jira ticket lookups, `gh` for GitHub issue lookups. Missing tools are non-fatal — the skill falls back to using the prompt as-is.

## JSON Output

All commands support `--output json` (or `BAND_OUTPUT=json` env var) for structured output.

- **Success**: JSON object to stdout, exit code 0
- **Error**: `{"error": "message"}` to stderr, exit code 1

## Workflow

### 1. Determine the project

Match the current working directory against the registered Band projects:

```sh
band projects list --output json | jq -r '.projects[] | "\(.name)\t\(.path)"'
```

Pick the project whose `path` is the cwd or one of its ancestors. If no match or the cwd is ambiguous (multiple registered projects under the same root), ask the user to pick one.

### 2. Detect a ticket reference in the prompt

Scan the prompt for either format:

- **Jira ticket** — `^[A-Z][A-Z0-9]+-\d+$` anywhere in the prompt (e.g. `ABCD-1234`, `WXYZ-567`). Letters-dash-numbers.
- **GitHub issue** — `#\d+` (e.g. `#42`) or a full GitHub issue URL (e.g. `https://github.com/<owner>/<repo>/issues/123`).

If neither is found and you still want to disambiguate which ticket system the project uses, check the git remote:

```sh
git -C <project-path> remote get-url origin
```

A `github.com` remote → assume GitHub Issues. Anything else → assume Jira.

### 3. Fetch ticket context (only if a reference is present)

**For Jira tickets:**

```sh
acli jira workitem view <TICKET-KEY> --fields summary,description
```

**For GitHub issues:**

```sh
gh issue view <issue-number> --repo <owner/repo>
```

Use the fetched title and description to:

- Build a richer prompt for the coding agent (append as additional context).
- Generate a more descriptive branch name summary.

If the CLI tool is not available, the command fails, or no ticket reference was found, **skip this step entirely** and work with the prompt as given. Never block on ticket fetching.

### 4. Generate the branch name

The branch name MUST start with a Conventional Commits-style prefix, then be all lowercase, kebab-case.

**Pick the prefix** by classifying the work:

| Prefix    | When to pick                                                                            |
| --------- | --------------------------------------------------------------------------------------- |
| `feat/`   | New user-visible functionality (adding a feature, screen, command, API endpoint).       |
| `fix/`    | Bug fix — restoring broken behavior, correcting a regression, patching incorrect logic. |
| `chore/`  | Everything else: deps, refactors, tests, docs, tooling, CI, internal cleanup.           |

When the prompt doesn't clearly fit `feat/` or `fix/`, **default to `chore/`** — it's the catch-all. Never produce a branch without a prefix.

**Compose the branch** as `<prefix>/<rest>`, where `<rest>` is:

| Reference type | `<rest>` format                       | Example                       |
| -------------- | ------------------------------------- | ----------------------------- |
| Jira ticket    | `<ticket-key>-<2-3-word-summary>`     | `feat/abcd-1234-add-labels`   |
| GitHub issue   | `<issue-number>-<2-3-word-summary>`   | `feat/42-dark-mode`           |
| No ticket      | `<2-3-word-summary>`                  | `fix/login-redirect`          |

Good examples:

- `feat/abcd-1234-add-labels` (new feature, Jira ticket)
- `fix/wxyz-567-login-redirect` (bug fix, Jira ticket)
- `feat/42-dark-mode` (new feature, GitHub issue)
- `fix/login-redirect` (bug fix, no ticket)
- `chore/bump-deps` (maintenance, no ticket)
- `chore/refactor-auth-module` (refactor, no ticket)

Bad examples (do NOT produce these):

- `feature/add-labels` — use `feat/`, not `feature/`.
- `abcd-1234-add-labels` — missing the `feat/` / `fix/` / `chore/` prefix.
- `ABCD-1234` — missing prefix and summary; not lowercase.
- `feat/abcd-1234-implement-the-new-feature-for-adding-labels-to-items` — too long; cap the summary at 2–3 words.
- `feat/fix/login-redirect` — exactly one prefix; if it's a fix, use `fix/`.

### 5. Compose the agent prompt

- Start with the user's original prompt verbatim.
- If you fetched ticket info in step 3, append a section with the ticket title and description so the agent has the full context.

### 6. Create the workspace

Always pass `--prompt` so the agent starts immediately — never create a workspace and then separately call `band chats send`. Capture the worktree path from `--output json` (the create response is shaped `{"path": "..."}`):

```sh
ws_path=$(band workspaces create <project> <branch> \
  --prompt "<composed prompt>" \
  --output json | jq -r .path)
```

`workspaces create` is idempotent — creating an existing workspace just returns its path, so re-running with the same arguments is safe.

### 7. Resolve the workspace ID and chat pane

`band workspaces create` doesn't return the workspace ID, only the path. Look it up by path from `band workspaces list` (the list response uses the field name `workspaceId`):

```sh
ws_id=$(band workspaces list --output json \
  | jq -r --arg path "$ws_path" '.workspaces[] | select(.path == $path) | .workspaceId')
```

`--prompt` lazy-creates a chat pane for the agent task. Look up that pane's ID so you can print a fully-resolved watch command (no `<chat-id>` placeholders):

```sh
chat_id=$(band chats list "$ws_id" --output json | jq -r '.chats[0].id')
```

If `chat_id` comes back as `null` or empty (rare race — the chat hasn't registered yet), retry once after a brief pause. If it still doesn't resolve, fall back to the cwd-auto-resolved form: `band chats watch` run from inside `$ws_path` picks the first chat pane automatically.

### 8. Report the result

Print a one-line summary that includes:

- The branch name and the **worktree path** (`$ws_path`).
- The **fully-substituted watch command** the user can copy to a new shell — e.g. literal `band chats watch chat_8f2a1`, not `band chats watch <chat-id>`. Substitute the real `chat_id` from step 7.

Do **not** invoke `band chats watch` yourself — the command streams indefinitely until the agent finishes, which would block this session. Just print the resolved command and let the user run it in their own shell when they're ready.

If the user wants only the agent's textual deltas instead of raw NDJSON, see the `band-chat` skill for `jq` filter recipes.

## Examples

### Jira ticket (feature)

User input: `Start working on ABCD-1234 to add labels to the chat messages`

1. Detect Jira ticket `ABCD-1234`.
2. Fetch context: `acli jira workitem view ABCD-1234 --fields summary,description`.
3. Classify: adding labels → new functionality → `feat/`.
4. Branch: `feat/abcd-1234-add-labels`.
5. Compose prompt: user input + Jira summary/description.
6. Create the workspace and resolve the chat ID:

   ```sh
   ws_path=$(band workspaces create my-app feat/abcd-1234-add-labels \
     --prompt "Add labels to the chat messages.

   Jira ticket ABCD-1234: <summary>
   <description>" \
     --output json | jq -r .path)

   ws_id=$(band workspaces list --output json \
     | jq -r --arg path "$ws_path" '.workspaces[] | select(.path == $path) | .workspaceId')

   chat_id=$(band chats list "$ws_id" --output json | jq -r '.chats[0].id')
   ```

7. Report — the printed watch command must use the **resolved** `chat_id`, e.g. literal `band chats watch chat_8f2a1`. Do not invoke `band chats watch` yourself; just give the user the copy-pasteable command.

### GitHub issue (bug fix)

User input: `Kick off #42 — the login button redirects in a loop`

1. Detect GitHub issue `#42`.
2. Fetch context: `gh issue view 42 --repo owner/repo`.
3. Classify: broken behavior → `fix/`.
4. Branch: `fix/42-login-redirect`.
5. Compose prompt: user input + GitHub issue body.
6. Create the workspace and resolve the chat ID:

   ```sh
   ws_path=$(band workspaces create my-app fix/42-login-redirect \
     --prompt "The login button redirects in a loop.

   GitHub issue #42: <title>
   <body>" \
     --output json | jq -r .path)

   ws_id=$(band workspaces list --output json \
     | jq -r --arg path "$ws_path" '.workspaces[] | select(.path == $path) | .workspaceId')

   chat_id=$(band chats list "$ws_id" --output json | jq -r '.chats[0].id')
   ```

7. Print the watch command with the **resolved** chat ID (e.g. literal `band chats watch chat_8f2a1`) for the user to run in their own shell.

### No ticket reference (maintenance)

User input: `Spin up a workspace to bump all the dependencies and refresh the lockfile`

1. No ticket pattern matches → skip step 3.
2. Classify: not user-visible, not a bug → `chore/`.
3. Branch: `chore/bump-deps`.
4. Create the workspace and resolve the chat ID:

   ```sh
   ws_path=$(band workspaces create my-app chore/bump-deps \
     --prompt "Spin up a workspace to bump all the dependencies and refresh the lockfile" \
     --output json | jq -r .path)

   ws_id=$(band workspaces list --output json \
     | jq -r --arg path "$ws_path" '.workspaces[] | select(.path == $path) | .workspaceId')

   chat_id=$(band chats list "$ws_id" --output json | jq -r '.chats[0].id')
   ```

5. Print the watch command with the **resolved** chat ID (e.g. literal `band chats watch chat_8f2a1`) for the user to run in their own shell.

## Invariants

- **Always pass `--prompt`** on `workspaces create` so the agent starts in one step. Never create-then-send as two CLI calls.
- Branch names start with a Conventional Commits prefix (`feat/`, `fix/`, or `chore/`), then are lowercase kebab-case, optionally including a Jira key (`abcd-1234-`) or GitHub issue number (`42-`).
- When the work doesn't clearly fit `feat/` or `fix/`, default to `chore/`. Never omit the prefix.
- Skip ticket fetching when the relevant CLI (`acli`, `gh`) is missing or the lookup fails — the kickoff should still succeed.
- `workspaces create` is idempotent — re-running with the same project/branch returns the existing worktree path.
- **Always resolve the chat ID and print `band chats watch <resolved-id>`** as the final step. The printed copy-paste command must contain the literal resolved ID (e.g. `band chats watch chat_8f2a1`), never a `<chat-id>` placeholder. Do not invoke `band chats watch` yourself — it streams indefinitely and would block the session.
- `workspaces create` returns `{"path": "..."}` only — there is no `id` field. The workspace ID is `workspaceId` in `band workspaces list --output json`, looked up by matching `path`.

## Cross-references

- For sending follow-up messages to the agent after kickoff, see **`band-chat`** (`band chats send`).
- For recurring or follow-up scheduled prompts against the same workspace, see **`band-loop`**.
- For workspace cleanup (`band workspaces remove`), project management (`band projects add/remove`), and tunnel control, see **`band`**.

## Configuration

See the `band` skill for environment variables (`BAND_SERVER_URL`, `BAND_TOKEN`, `BAND_OUTPUT`, `BAND_HOME`).
