---
title: GitHub integration
description: What Band shows and does for GitHub repos, how it authenticates with gh, and how to turn the GitHub plugin off.
section: more
order: 20
---

GitHub features live in a bundled plugin called GitHub. It adds a Checks tab to the right sidepanel, and it feeds the pull request badge on each worktree in the sidebar. Band talks to GitHub through the `gh` command line tool, so there are no GitHub settings in Band itself.

## What you get

### The Checks tab

The Checks tab sits after Explorer and Changes in the right sidepanel. It shows the pull request for the worktree's branch:

- The PR number, title and state, with a menu to open the PR on GitHub or copy its link.
- The reviewers and their states, and the comment threads.
- The checks on the PR's head commit, with a count of passing, failing and pending checks. Each check can open on GitHub, and a failing job can run again.
- A merge button. It defaults to squash and has a menu for a merge commit or a rebase. Each method asks you to confirm. After the PR is merged, the button becomes Delete worktree.

When the branch has no pull request, the tab shows the GitHub Actions jobs on the branch head. The tab refreshes every 30 seconds while checks run and every 2 minutes otherwise, only while it is visible. The Refresh button reads again at once.

The tab appears for repos whose `origin` is on github.com, on `*.ghe.com`, or on a host named `github.<company>.<tld>`. It tells you when the repo has no remote, the worktree is not on a branch or `gh` cannot reach GitHub.

### The pull request badge

Each worktree row in the sidebar shows its PR number as a tag colored by CI state: red for failing checks, yellow for pending or running, green for passed, gray for no checks or only cancelled ones, violet for merged, and a struck-through gray for closed. A branch with no PR shows a CI icon, or nothing when it has no checks. Hover or focus the badge to see the title and status, with Open on GitHub and Copy link. A click opens the Checks tab.

### Subscriptions

An agent can wait for reviews, comments and CI on a PR without polling. See [Subscriptions](subscriptions.md).

## Requirements

Install the GitHub CLI, `gh`, on the machine where the worktree lives. Both Docker images (`band-hub` and `band-worker`) already include it. If `gh` is outside your `PATH`, set `BAND_GH_BIN` to its full path for the hub.

## Authentication

Band runs `gh` on the worker that owns the worktree, so it uses that worker's `gh` login. If that worker is offline, has no `gh` or is not logged in, Band falls back to the hub's `gh`. If both fail, the Checks tab shows an error that names each machine and the fix.

To log in, run `gh auth login` on the machine. For a hub or worker where you cannot log in by hand, such as a container, store a GitHub token in the credential vault as a git credential:

```sh
band vault put github-band --kind git --host github.com --path 'band-app/*'
```

The command reads the token from standard input. Pipe it in, or paste it and press Ctrl-D.

Then:

- The hub uses that token as `GH_TOKEN` for its own `gh` calls when the machine has no `gh` login. A repo-scoped item wins over a global one, and the broadest matching path is used.
- A worker started by a runner receives `GH_TOKEN` in the environment of its agents and terminals, so `gh` works there. A worker that you started yourself keeps its own login and receives the token only when it sets `BAND_WORKER_GH_TOKEN=hub`. The token never goes to the worker's disk or logs.

The token needs access to the repos you use: read access to pull requests and checks, and write access to merge a PR or run a job again. See [Runner hooks](runner-hooks.md#git-and-github-auth) for the details and [Credentials](credentials.md) for the vault.

## Turn the plugin off

Add the plugin id to `plugins.disabled` in `~/.band/settings.json` on the hub, then restart the hub.

```json
{
  "plugins": { "disabled": ["github"] }
}
```

The Checks tab disappears. The branch status poller stops calling `gh`, so worktree rows show neither the PR badge nor the CI icon, and GitHub subscriptions fall back to webhooks only.

## Limits

The plugin works with GitHub only. Other hosts such as GitLab have no integration yet. Merging and re-running a job go through `gh`, so they depend on the permissions of the login or token in use.
