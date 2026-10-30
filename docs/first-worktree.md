---
title: Create your first worktree
description: Create a worktree on a new branch from the dashboard or the CLI, optionally with a first prompt.
section: get-started
order: 40
---

A worktree is a separate working copy of a repo on its own branch. Git shares the history between worktrees, so a new one is fast and small. An agent in one worktree cannot change the files of another worktree or of your main checkout.

## Create a worktree in the dashboard

Hover the repo's header in the sidebar and click the plus button ("Add worktree"). Right-clicking the repo and choosing "Add worktree" does the same. The plus button is missing for plain (non-git) folder repos, which have one worktree already.

![The New worktree dialog](/docs/screenshots/new-worktree.png)

The "New worktree in <repo>" dialog has these fields:

- **Branch.** The new branch name, for example `feat/login`. Band cleans characters git does not allow, and shows the result under the field as "Creates <name>". If the name is taken the field shows an error. If the branch already has a worktree on another worker, the error offers "Open it".
- **Prompt.** What the agent should do. Leave it empty to create the worktree without starting an agent. With a prompt, Band starts your default agent in the worktree and sends the prompt. The agent opens as a chat or as a terminal, depending on the mode set for this device (see [Run your first task](first-task.md#chat-or-terminal)).
- **Worker.** A list at the bottom left. It appears only when more than one worker can take the repo. It lists the workers that are online and allowed for the repo. The first worktree of a repo on a worker clones the repo there. For a repo with no remote, an extra field asks for the repo's folder on that worker.
- **More options.** Opens "Base branch", the branch the new one starts from. It defaults to the repo's default branch. On a remote worker it also shows "Folder on <worker>", the repo's folder there. Leave it empty to let the worker clone the repo.

Click Create. When the sidebar is filtered to a group, the worktree joins that group.

## Where the files go

On the hub's own machine, worktrees go under `~/.band/worktrees/<repo>/<branch>`. Change the folder in Settings > General, "Worktrees folder". On another worker they go under `.band-worktrees/<repo>/<branch>` inside the first folder that worker serves.

If the repo has a `.band/environment.json`, Band runs its `install` and `start` commands in a terminal tab after creating the worktree, then opens its `terminals`. Without that file, Band runs the `setup` command from `.band/config.json`. See [Agent environments](agent-environments.md).

## The worktree id

Every worktree has an id: `<repo>-<branch>`, with slashes in the branch turned into dashes. Branch `feat/login` in repo `my-app` gives `my-app-feat-login`. On a worker other than `local`, the id ends with `@<worker-id>`, for example `my-app-feat-login@h-1a2b3c4d5e6f`. A branch lives on one worker at a time. The CLI prints ids with `band worktrees list`, and takes them in commands such as `band chats send --worktree <id>`.

## Create a worktree with the CLI

```sh
band worktrees create my-app feat/login
band worktrees create my-app feat/login --base develop
band worktrees create my-app feat/login --worker <worker>
```

The arguments are the repo name and the branch. `--base` picks the base branch and `--worker` takes a worker id or name from `band workers list`. To start an agent at the same time, add `--prompt`:

```sh
band worktrees create my-app feat/auth --prompt "Add JWT authentication to the API"
```

From the CLI the prompt starts the agent in a terminal by default, not in a chat. Add `--via chat` to get a chat. `--agent` names one of your coding agents. See [Run your first task](first-task.md#start-a-task-from-the-cli).

List and remove worktrees like this:

```sh
band worktrees list
band worktrees list my-app
band worktrees remove my-app feat/login
```

`remove` takes the repo and the worktree name, which is the branch it was created on. See [Worktrees](worktrees.md) and the [worktrees command reference](/docs/cli-worktrees).

## Next step

[Run your first task](first-task.md).
