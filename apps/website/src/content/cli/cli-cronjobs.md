---
title: band cronjobs
description: Create, change, run and delete scheduled prompts that fire into a worktree.
section: cli
order: 80
commands: [cronjobs]
---

`band cronjobs` manages scheduled prompts. Each fire sends the prompt to a coding agent. See [Cronjobs](cronjobs.md) for the concepts and the UI.

## Concepts

A cronjob belongs to one worktree. Pass it with `--worktree <id>`. For a repo's main branch, use the id of the repo's default-branch worktree. There is no `--repo` or `--scope` option, and `create` fails without `--worktree`.

The job has a name, a prompt and a cron expression such as `0 */6 * * *`. Three options choose who receives the prompt:

- `--agent` names a coding agent by its id in Settings > Coding Agents. Without it, the default agent runs the job.
- `--session-id` pins the job to an agent session. Each fire goes to the chat whose active session is that id, or opens a new chat on that session. It works with chat dispatch only.
- `--via` is `chat` (a chat pane) or `terminal` (the agent's CLI in a fresh terminal that closes itself). Without it, Band uses `$BAND_DISPATCH`, then `workspace.defaultVia` in `.band/config.json`, then `cli.defaultVia` in `~/.band/settings.json`, then `terminal`. A job created from inside a chat therefore dispatches to a chat.

`update`, `delete` and `trigger` take the worktree id and the job id as two positional arguments, in that order. Job ids look like `cj_1234567890`.

## Output

`list` prints a table with the columns ID, NAME, CRON, WORKTREE, AGENT, SESSION, STATE and LAST RUN. `AGENT` and `SESSION` show `-` when unset. `STATE` is `enabled` or `disabled`.

`create` prints the new job id. `update` prints `Cronjob <id> updated`, and `delete` prints `Cronjob <id> deleted`.

`trigger` runs the job now and prints one id. A chat job prints the task id. If the chat was busy, it prints `queued <message id>` instead. A terminal job prints the terminal id.

Add `--output json` to any command for JSON.

## Examples

```sh
band cronjobs create --worktree my-app-main --name nightly-deps --cron "0 3 * * *" --prompt "Check for outdated dependencies and open a PR for safe bumps"
band cronjobs create --worktree my-app-feat-login --agent codex --via chat --name ci-watch --cron "*/10 * * * *" --prompt "Check CI and fix failures"
band cronjobs list --worktree my-app-main
band cronjobs update my-app-main <id> --disable
band cronjobs update my-app-main <id> --clear-session
band cronjobs trigger my-app-main <id>
```

The second example pins nothing, so each fire goes to the job's own chat. Use `--session-id <id>` to send fires to an existing agent session instead.
