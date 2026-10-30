---
title: Recipes
description: Worked patterns for feature branches, parallel agents, scheduled reviews, backlog processing and CI, with commands that run.
section: automation
order: 40
---

Each recipe is a pattern to adapt. The commands are real. Replace `my-app` with a repo name from `band repos list`.

## Feature branch with a follow-up

Give each feature its own worktree so its files, terminals and chat stay separate.

1. Select the repo in the dashboard and choose New worktree, or run the command below.
2. Send the first task in the same command with `--prompt`.
3. Watch the agent work in the chat, then open the Changes tab to review the diff.
4. Send follow-up tasks in the chat, such as "Limit the bio field to 500 characters and show a counter."

```sh
band worktrees create my-app feat/user-profiles \
  --prompt "Implement a profile page with avatar upload, a bio field and a settings form." \
  --via chat
```

Without `--via`, the prompt goes to a terminal that runs the agent's CLI unless you set another default. See [Repo config](configuration.md) for `workspace.defaultVia`.

## Agents in parallel

A chat runs one task at a time, but each worktree has its own chat. For independent work, make one worktree per task and start them together.

```sh
band worktrees create my-app fix/login-redirect --prompt "Fix the login redirect loop." --via chat
band worktrees create my-app fix/date-format --prompt "Use ISO dates in the export." --via chat
band worktrees list my-app
```

The sidebar shows each worktree's [agent status](agent-status.md). Review them as they finish.

## Process a backlog

Pick a batch of small issues. Create a worktree per issue, named after it, and put the issue in the prompt.

```sh
band worktrees create my-app fix/issue-142 \
  --prompt "Fix issue 142: the login form accepts invalid emails. Add validation and an error message." \
  --via chat
```

Review each result and open a pull request for the ones you keep. Agents can also create worktrees themselves. The `band-start` skill does this from inside a chat. See [Agent skills](agent-skills.md).

## Scheduled review of the main branch

A cronjob fires into an existing worktree. It does not create one. To review new commits every weekday morning, point a job at the repo's default-branch worktree.

```sh
band cronjobs create \
  --worktree my-app-main \
  --name "Morning review" \
  --prompt "List commits on main from the last 24 hours. Review each diff and report risks and missing tests." \
  --cron "0 9 * * 1-5" \
  --via chat
```

Read the answer in the job's chat. If the chat is busy when the job fires, the prompt waits in its queue. See [Cronjobs](cronjobs.md).

## Wait for a review or CI

After an agent opens a pull request, it can subscribe the chat to the PR and end its turn. Band wakes the chat when a review, comment or CI result arrives, so nothing polls.

```sh
band subscriptions create --pr acme/api#42 --reviews --ci
```

See [Subscriptions](subscriptions.md).

## Keep a loop going until it is done

To retry a check on an interval until it passes, schedule the prompt with a cronjob and tell the agent to delete the job when the condition holds. The `band-loop` skill writes that wrapper for an agent that you ask to "check the deploy every 10 minutes until it is green".

```sh
band cronjobs create \
  --worktree my-app-main \
  --name "Deploy check" \
  --prompt "Check the deploy status. If it is green, delete this cronjob with band cronjobs delete." \
  --cron "*/10 * * * *" \
  --via chat
```

## Drive an agent from CI

The CLI talks to the hub over HTTP. A CI job that can reach the hub sets `BAND_SERVER_URL` and `BAND_TOKEN` and then runs `band` commands. Use a device token made for CI. See [Remote access](remote-access.md) and [Devices](devices.md).

```sh
BAND_SERVER_URL=https://band.example.com BAND_TOKEN=<device token> \
  band worktrees create my-app ci/auto-fix \
  --prompt "Run the test suite and fix failures." --via chat --output json
```

The command prints the new worktree's path, not its id. Look the id up in `band worktrees list --output json`, where each worktree has `path` and `worktreeId`. Then list the worktree's chats and stream the running task as JSON lines:

```sh
band chats list <worktree-id>
band chats watch <chat-id>
```

Then inspect the branch, push it or remove the worktree if the run failed.

## Monorepos

Add the monorepo as one repo. Make worktrees per feature as usual and name the package in the prompt: "In packages/api, add rate limiting to the /users endpoint." Document build commands and conventions in the repo's `CLAUDE.md` or `AGENTS.md`, which agents read. Put the install step in `.band/config.json` so every new worktree sets itself up. See [Repo config](configuration.md).
