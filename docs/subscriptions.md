---
title: Subscriptions
description: Wake a chat when a pull request gets a review or comment, CI finishes, a webhook arrives or a timer fires, instead of polling.
section: automation
order: 20
---

A subscription tells Band what a chat is waiting for. The agent subscribes, ends its turn, and Band sends a short message into the same chat when a matching event arrives. Nothing polls and no session stays open.

Use a subscription when work starts because something happened. Use a [cronjob](cronjobs.md) when work starts because the clock says so.

## Sources

| Source | Wakes the chat when |
| --- | --- |
| Pull request | A review, review comment or comment arrives, or the PR is merged or closed. |
| CI | Every check on a commit has finished. One event per commit, with the verdict. |
| Webhook | Something posts to the subscription's URL with its token. |
| Timer | A one-off delay passes, or a recurring cron schedule fires. |

## Create a subscription

A command run in a chat uses that chat. Band sets `BAND_CHAT_ID` and `BAND_WORKTREE_ID` in the agent's environment, so you can leave out both ids. From a terminal there is no chat, so pass `--chat <id>`.

Each command takes exactly one of `--pr`, `--branch`, `--webhook`, `--cron` and `--at`.

```sh
# After opening a PR: wake on reviews, comments and CI
band subscriptions create --pr acme/api#42 --reviews --ci

# CI of a branch with no PR yet
band subscriptions create --branch acme/api@feat/login

# A webhook. The path and token print once.
band subscriptions create --webhook

# Check back in 30 minutes, then every weekday morning
band subscriptions create --at 30m
band subscriptions create --cron "0 9 * * 1-5"
```

With `--pr`, reviews and comments are one subscription. Either `--reviews` or `--comments` creates it, and so does neither flag when `--ci` is absent. Add `--ci` to also watch CI on the PR's head branch, which creates a second subscription. `--at` takes epoch milliseconds or a delay such as `90s`, `10m`, `2h` or `1d`. `--cron` takes a cron expression with an optional seconds field.

`--coalesce <seconds>` holds events so a burst wakes the chat once. The default is 30.

List and remove subscriptions:

```sh
band subscriptions list
band subscriptions list --worktree <id>
band subscriptions remove <id>
```

`list` shows the chat's subscriptions, or every subscription in a worktree with `--worktree`. Remove a subscription as soon as the wait is over.

## MCP tools

An agent that uses Band's MCP endpoint gets `band_subscriptions_create`, `band_subscriptions_list`, `band_subscriptions_remove` and `band_subscriptions_events`. The chat and worktree default to the caller's. The create tool takes `source` (`github`, `timer` or `webhook`), then `repo` with `pr` or `branch`, or `cron` or `at`, plus `maxWakeups` and `coalesceSeconds`. A `github` subscription on a PR also takes `allowedSenders`.

## Webhooks

A webhook subscription prints a path and a token once. Band stores only a hash of the token, so keep the printed value. Post to `/api/hooks/<id>` on the hub with the token in the `X-Band-Webhook-Token` header or as a Bearer token.

```text
POST /api/hooks/<id>
X-Band-Webhook-Token: <token>
```

The hub answers 202 when it accepts the event, 401 for a wrong token and 404 for an unknown id. The route needs no device token, so the sender can be any service that can reach the hub. See [Remote access](remote-access.md) for exposing a hub.

## GitHub events

A GitHub subscription needs the hub to hear from GitHub. There are two ways, and Band picks one.

- **Webhook.** The first subscription for a repo registers a webhook on that repo with `gh`. This needs a public URL for the hub, either `BAND_PUBLIC_URL` or a running tunnel. The hub checks the `X-Hub-Signature-256` signature of every delivery against a secret. The secret comes from `BAND_GITHUB_WEBHOOK_SECRET`, or the hub generates one at `~/.band/github-webhook-secret`.
- **Polling fallback.** Without a public URL, or when registering fails, the hub polls instead. Polling runs with the branch status checks, so it needs the [GitHub plugin](github-integration.md) enabled. It is slower than a webhook and makes at most 6 `gh` calls per poll.

Both ways need a working `gh` login on the hub, or a GitHub credential in the vault. See [GitHub integration](github-integration.md#authentication).

For CI, a commit's verdict arrives once every check has finished. A failure names the failed checks. With no failure, a cancelled run is reported as its own outcome.

## Limits and safety

Band limits what can wake an agent.

- **Wakeups.** A subscription stops after `--max-wakeups` wakeups. The default is 10 for CI and 50 for everything else, and a one-off timer always gets 1. Every subscription also expires after 180 days.
- **Allowed senders.** Comments and reviews wake the chat only when they come from an allowed sender. The default is the repo owner and the user logged in to `gh`. The MCP tool's `allowedSenders` list replaces that default, and the comparison ignores case. Events from anyone else are recorded and dropped.
- **Your own pushes.** After an agent pushes a branch through Band, a push or PR update event for that commit does not wake the chat. A CI failure on a commit that Band pushed is delivered as a reason to fix it. A CI failure on any other commit is delivered with a note that it is not Band's and must not be fixed.
- **Untrusted text.** The wake message is a short summary and a link, wrapped in `<untrusted-event>` blocks. The agent treats the text as data and reads the source itself before acting.

## Related

- The `band-subscribe` skill teaches agents when to subscribe. See [Agent skills](agent-skills.md).
- [Subscriptions CLI reference](/docs/cli-subscriptions).
