---
title: Agent skills
description: The seven skills Band installs so coding agents can drive Band through its CLI, where they go and how to reinstall them.
section: automation
order: 30
---

Band ships skills that teach a coding agent how to use the `band` CLI. With them an agent can create a worktree, message another chat, open a terminal or browser tab, schedule a prompt or wait for a pull request review. Each skill is one `SKILL.md` file that the CLI carries inside its binary.

## The seven skills

| Skill | What it covers |
| --- | --- |
| `band` | Worktrees, repos, agents, cronjobs, tunnel, settings and notifications. |
| `band-chat` | Sending messages to chats, streaming their output, and creating, stopping, labelling and removing chat panes. |
| `band-terminal` | Creating terminals, sending them input, reading their output and killing them. |
| `band-browser` | Creating, navigating, inspecting and removing browser tabs in a worktree. |
| `band-start` | Starting work: create a worktree for a task and send the first prompt, with Jira and GitHub ticket detection and a generated branch name. |
| `band-loop` | Repeating a prompt on a schedule through a cronjob, with an optional stop condition. See [Cronjobs](cronjobs.md). |
| `band-subscribe` | Waiting for a PR review, CI result, webhook or timer without polling. See [Subscriptions](subscriptions.md). |

## Where they are installed

`band skills install` writes each skill once to `~/.agents/skills/<name>/SKILL.md`. It then links that folder into the skills folder of each coding agent it finds on the machine.

| Agent | Detected when this folder exists | Link goes in |
| --- | --- | --- |
| Claude Code | `~/.claude/` | `~/.claude/skills/` |
| Codex | `~/.codex/` (or `$CODEX_HOME`) | `~/.codex/skills/` |
| Gemini CLI | `~/.gemini/` | `~/.gemini/skills/` |
| OpenCode | `~/.config/opencode/` | `~/.config/opencode/skills/` |

Cursor CLI gets no link, because Cursor has no documented skills folder for a user. A link is a symlink with an absolute target, so editing a file in `~/.agents/skills/` changes it for every agent at once.

The command is safe to repeat. It rewrites a skill whose content changed, leaves a correct link alone and reports a conflict instead of overwriting a real folder or a link that points somewhere else. Remove the conflicting path yourself and run the command again.

## When it runs

You rarely need to run it. The hub runs `band skills install` on every start, and each worker runs it when it starts, using the `band` CLI that ships with the worker. The skills exist on every machine where an agent runs, and an upgrade refreshes them.

Run it yourself to refresh the skills without restarting, or on a machine that has the CLI but no hub or worker.

```sh
band skills install
band skills install --filter chat
band skills install --home /tmp/test-home
```

`--filter <text>` installs only the skills whose name contains the text, so `--filter chat` installs `band-chat`. `--home <path>` installs under another home folder, which is useful for a test. Add `--output json` for a machine-readable result that lists what was written, updated, linked and in conflict.

## Using them

Agents pick a skill by its description, so you do not call one by hand. Ask an agent to "create a worktree for issue 42 and start on it" and it reads `band-start`. Ask it to "check on the deploy every 10 minutes" and it reads `band-loop`.

Agents running on a worker reach the hub through the worker's relay, which limits what they can do. See [Trust levels and agent access](agent-host-access.md).
