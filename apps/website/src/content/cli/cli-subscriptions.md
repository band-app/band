---
title: band subscriptions
description: Make a chat wait for pull request activity, CI results, webhooks or timers instead of polling.
section: cli
order: 85
commands: [subscriptions]
---

`band subscriptions` tells Band what a chat should wait for. When an event arrives, Band wakes the chat with a short message. See [Subscriptions](subscriptions.md) for the concepts.

## Concepts

A subscription belongs to a chat. The chat comes from `--chat <id>`, or from `$BAND_CHAT_ID`, which Band sets for every agent chat. Run inside an agent chat, you can leave both `--chat` and `--worktree` out. Without a chat, `create` fails.

`create` takes exactly one source:

- `--pr owner/repo#N` watches a pull request. It delivers reviews and comments. Add `--ci` to also watch CI on the pull request's head branch. That makes two subscriptions, and Band needs the `gh` CLI to look up the branch.
- `--branch owner/repo@branch` watches CI on a branch.
- `--webhook` creates a URL that wakes the chat when something posts to it.
- `--cron <expression>` is a recurring timer. The seconds field is optional.
- `--at <when>` is a one-off timer. Give epoch milliseconds or a delay such as `90s`, `10m`, `2h` or `1d`.

Every subscription stops after `--max-wakeups` wakeups. The default is 10 for CI and 50 for everything else. A one-off timer always stops after one. `--coalesce` sets how many seconds Band holds events before it wakes the chat (default 30).

## Output

`create` prints one line per subscription: its id, a tab, and what it watches, for example `PR owner/repo#12`, `CI on owner/repo@main`, `cron */5 * * * *` or `/api/hooks/<id>`.

A webhook also prints the request to make and its token:

```text
sub_abc123	/api/hooks/sub_abc123
  POST /api/hooks/sub_abc123 with header X-Band-Webhook-Token: <token>
  The token is shown once.
```

`list` prints the columns ID, SOURCE, WATCHES, WAKEUPS (used and allowed) and EXPIRES. Use `--worktree <id>` to list every subscription in a worktree instead of one chat's. `remove` prints `Subscription <id> removed`.

## Examples

```sh
band subscriptions create --pr owner/repo#12 --reviews --ci
band subscriptions create --branch owner/repo@main --max-wakeups 3
band subscriptions create --at 2h
band subscriptions create --cron "0 * * * *" --coalesce 60
band subscriptions list
band subscriptions remove <id>
```
