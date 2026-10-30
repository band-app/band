---
title: Agent status and notifications
description: What the status dots in the sidebar and tab strip mean, how Band learns what an agent is doing, and how to get a sound when one needs you.
section: using-band
order: 50
---

Every worktree row in the sidebar has a dot that shows what its agents are doing. You can see at a glance which worktree needs an answer, which one finished and which one is still working.

## The six states

| State | Mark | Meaning |
| --- | --- | --- |
| working | Solid yellow dot | An agent is running a turn. |
| monitoring | Pulsing yellow ring | The turn is over, but a loop, a scheduled wake-up or a background task is still running. |
| question | Amber "?" | An agent waits for you: a permission request, a question or a plan to approve. |
| done | Solid green dot | A turn finished. |
| failed | Solid red dot | A turn ended in an error, a refusal or a limit. |
| idle | Faint grey dot | Nothing is running. A turn you stopped also ends as idle. |

A worktree can have several chats and terminals. Its dot shows the most urgent state, in this order: question, failed, working, monitoring, done, idle. Hover the dot to see each chat and terminal with its own state.

Opening a worktree sets done and failed back to idle. A question stays until you answer it.

## Where the marks appear

- The sidebar row of each worktree.
- The tab strip. A chat tab or terminal tab shows its own state, with a spinner while it works. A terminal tab with split panes shows the most urgent state of its panes.
- The worktree picker.

## Unread mark

A dot you have not looked at is "unread". A done or failed dot counts as unread. You can also mark a worktree unread yourself, for example to remind you to come back to it.

- Click the dot in a sidebar row to toggle the mark. The dot's name is "Mark as read" or "Mark as unread".
- The worktree's context menu has the same item.
- `band worktrees mark-unread <id>` and `band worktrees mark-read <id>` do it from the CLI.

A manual mark is shared by every device you use, including the phone. Opening the worktree clears it, except when you marked the worktree you have open. That mark stays until you open another worktree. An agent state shows over the unread dot, so a row never has two dots.

## How Band knows

Chats need no setup. A chat talks to its agent over the Agent Client Protocol, and Band reads the state from the turn: a started turn is working, a permission or form request is a question, and a finished turn is done. Some agents, Claude Code among them, start turns of their own, for example from a scheduled wake-up. Band shows those as working and settles the chat after 10 seconds of silence (`BAND_AGENT_QUIET_MS`).

Terminals have no protocol. When you run Claude Code in a terminal, it reports through hooks that call `band notify`. Chats and other agents in terminals do not use hooks.

### Claude Code hooks

Band never edits `~/.claude/settings.json` on its own. When a worker has Claude Code but no Band hooks, the dashboard shows a banner:

```text
To get notifications from agents running in a terminal, Claude Code hooks need to be installed.
```

Click Install to add the hooks, or the close button to dismiss the banner. Dismissing it is remembered until a newer set of hooks exists.

Settings > Agent hooks lists every worker with its state (Installed, Outdated, Not installed or Worker offline). Install, Reinstall and Remove act on that worker's Claude Code settings file and touch Band's entries only. Managing hooks needs an admin token.

Each hook runs this command in the background and always exits 0, so a hook cannot interrupt your agent:

```text
band notify --agent claude-code >/dev/null 2>&1 || true
```

`band notify` reads the hook's JSON from stdin and sends it to the hub. The hub matches the working directory to a worktree on the worker that sent it, and maps the event to a state:

| Claude Code event | State |
| --- | --- |
| UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure | working |
| PreToolUse for a question or plan-approval tool, PermissionRequest | question |
| Stop | done, or monitoring while scheduled crons or background tasks remain |
| StopFailure | failed |
| SubagentStart, SubagentStop | working while subagents run after the main turn |
| PostCompact | done after a manual /compact |
| SessionEnd | the session stops counting |

## Notification sound

Settings > Notifications has a switch, "Play sound when an agent needs you or finishes". It plays a sound when an agent asks a question, finishes or fails. Monitoring is silent. A second setting picks the sound, and choosing one plays a preview.

Save the setting with the Save button in Settings. See [Settings](settings.md).

## Troubleshooting

- No dot for an agent in a terminal: check Settings > Agent hooks for that worker. The hooks must be Installed, and the worker must be online.
- A dot stays on working: the agent process may have ended without telling Band. Stop the chat or close the terminal. The hub also resets every state except done and failed to idle when it starts.
