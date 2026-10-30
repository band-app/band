---
title: Add your first repo
description: Register a repo from a worker's folder or by its remote URL, in the dashboard or with the CLI.
section: get-started
order: 30
---

A repo is a repository Band knows about. The hub stores its remote URL and default branch, and each worker keeps its own clone. You need one repo before you can create worktrees.

## Add a repo in the dashboard

Click the plus button in the header of the Repos panel in the sidebar ("Add repo"). The button shows only for an admin device. The Add repo dialog has two tabs.

![The Add repo dialog](/docs/screenshots/add-repo.png)

### From a worker

Use this tab for a repo that is already checked out on a machine Band can reach.

1. Pick the worker in the Worker list. The hub's own machine is the built-in worker `local`.
2. Browse the worker's folders. The path bar at the top is clickable, the filter narrows the list, and a folder with a git repo shows a `git` mark. In the desktop app with a hub on this Mac, "Choose on this computer" opens the native folder picker.
3. Click "Use this folder". The dialog shows the repo name, remote URL and default branch it read from the folder.
4. Under "Available on", leave "All workers" or choose "Only" and tick the workers that may run the repo. Then click "Add repo".

If the folder is outside the folders the worker serves, the dialog asks you to confirm, and the button reads "Add root and repo". That also lets the worker serve that folder from then on.

A folder with a remote becomes a repo that any allowed worker can clone. A folder with no remote stays on that worker only, and its worktrees can run only there. A folder that is not a git repository is added as a plain folder. It has one implicit worktree, the folder itself, and no branches or git features.

If Band already has a repo with the same remote, the folder becomes that repo's clone on the worker. Band tells you so and offers to make that worker the primary one.

With no worker online, the tab says "No worker is online" and offers "Add a worker" and "Add by URL".

### By URL

Use this tab to add a repo from its remote, with no checkout on the hub.

1. Enter the remote URL, for example `https://github.com/owner/repo` or `git@github.com:owner/repo.git`.
2. Leave "Default branch" empty and the hub asks the remote. The dialog shows the name and branch it found.
3. Choose "Available on" as above and click "Add repo".

A worker clones the repo the first time a worktree lands on it, into `~/band/repos/<owner>/<name>`.

### Promote a plain folder to git

Right-click a plain folder repo in the sidebar and choose "Promote to git…". Band runs `git init -b main` in the folder. The existing folder stays in place and gains branches, diffs and the other git features.

## Add a repo with the CLI

The CLI adds a repo in three ways:

```sh
band repos add /path/to/repo                       # a folder on the hub's machine
band repos add --url https://github.com/owner/repo --branch main
band repos add --from <worker> /path/on/the/worker
```

`--branch` is optional with `--url`. `--from` takes a worker id, which `band workers list` prints. A folder outside the worker's served folders needs `--add-root`. List and remove repos like this:

```sh
band repos list
band repos remove my-app
```

Removing a repo only unregisters it. It deletes no files. The Remove button on a repo's page in Settings > Repos does the same once the repo has no worktrees. See [Repos](repos.md) and the [repos command reference](/docs/cli-repos).

## Next step

[Create your first worktree](first-worktree.md).
