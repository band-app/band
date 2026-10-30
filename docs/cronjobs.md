---
title: Cronjobs
description: Run a prompt on a schedule in a worktree, in a chat or a terminal, and read why a run was skipped or failed.
section: automation
order: 10
---

A cronjob sends a prompt to a coding agent on a schedule. When the job fires, Band submits the prompt as if you had typed it in the worktree's chat. Use it for recurring checks such as a morning review of new commits or a periodic test run.

## What a job belongs to

A job belongs to one worktree. For recurring work on a repo's main branch, pick the repo's default-branch worktree. For a long-lived feature branch, pick that branch's worktree. A job never creates a worktree. The worktree must exist when you create the job.

Removing a worktree removes its jobs. Jobs from older versions that were scoped to a whole repo moved to the repo's default-branch worktree at the first start after the upgrade. A job whose repo had no default-branch worktree was disabled, and its last run message says why. `--repo` and `--scope` no longer exist.

## Create a job in the UI

Open the "More actions" menu in the sidebar and choose Cronjobs. Select Create Cronjob and fill in the form.

| Field | Meaning |
| --- | --- |
| Name | A label for the list, such as "Daily dependency check". |
| Prompt | The text sent to the agent. |
| Cron Expression | The schedule. See below. |
| Repo and Worktree | The worktree the job fires into. The default-branch worktree is listed first. |
| Agent | Optional. A coding agent from Settings. "Default agent" uses the default. |
| Session ID (optional) | Optional. Pins the job to one agent session. See below. |
| Enabled | Turns the schedule on or off. |

A repo's page in Settings > Repos also lists the cronjobs in that repo's worktrees, with a link to this dialog.

## Create a job from the CLI

```sh
band cronjobs create \
  --worktree my-app-main \
  --name "Morning review" \
  --prompt "Review the commits from the last 24 hours and list risks." \
  --cron "0 9 * * 1-5"
```

Inside a worktree, `--worktree` can be left out and Band uses the current one. Add `--agent <id>` to pick a coding agent and `--disabled` to create the job switched off. Manage jobs with the other subcommands. The first argument of `update`, `delete` and `trigger` is the id of the worktree the job belongs to.

```sh
band cronjobs list
band cronjobs update my-app-main <id> --cron "0 */4 * * *"
band cronjobs update my-app-main <id> --disable
band cronjobs trigger my-app-main <id>
band cronjobs delete my-app-main <id>
```

`update --worktree <id>` moves a job to another worktree. `trigger` fires the job now, whatever its schedule.

## Schedule syntax

A schedule is a cron expression with five fields: minute, hour, day of month, month and day of week. An optional sixth field for seconds goes first. Band rejects an invalid expression when you save the job.

| Expression | Runs |
| --- | --- |
| `0 9 * * 1-5` | Every weekday at 9:00 |
| `0 */4 * * *` | Every 4 hours |
| `30 8 * * 1` | Every Monday at 8:30 |
| `0 0 1 * *` | At midnight on the first of each month |
| `*/15 * * * *` | Every 15 minutes |

The hub runs the schedule, so the hub must be running when a job is due.

## Where the prompt goes

By default each fire goes to a chat the job keeps for itself, created with the job's agent. With `--via terminal`, the fire runs the agent's CLI once, without a conversation, in a fresh terminal pane that closes when the agent exits. Without `--via`, Band picks the target the same way `band worktrees create` does: `$BAND_DISPATCH`, then `workspace.defaultVia` in [`.band/config.json`](configuration.md), then `cli.defaultVia` in `~/.band/settings.json`, then terminal. An agent with no CLI mode (Cursor CLI) always uses a chat.

A fire that finds the chat in the middle of a turn queues the prompt behind it. A terminal fire is skipped when the previous run's pane is still open, so an agent that runs longer than the interval is not interrupted.

## Pin a job to an agent session

With a session id, every fire goes to the chat in the job's worktree whose active session is that id. If no chat has it, Band opens a new chat on that session and sends the prompt there. The next fire reuses that chat.

```sh
band cronjobs create \
  --worktree my-app-main \
  --name "Check the migration" \
  --prompt "Continue the migration and report what is left." \
  --cron "0 */6 * * *" \
  --session-id <session-id> \
  --via chat
```

If the agent cannot open the session, the run fails with the reason and Band starts no new session in its place. A session id works with chat dispatch only. If the session belongs to a chat that runs a different agent than `--agent`, the command is refused. `band cronjobs update ... --clear-session` removes the pin.

## Run results

Each job records its last run time and status.

| Status | Meaning |
| --- | --- |
| completed | Band sent the prompt or started the terminal. |
| failed | The run could not start. The reason is stored with the job, for example a missing worktree or a session the agent could not open. |
| skipped | A terminal run was already open from the previous fire. |

A failed run does not disable the job. The next fire tries again.

## Related

- [Recipes](recipes.md) for scheduled and event-driven examples.
- [Subscriptions](subscriptions.md) when work should start on an event, not on the clock.
- [Cronjobs CLI reference](/docs/cli-cronjobs).
