---
title: Repos
description: Add repos by folder or remote URL, choose where they run, and manage them from the sidebar and Settings.
section: using-band
order: 20
---

A repo is a project you work on in Band. The hub stores the repo's name, its remote URL and its default branch. Each [worker](adding-workers.md) keeps its own clone of the repo, so the hub does not need a checkout.

![The Add repo dialog](/docs/screenshots/add-repo.png)

## The repo list

The Repos section of the sidebar lists every repo with its worktrees below it. Click a repo to collapse or expand it. Drag a repo to reorder the list. The repo menu (right-click, or the "Repo actions" button) has these items:

- Add worktree, for git repos.
- Promote to git…, for plain folders.
- Copy path and Open in Finder, in the desktop app.
- Remove from list.

Repos are sorted into [groups](groups.md) by worktree, not by repo. A repo has no label of its own.

## Add a repo

Adding a repo needs an admin token. Click **+** in the Repos header, or **Add repo** on the empty list. The dialog has two tabs.

**From a worker.** Pick a worker, then browse its folders. The list has breadcrumbs and a filter. When you pick a folder, Band shows the repo name, the remote URL and the default branch before it adds anything. Then:

- A folder with a remote becomes a repo identified by that remote. If Band already has a repo with the same remote, the folder becomes that repo's clone on this worker.
- A folder with no remote stays on that worker only. Other workers cannot clone it, and its worktrees run only there.
- A folder that is not a git repo is added as a plain folder. See below.
- A folder outside the directories the worker serves asks for confirmation. The button then reads "Add root and repo", and the folder also becomes a root of that worker.

With no worker online, the tab says so and links to Settings > Workers. You can still add by URL.

**By URL.** Enter the remote URL, such as `https://github.com/owner/repo` or `git@github.com:owner/repo.git`. Band asks the remote for its default branch and shows it. You can type a different default branch. A worker clones the repo the first time a worktree lands on it, into `~/band/repos/<owner>/<name>`. Set `BAND_REPOS_DIR` or the worker's `--repos-dir` to use another directory.

Both tabs end with an **Available on** choice (all workers or only some) and a **Primary worker**. See [Repo workers](repo-hosts.md).

From the CLI:

```sh
band repos add --url https://github.com/acme/atlas
band repos add --url https://github.com/acme/atlas --branch main
band repos add --from <worker> ~/code/atlas
band repos add --from <worker> /srv/code/atlas --add-root
band repos list
```

`--from` takes a worker id or name from `band workers list`. `--add-root` confirms a folder outside the worker's roots. See the [repos CLI page](/docs/cli-repos).

## Identity by remote URL

Band identifies a repo by its remote URL, not by a path. `git@github.com:acme/atlas.git`, `ssh://git@github.com/acme/atlas`, `https://github.com/acme/atlas` and the same URL without `.git` are all one repo, and the host name is not case sensitive. Adding a second repo with the same remote fails with a conflict. A URL with a user name or password is stored without them.

## Plain folders

A plain folder is a directory that is not a git repository. It has a single worktree, which is the folder itself, and no branches, diffs, pull or push. Band hides the branch status for it. The repo menu offers **Promote to git…**, which runs `git init -b main` in the folder and turns it into a git repo. The existing worktree stays in place.

## Settings for a repo

Settings > Repos lists every repo with its remote and a filter. Open a repo to see its page. Each change saves at once, and the page has no Save button. The sections are:

- General: the remote and the default branch.
- Workers: which workers the repo may run on, the primary worker and where each worker keeps its clone. See [Repo workers](repo-hosts.md).
- Agents: which [agent login](agent-logins.md) each coding agent uses in this repo.
- Environment: the repo's environment file and image. See [Agent environments](agent-environments.md).
- Continuity: [checkpoints](checkpoints.md) and automatic continuation when a worker goes offline.
- Browser: the cookie profile new browser tabs open with.
- MCP servers and Automation: the [MCP servers](mcp-servers.md) and [cronjobs](cronjobs.md) that reach the repo.

Change workers, checkpoints and automatic continuation from the CLI with `band repos set`:

```sh
band repos set atlas --workers all --primary auto
band repos set atlas --checkpoints off
band repos set atlas --auto-continue on
```

## Remove a repo

Remove a repo from its page in Settings > Repos with **Remove repo…**. The button is disabled while the repo has worktrees, and its tooltip says how many. Remove those first. The sidebar menu item **Remove from list** and the CLI do the same job:

```sh
band repos remove atlas
```

Removing a repo makes Band forget it. It does not delete clones or folders on any worker.
