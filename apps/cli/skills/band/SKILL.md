---
name: band
version: 0.1.0
description: Programmatic worktree management for Band. Use when the user wants to create, list, or remove Band worktrees or repos, start a coding agent in a worktree or list its agent sessions, manage tunnels, manage cronjobs, or check settings via the Band CLI. Triggers include "create worktree", "list repos", "band worktree", "band repo", "start an agent", "list agent sessions", "schedule a job". For sending chat messages to coding agents, see the `band-chat` skill.
allowed-tools: Bash
argument-hint: "[command] [args...]"
---

# Band CLI

Thin client for the Band web server. All state, git operations, and script execution happen server-side.

This skill covers **core worktree, repo, agent, cronjob, and tunnel** management. For domain-specific commands, see the sibling skills:

- **`band-chat`** — chat panes (`band chats list/create/send/watch/stop/remove/label/unlabel`)
- **`band-terminal`** — terminal sessions (`band terminals list/create/send/output/kill/attach`)
- **`band-browser`** — browser tabs (`band browsers list/create/navigate/get/remove`)

## Prerequisites

The Band server must be running (started by the Band dashboard app). Connects to `http://localhost:3456` by default.

## JSON Output

All commands support `--output json` (or `BAND_OUTPUT=json` env var) for structured output.

- **Success**: JSON object to stdout, exit code 0
- **Error**: `{"error": "message"}` to stderr, exit code 1

## Schema Introspection

```sh
# List all commands with parameters and types
band schema

# Show a specific command's schema
band schema "worktrees create"
```

## Commands

### List registered repos

```sh
band repos list
```

Text output is a table with the columns `NAME`, `PATH`, `WORKTREES`, `KIND`, `URL` and `CLONES`. `URL` is the remote the repo is identified by (`-` for a plain folder or a repo with no remote). `CLONES` lists `worker:folder` for each worker that holds the repo. `PATH` is the folder on the hub's own machine and is empty when the hub holds no checkout.
JSON output: `{"repos": [{"name": "...", "path": "...", "kind": "git", "worktreeCount": N, "remoteUrl": "..." | null, "clones": [{"hostId": "...", "path": "..."}]}]}`

### Register an existing repository as a repo

```sh
band repos add <path>
band repos add --url <url> [--branch <branch>]
band repos add --from <worker> <path> [--add-root]
```

A repo is identified by its remote URL and default branch. The hub keeps no path of its own for a repo, and each worker maps the URL to a folder.

- `<path>` registers a git repository on the hub's machine and reads its `origin` URL and default branch. Returns the repo name.
- `--url` registers a repo by its remote URL. A worker clones it to `~/band/repos/<owner>/<name>` the first time a worktree for it lands there. Without `--branch` the hub asks the remote for its default branch.
- `--from <worker> <path>` registers the repo that a folder on a worker holds (worker ids are in `band workers list`). The worker keeps that folder as its mapping for the URL, so it does not clone the repo again. A folder outside the worker's roots is refused with a message starting `OUTSIDE_ROOTS:`. Repeat the command with `--add-root` to serve that folder from the worker. This needs an admin token.

A folder with no remote is registered without a URL and can only run on the worker that holds it.

### Change a repo's settings

```sh
band repos set <name> --workers mac,contabo|all --primary mac
band repos set <name> --checkpoints on|off|default
```

`--checkpoints` sets whether the hub keeps checkpoints of the repo's worktrees on workers. `default` is on for a repo available on every worker and off for one limited with `--workers`. Needs an admin token. `band repos list` shows the effective value in the `CHECKPOINTS` column.

`--workers` limits the repo to those workers (ids or names from `band workers list`, or `all`). It is a hard rule: a worktree, clone or placement on another worker fails with `<repo> is only available on <workers>`, whether it comes from the CLI, the UI, the `worktrees_create` MCP tool or automatic placement. `--primary` names the worker that lists the repo's default-branch worktree (`auto` lets the hub pick). A branch has a Band worktree on one worker only: creating it on a second worker fails with `<branch> is already on <worker>` and the existing worktree id. Both flags need an admin token.

### Unregister a repo

```sh
band repos remove <name>
```

Removes the repo from Band's registry (does not delete the repository).

An agent running on a worker may use `repos add`, `repos set` and `repos remove` like a person. The only refusal is a repo limited to workers that do not include the agent's own worker (`band repos set <name> --workers ...`), and adding a repo limited to workers that exclude the worker its folder is on.

### List worktrees, optionally filtered by repo

```sh
band worktrees list [repo]
```

Text output is a table whose last column, `ORIGIN`, is the worktree this one was started from (`-` for top-level work, `<id> (removed)` when that worktree is gone).
JSON output: `{"worktrees": [{"repo": "...", "branch": "...", "worktreeId": "...", "path": "...", "origin": {"worktreeId": "...", "chatId": "...", "removed": false} | null, "groupId": "<group id>" | null, "children": ["<worktree id>"]}]}`

### Create a new worktree (git worktree + state registration)

```sh
band worktrees create <repo> <branch> [--base <string>] [--prompt <string>] [--mode <string>] [--model <string>] [--agent <string>] [--via <string>] [--labels <k=v,...>] [--requires <k=constraint>...] [--any-worker] [--isolation worktree|container|vm] [--worker-repo-path <string>] [--worker <worker>] [--origin <worktree id> | --no-origin] [--group <id|name>]
```

Returns the worktree path and the dispatch target. Idempotent — creating an existing worktree returns its path. Runs `.band/config.json` `setup` script if present (non-fatal).

**Origin.** A worktree records the worktree it was started from. Inside a Band chat or terminal the new worktree's origin is the current one (`$BAND_WORKTREE_ID`), and on a worker the hub also records the chat or terminal. `--origin <worktree id>` names another parent. `--no-origin` records none. A chat can do the same through the `worktrees_create` tool of its built-in `band` MCP server.

**Group.** A worktree is in at most one group. `--group <id or name>` puts the new worktree in that group (a name matches without regard to case). Without it the worktree joins its origin's group, if the origin has one. An unknown group fails the command before anything is created.

**Always use `--prompt` when the user wants work to begin immediately.** This submits a task to the coding agent right after worktree creation, so the agent starts working without a separate step. Only omit `--prompt` when the user explicitly wants to create the worktree for manual/later use.

**Dispatch target (`--via`, issue #551).** With `--prompt`, the prompt is dispatched to either:
- `terminal` (CLI default) — spawns the vendor CLI in a fresh terminal pane with the prompt as the first positional argument (cmux-style: `claude "<prompt>"`, `codex "<prompt>"`, …). Returns a `terminalId` in the JSON output.
- `chat` — submits a streaming task to the worktree's chat pane (the web UI default).

Precedence, highest first: `--via` flag → `BAND_DISPATCH` env var → `.band/config.json` `workspace.defaultVia` → `~/.band/settings.json` `cli.defaultVia` → `terminal`.

When to use `--prompt` (most cases):
```sh
# User says "create a worktree and implement X" or "start working on X"
band worktrees create my-app feat/auth --prompt "Implement GitHub issue #42: Add JWT authentication"

# User says "create a worktree for issue #99 and start implementing"
band worktrees create my-app fix/bug-99 --prompt "Fix issue #99: login redirect loop. See https://github.com/org/repo/issues/99"

# Force chat dispatch when terminal is the user-level default
band worktrees create my-app feat/auth --prompt "..." --via chat
```

When to omit `--prompt` (rare — user explicitly wants no task):
```sh
# User says "just create a worktree, I'll work on it myself"
band worktrees create my-app feat/experiment
```

**Another worker (`--worker`).** `--worker <id or name>` creates the worktree on that worker (ids and names are in `band workers list`). An agent on a worker may do this when the hub setting "Agents may start worktrees on other workers" is on, the worker is an online static worker and the repo allows it; the new worktree records the caller's worktree and chat as its origin. A refusal names the reason. It cannot be combined with `--labels`, `--requires`, `--any-worker` or `--isolation`, and without it the worktree is created where the caller runs.

**Placement (`--labels`, `--requires`, `--any-worker`, `--isolation`).** These pick the worker by criteria instead of by id. `--labels zone=home,gpu=a100` needs an online worker carrying every label. `--requires node=>=24 --requires os=linux` needs worker facts (`node`, `git`, `os`, `arch`). The hub uses the least loaded worker that fits. When none fits, the command prints `provisioning (worker request <id>)` and the JSON output has `provisioning.requestId`: the worktree appears once a runner starts a matching worker, or fails with a reason after `BAND_PLACEMENT_TIMEOUT_MS` (10 minutes by default). `--isolation container` or `vm` asks for a worker of its own for that worktree, started by a runner that offers the level (`worktree`, the default, may share a worker). With no such runner configured the command fails at once with `No runner offers isolation <level>`. `--worker-repo-path` says where the repository is on the chosen worker the first time the repo is used there.

**Do NOT create a worktree without `--prompt` and then separately run `band chat`.** That is two steps for what `--prompt` does in one.

### Checkpoints, move and restore

```sh
band worktrees checkpoints <id> [--take]
band worktrees move <id> --to <worker> [--add-worker]
band worktrees restore <id> --to <worker> [--checkpoint <checkpointId>] [--add-worker]
```

The hub keeps recent checkpoints of worktrees on workers: uncommitted and untracked changes plus the agent session. Ignored files and running processes are not included. `checkpoints` lists them (`--take` makes one now). `move` works while the worktree's worker is online: it takes a fresh checkpoint, restores it on the target and removes the source only after the target has the same files. `restore` works when the worker is offline and leaves the old copy on disk, listed as superseded in `band worktrees list`; remove it with `band worktrees remove`. A target the repo is not allowed on is refused unless `--add-worker` is given (admin token). `<id>` is the worktree id from `band worktrees list`; `--to` takes a worker id or name.

### Continue on another worker when a worker is offline

```sh
band worktrees continue <id> [--to <worker>]
band repos set <repo> --auto-continue on|off
```

When the worker of a worktree is offline, the hub can continue the work on another worker the repo may run on, from its latest checkpoint: the branch, uncommitted and untracked files, the agent sessions and the chats. The repo's setup runs on the new copy. `continue` does it on request (the hub picks the target unless `--to` names one). A chat message, a new terminal or an agent launch for such a worktree is refused with the same offer, unless the repo has `--auto-continue on` and the checkpoint is younger than 30 minutes (`BAND_AUTO_CONTINUE_MAX_AGE_MS`), in which case it continues by itself. Reading the worktree (changes, files, chat history) never triggers it. The command fails with a reason when the worker is online (use `move`), the repo is limited to the offline worker, checkpoints are off, no allowed worker is online or the agent is missing on every other worker. The old copy is never deleted: it is listed as superseded, and when its worker returns the UI flags it diverged if it holds changes the checkpoint lacks. Ignored files and running processes are not carried over.

### Set or remove a worktree's parent

```sh
band worktrees set-origin <repo> <name> [--worker <worker>] (--origin <worktree id> | --none)
```

The parent is the worktree this one was started from. The sidebar shows it in Group by: Origin. `--origin` sets a parent by hand (no chat or terminal is recorded), `--none` removes it. The hub refuses the worktree itself and any of its descendants as the parent, and an unknown worktree id.

### Rename a worktree

```sh
band worktrees rename <worktree id> "<title>"
band worktrees rename <worktree id> --clear
```

Sets the title the sidebar shows in place of the worktree's name (at most 100 characters), or clears it with `--clear`. The worktree id, folder and git branch do not change. `band worktrees list` shows a TITLE column, and `--output json` has a `title` field (null when unset). An agent may run this command for worktrees on its own host.

### Set a worktree's group

```sh
band worktrees set-group <worktree id> <group id|name> [--with-children]
band worktrees set-group <worktree id> --none [--with-children]
```

Moves a worktree into a group, or out of its group with `--none`. `--with-children` also moves every worktree started from it, and theirs in turn, on any repo and host. The command prints each worktree that moved. `band worktrees list --output json` shows each worktree's `groupId` (null when ungrouped). An agent may run this command for worktrees on its own host.

### Mark a worktree unread or read

```sh
band worktrees mark-unread <worktree id>
band worktrees mark-read <worktree id>
```

`mark-unread` shows an unread dot on the worktree in the sidebar on every device. It stays until someone opens the worktree or runs `mark-read`, which also clears a `done` or `failed` status dot. `band worktrees list --output json` shows each worktree's `unread`. These commands are for a person: an agent on a worker gets 403.

### List and manage groups

```sh
band groups list
band groups create <name> [--color <color>]
band groups rename <group id|name> <new name>
band groups remove <group id|name>
```

Groups are the sections of the sidebar. `list` shows each group's id, name and color in sidebar order. `create` prints the new group's id. `remove` deletes the group and leaves its worktrees ungrouped. An agent on a worker may list groups but cannot create, rename or remove them.

### Open a worktree's iOS simulator

```sh
band simulators open [worktree id]
```

Boots the worktree's iOS simulator and opens its Simulator tab for every connected Band client, view-only until a person takes control. The worktree's worker must be a Mac with Xcode. An agent on a worker gets 403: an agent drives the simulator with the `simulator_*` tools (`simulator_describe`, `simulator_tap`, `simulator_type`, `simulator_button`, `simulator_screenshot`, `simulator_open_url`, `simulator_install`, `simulator_launch`).

### Remove a worktree (git worktree + state cleanup)

```sh
band worktrees remove <repo> <name> [--worker <workerId>]
```

`<name>` is the worktree's stable identity — the branch it was created on (unchanged even if the git branch was later switched). `--worker` picks the worker when the same repo and name exist on more than one (ids from `band workers`); without it the local worktree, or the only one of that name, is removed.

Runs the `.band/config.json` `teardown` command in a terminal tab of the worktree first and waits for it (up to 60s; a failure does not stop the removal). Cleans up all associated files.

### Start a coding agent in a worktree

```sh
band agents launch [worktree_id] [--agent <string>] [--mode <string>] [--prompt <string>]
```

Starts an agent session. `--mode gui` opens a chat pane and submits the prompt to the agent. `--mode tui` opens a terminal running the agent's CLI with the prompt pre-loaded (`claude "<prompt>"`, `codex "<prompt>"`, ...). `chat` and `terminal` are accepted as aliases. Mode precedence, highest first: `--mode` → `BAND_DISPATCH` env var (set in every Band terminal and chat agent, so an agent starts new agents the way it runs itself) → `.band/config.json` `workspace.defaultVia` → the server's `agents.defaultMode` setting (Settings > Coding Agents > "Open programmatically created agents in"). `--agent` picks a coding agent ID from settings; the default agent is used when omitted. The worktree is auto-detected from the cwd when `worktree_id` is omitted.

An agent with no terminal mode (Cursor CLI) starts as a chat, and the output carries a notice.

Text output: `<mode>\t<chat or terminal ID>`, plus a `note:` line after a fallback.
JSON output: `{"agentSession": {...}, "mode": "gui" | "tui", "chatId": "...", "terminalId": "...", "notice": "..."}`. `chatId` is set for gui, `terminalId` for tui, `notice` only after a fallback.

```sh
# Start the default agent in the cwd's worktree, in the server's default mode
band agents launch --prompt "Fix the failing test in auth.test.ts"

# Start Codex in a terminal
band agents launch my-app-feat-auth --agent codex --mode tui --prompt "Review the diff"
```

To start an agent in a new worktree, use `band worktrees create --prompt` instead.

### List the running agent sessions of a worktree

```sh
band agents list [worktree_id]
```

An agent session is one run of a coding agent, in a chat (`gui`) or in a terminal (`tui`). A session keeps its mode for its whole life. Ended sessions are not listed.

Text output: `SESSION ID\tAGENT\tMODE\tSTATE\tPANE\tPROVIDER SESSION` (tab-separated table). PANE is the chat ID for gui sessions and the terminal ID for tui sessions; PROVIDER SESSION is the agent's own session ID once it is known.
JSON output: `{"agentSessions": [{"id": "...", "worktreeId": "...", "agentDefinitionId": "...", "providerSessionId": "..." | null, "mode": "gui" | "tui", "chatId": "..." | null, "terminalId": "..." | null, "state": "starting" | "running", "createdAt": N, "updatedAt": N}]}`

### Show current settings

```sh
band settings
```

Pretty-prints the current settings as JSON. With `--output json`, outputs compact JSON.

### Show versions

```sh
band --version
band version
```

`band --version` prints the CLI version and needs no hub. `band version` prints `CLI: <version>` and `Hub: <version>`, or `Hub: unreachable` when the hub does not answer. With `--output json` it prints `{"cli": "...", "hub": "..." | null}`.

### Show tunnel status

```sh
band tunnel status
```

Shows whether the tunnel is running and its URL.

### Start the remote tunnel

```sh
band tunnel start
```

Starts the remote tunnel. Returns the tunnel URL.

### Stop the remote tunnel

```sh
band tunnel stop
```

Stops the remote tunnel.

### List the workers worktrees can run on

```sh
band workers list
```

Shows each worker's id, name, status (`online`, `offline`, `lost`, `disposed`), trust level (`restricted`, `standard`, `admin`), Band version, labels, agents, roots and last contact. The version is followed by `(behind)` when the worker runs an older Band than the hub, `(update)` when it never reported one, and `(update required)` when the hub refused its link for being more than one minor version away. The local worker is always listed. With `--output json` it is `{"hosts": [...]}`, and each worker also carries `capabilities`, `home`, `workerVersion`, `versionState` (`current`, `behind`, `ahead`, `unknown` or `refused`) and `updateTarget`. Updating a worker is a click on Settings > Workers, or `npm i -g @band-app/worker@<version>` on the worker. An agent on a worker gets a shorter view: id, name, status, mode, OS, architecture, agents, capabilities and labels, with no roots or home.

### Set a worker's trust level

```sh
band workers trust <worker> restricted|standard|admin
```

Sets how far the agents on a worker reach through the relay. `restricted` keeps them to their own worktrees (no worktree creation, repo changes or cronjobs). `standard` is the default for a static worker: its own worker, plus worktrees on other workers when Settings > Agents allows it. `admin` lets them work on any worker (chats, terminals, worktrees, cronjobs), change hub settings and manage repos; tokens, the vault and trust levels stay out of every agent's reach. A runner-started or ephemeral worker starts at `restricted`. Needs a person's admin token, never an agent's.

### Set the command an agent runs as on a worker

```sh
band workers set-agent-command <worker> <agentId> <command>
band workers set-agent-command <worker> <agentId> --clear
```

Replaces the agent's global command on one worker, for chats, terminal sessions, cronjobs and usage readers. `<command>` is a binary name or an absolute path with no arguments (put arguments in a wrapper script). `--clear` goes back to the global command. `band workers list --output json` returns `agentCommands` and, per agent, `agentCommandStates` with `effective` and `found` (false when the worker has no such binary on its PATH). Needs a person's admin token, never an agent's.

### Show what admin workers did

```sh
band workers audit [--limit <n>]
```

Lists the newest cross-worker and admin-only calls agents made: when, the calling worker, the call and the target worker and worktree. Needs an admin token.

### Move every worktree off a worker

```sh
band workers evacuate <worker> --to <worker> [--add-worker]
```

Moves the worker's worktrees to another worker one after the other and prints one line per worktree. An online worker moves them (fresh checkpoint, target confirms, source removed). An offline worker restores them from their last checkpoints and leaves its copies superseded. The exit code is non-zero if any worktree failed. Needs an admin token. `--add-worker` adds the target to the allowed workers of repos that lack it.

### Remove a worker

```sh
band workers remove <id>
```

Removes an offline worker that has no worktrees and revokes its tokens, so the worker cannot dial in again. Needs an admin token. The local worker, an online or lost worker, and a worker with worktrees are refused.

### List the runners and read their logs

```sh
band runners list
band runners log <request-id>
```

A runner is a pair of scripts the hub runs to start a worker when `band worktrees create --labels ...` finds no worker. `list` shows each runner's id, spawn script, labels, running count against its limit and timeout, and any entry of `runners` in `settings.json` that the hub skips as invalid. `log` prints what the hooks printed for one worker request (the id comes from the provisioning result), with tokens removed. Runners are set up in `settings.json`; see `docs/runner-hooks.md` in the Band repository.

### Validate a repository's environment file

```sh
band env validate [path]
```

Checks `.band/environment.json` in the repository at `path` (default: the current directory), or the file itself. The path must exist on the hub's machine. Prints `OK <file>` and exits 0, or prints each problem with its key path and exits 1. With `--output json` it prints the parsed environment and the issues. Needs an admin token.

### Build a repo's environment image

```sh
band env build <repo> [--force] [--no-wait]
band env status <repo>
```

Builds the image for the repo's `.band/environment.json` at the default branch: the worker base, the toolchain from `build`, then the result of `install`. An image for the same key (environment file, what it references, lockfiles, worker base) is reused and reported as a cache hit. `build` follows the log and exits 0 for a ready image or a cache hit, 1 for a failed build. `--no-wait` returns once the build has started. `status` prints the current image (the newest ready build; a failed build never replaces it) and the latest build with its log. The hub builds on its builder worker (settings `environmentBuilder.hostId`, default the hub's machine). `build` needs an admin token.

### List, create and revoke the hub's tokens

```sh
band tokens list
band tokens create-device [--label <string>] [--admin]
band tokens revoke <id>
```

`list` shows each token's id, kind, label, state and last use, never its secret. `create-device` prints a new device token once, for a UI or script. Add `--admin` only for a token that must manage tokens too; without it the token gets 403 on `band tokens`. These commands need an admin token, which the shared token in `settings.json` is. `revoke` stops a token from authenticating. The shared token in `settings.json` cannot be revoked. These commands change who can reach the hub, so run them only when the user asks.

### Proxy an MCP server through the hub

```sh
band mcp list
band mcp add <name> <url> [--vault-item <id>] [--header <name>] [--prefix <text>] [--allow-tools a,b] [--read-only] [--read-only-tools a,b] [--disabled]
band mcp remove <name>
```

The hub proxies HTTP MCP servers at `/mcp-proxy/<name>` and adds the credential from the vault, so an agent never holds it. Each agent session gets its own short-lived token for the servers it may use. `--allow-tools` limits the tools an agent sees and can call. `--read-only` keeps only tools the server marks `readOnlyHint` plus those named in `--read-only-tools`. An API key goes in `--header` (default `Authorization`) after `--prefix` (default `Bearer `). An OAuth connection from Settings > Credentials always goes as a Bearer token. These commands need an admin token. Run them only when the user asks.

### Store credentials in the hub's vault

```sh
band vault list
printf '%s' "$VALUE" | band vault put <name> [--kind api_key|env|git] [--scope global|repo:<name>] [--description <string>]
printf '%s' "$TOKEN" | band vault put <name> --kind git --host github.com --path 'owner/*' [--username <name>]
band vault delete <id>
band vault rotate-key
```

The hub keeps credentials encrypted and never shows a value again: `list` prints id, name, kind, scope and last use. `put` reads the value from stdin (`--value` also works, but shows in the process list). A `git` item is an access token for private repositories on workers: workers ask the hub for it per remote, and `--path` is a pattern over `owner/repo` (`*` stays inside one segment). OAuth connections are made in Settings > Credentials, and `delete` revokes one at its server. These commands need an admin token. Run them only when the user asks, and never print or log a value.

### List cronjobs, optionally filtered by worktree

```sh
band cronjobs list [--worktree <string>]
```

The table shows each job's worktree, agent and session. A job the hub could not move to a worktree at upgrade shows as disabled with its reason in `lastRunMessage` (`--output json`).

### Create a new scheduled cronjob in a worktree

```sh
band cronjobs create --worktree <string> --name <string> --prompt <string> --cron <string> [--agent <string>] [--session-id <string>] [--via <string>] [--disabled]
```

Every job belongs to one worktree: the default-branch worktree for a repo's main, or any other. `--repo` and `--scope` are gone and fail with a message saying so. `--agent` is a coding agent id from settings (the default agent when omitted). `--session-id` is the agent's own session id. Each fire sends the prompt to the chat in that worktree whose active session is that id, or, when no chat has it, opens a new chat on that session (`session/resume` or `session/load`) and sends it there. A session the agent cannot open fails the run (`lastRunStatus` `failed`, the reason in `lastRunMessage`) and no fresh session starts. A chat that is mid-turn queues the prompt behind the running turn. `--session-id` works with `--via chat` only.

`--via` picks where each fire dispatches the prompt: `chat` (submits a task to the cronjob's dedicated chat pane — the default and backward-compatible behavior) or `terminal` (spawns the agent's vendor CLI in a fresh self-closing PTY pane; if the agent has no vendor CLI it silently falls back to chat). When omitted it resolves via the same precedence as `worktrees create`: `--via` flag → `BAND_DISPATCH` env → `.band/config.json` `workspace.defaultVia` → `~/.band/settings.json` `cli.defaultVia` → `terminal`. A terminal fire is skipped (recorded `skipped`) when the previous run's pane is still active, so an agent that runs longer than the interval is never interrupted.

### Update an existing cronjob

```sh
band cronjobs update <key> <id> [--name <string>] [--prompt <string>] [--cron <string>] [--worktree <string>] [--agent <string>] [--session-id <string>] [--clear-session] [--enable] [--disable]
```

`<key>` is the id of the worktree the job belongs to. `--worktree` moves the job to another worktree.

### Delete a cronjob

```sh
band cronjobs delete <key> <id>
```

### Manually trigger a cronjob now

```sh
band cronjobs trigger <key> <id>
```

### Open a file in the active Band worktree's editor pane

```sh
band open <file_path> [--worktree <string>] [--no-focus]
```

Opens the file in the dashboard's currently focused worktree. When `--worktree` is omitted, the server uses the worktree most recently focused in the Band dashboard — exits non-zero if no worktree is active. Relative paths are resolved against the current working directory. Paths inside the worktree open as normal editor tabs; paths outside any worktree root open as external tabs (same surface as desktop Cmd+O / "Open File…"). Line/column suffixes (`src/main.rs:42:5`, `src/main.rs:5-10`) are supported and dropped into the editor's cursor position.

Example:
```sh
# Open the file in whichever worktree the dashboard is currently focused on
band open src/main.rs

# Jump to line 42, column 5
band open src/main.rs:42:5

# Override the active-worktree fallback
band open src/main.rs --worktree my-app/feat/auth

# An out-of-worktree file opens as an external tab (worktree-relative
# routing is bypassed; the FileViewer reads via the server's
# readExternalFile capability).
band open ~/Downloads/v3.js
```

### Receive coding-agent hook notifications (reads JSON from stdin)

```sh
band notify [--agent <type>]
```

Not called directly — registered as a coding-agent hook by the Band dashboard (`band notify --agent claude-code`). Forwards the raw payload, plus `BAND_DISPATCH` and `BAND_TERMINAL_ID` from the environment, to the server, which reads it with the sending agent's rules to derive that agent session's status.

### Show command schemas as JSON

```sh
band schema [command]
```

### Install (or refresh) skills into ~/.agents/skills and symlink each detected coding agent's skills/ folder

```sh
band skills install [--home <string>] [--filter <string>]
```

Idempotent: leaves a correct existing symlink alone; surfaces a clear conflict (without overwriting) when a different symlink or a real directory occupies the target path. Supported agents: claude-code, codex, gemini-cli, opencode. cursor-cli is excluded (no skills dir).

## Workflows

### Feature branch workflow

```sh
# Create worktree, get path
path=$(band worktrees create my-app feat/login --output json | jq -r .path)
cd "$path"

# ... do work ...

# Clean up
band worktrees remove my-app feat/login
```

### Agent task submission

```sh
band worktrees create my-app feat/auth --prompt "Add JWT authentication to the API"
```

### Enumerate worktrees

```sh
band worktrees list --output json | jq '.worktrees[] | select(.repo == "my-app") | .branch'
```

### Open a file in the dashboard

`band open <file>` routes a file to whichever worktree is currently
focused in the Band dashboard (the most recently active one). Use it
from grep / stack-trace output to drop yourself straight into the
editor without naming the worktree.

```sh
# Open the file in whichever worktree the dashboard is currently focused on
band open src/main.rs

# Jump to line 42, column 5
band open src/main.rs:42:5

# Override the active-worktree fallback
band open src/main.rs --worktree my-app/feat/auth

# Open an arbitrary file from outside any worktree — opens as an
# external editor tab (the same surface as desktop Cmd+O / "Open File…")
band open ~/Downloads/v3.js
```

Files inside the target worktree open as normal editor tabs.
Files outside any worktree root open as external tabs, hosted in
the active worktree's editor pane. Errors when no worktree is
active in the dashboard and no `--worktree` is supplied, or when
the file doesn't exist on disk.

### Drive a coding agent

To send a message to a worktree's chat (the primary way to drive the
coding agent), use `band chats send` — see the **`band-chat`** skill. Task
lifecycle (status, cancel, re-run) is managed inside the dashboard
rather than from the CLI.

### Repo management

```sh
# Register a repo
band repos add /Users/me/code/my-app

# Register a repo by URL, or from a folder on a worker
band repos add --url https://github.com/acme/my-app --branch main
band repos add --from w-1a2b3c4d5e6f /home/me/code/my-app

# List all repos
band repos list

# Build a repo on one machine only
band repos set atlas --workers mac --primary mac

# Remove a repo
band repos remove my-app
```

## Invariants

- The CLI never modifies files directly — all operations go through the server API
- `worktrees create` is idempotent — creating an existing worktree returns its path
- `setup` runs in its own terminal tab after worktree creation, in parallel with the `--prompt` dispatch (the agent does not wait for it). `teardown` runs in a terminal tab before removal, and removal waits for it. Both are non-fatal
- Worktree file copying runs after `git worktree add` and before the `setup` script — see "Worktree file copying" below
- Repo and branch names must not contain control characters or path traversals (`../`)
- Exit code 0 = success, 1 = error

## Worktree file copying

Worktrees are fresh git worktrees, so untracked files (`.env`, `.env.local`,
local credentials, IDE overrides) are missing by default. Band can copy a
declared set of those files from the repo's main checkout into each new
worktree, driven by either of two sources at the repo root:

**Option A — `.band/config.json::workspace.copyFiles`** (explicit list,
supports globs):

```json
{
  "workspace": {
    "copyFiles": [".env", ".env.local", "config/*.local.json", ".vscode/settings.json"]
  }
}
```

**Option B — `.worktreeinclude`** (gitignore-syntax, Claude Code parity):

```
.env*
config/*.local.json
```

Only entries that match a `.worktreeinclude` pattern AND are gitignored are
copied. Tracked files are never duplicated.

When both sources are present, the resulting file sets are UNIONed and
de-duped by absolute source path. Missing source files are skipped with a
warning (not fatal). Files are copied (not symlinked) so edits in the
worktree don't bleed back to the main checkout. Out of scope: per-user
overrides, copy-back on cleanup, variable substitution.

## Configuration

| Setting          | Env var           | Default                      |
| ---------------- | ----------------- | ---------------------------- |
| Server URL       | `BAND_SERVER_URL` | `http://localhost:3456`      |
| Auth token       | `BAND_TOKEN`      | from `~/.band/settings.json` |
| Output format    | `BAND_OUTPUT`     | `text`                       |
| Band home dir    | `BAND_HOME`       | `~/.band`                    |
| Dispatch target  | `BAND_DISPATCH`   | `terminal` (from CLI)        |

### `worktrees create --prompt` dispatch target (issue #551)

By default the CLI dispatches the `--prompt` value to a fresh **terminal**
pane running the vendor coding agent CLI (cmux-style: `claude "<prompt>"`,
`codex "<prompt>"`, `opencode "<prompt>"`, `gemini "<prompt>"`). The web
UI keeps its existing **chat** pane behavior.

Override precedence (highest first):

1. `--via {chat,terminal}` flag.
2. `BAND_DISPATCH` env var.
3. `.band/config.json` per-repo: `{"workspace": {"defaultVia": "chat"}}`.
4. `~/.band/settings.json` per-user: `{"cli": {"defaultVia": "chat"}}`.
5. Built-in CLI default: `terminal`.

When `via=terminal`, the JSON output includes a `terminalId` you can wire
into `band terminals attach <id>` or `band terminals output <id> -f`.
When the chosen coding agent doesn't expose a usable interactive CLI
(`cursor-cli` today), the server falls back to `chat` and the response's
`via` field reflects the actual dispatch.
