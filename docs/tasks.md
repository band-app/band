# Tasks

A task is one piece of work in one project. It is a folder on one host that holds a brief and one git worktree per repo the work touches. The agent of a task runs in that folder, so the project's repos sit side by side under its feet.

```
$BAND_HOME/projects/<project>/            the project folder (a working copy of the project's context repo)
  tasks/<task>/                           one folder per task on this host
    BRIEF.md                              the task's brief
    <repo-a>/                             git worktree of repo-a on the task's branch
    <repo-b>/                             git worktree of repo-b, when the task touches it
```

The project folder keeps `tasks/` and `repos/` out of the context repo, so task folders and code are never committed to it.

## Create a task

From the CLI:

```sh
band tasks create <project> <branch> [--repo <name[:role]>...] [--brief <file>] [--host <id>] [--labels k=v,k=v]
```

Each `--repo` must be a repo of the project. Band makes the task folder on one host, writes `BRIEF.md` there, and adds a worktree for each repo on `<branch>`, started from the repo's default branch (`origin/<default>` after a fetch). It runs each repo's `.band/environment.json` setup in its worktree, then starts a chat in the folder. `--no-start` makes the chat without sending the first prompt.

The folder is named after the branch with `/` replaced by `-` (`feat/x` becomes `feat-x`). `--name` sets another name.

A task with no `--repo` starts empty. Its agent reads the brief and adds the repos it needs.

A project's coordinator creates tasks with the `tasks_create` tool. The project's autonomy decides whether the call runs at once (`autonomous`), waits for your approval on the project page (`steer`) or is refused (`observe`).

## One host per task

A task runs on one host. Band takes the host you name with `--host`, or the least loaded online host that has every label the project's policy and `--labels` ask for. When no host fits, `create` fails and says which label or repo is missing. It does not split the task across hosts. A repo with no remote URL is held by the hosts that have it, so a task that includes one is limited to them.

## Add and remove repos

```sh
band tasks add-repo <task> <repo> [--role <role>] [--project <project>]
band tasks remove-repo <task> <repo> [--project <project>]
band tasks remove <task> [--project <project>] [--force]
```

`<task>` is the task id, or its name with `--project`.

`add-repo` accepts only repos of the task's project, and only when the task's host has the labels the project requires. `remove-repo` refuses while the repo's worktree has uncommitted changes or commits that are not on the default branch, and says which. `remove` takes out the worktrees, chats and folder, and `--force` skips that check.

The agent of a task has the same two actions as tools, `task_add_repo` and `task_remove_repo` on the `band-task` server. They change only the agent's own task.

## What the agent sees

The agent starts in the task folder with `BAND_TASK_ID` and `BAND_PROJECT_ID` in its environment. Its first message points at `BRIEF.md`. Its preamble lists the project's repos with their roles, remote URLs and default branches, and says which already have a worktree in the folder. Claude Code loads a repo's `CLAUDE.md` when the agent works in that repo's folder.

## Worktrees that predate tasks

Every worktree belongs to a task. A worktree made before tasks existed, or made on its own with `band worktrees create`, is a one-member task in its project, or in the default project when it has none. Its folder is the worktree, nothing moves, and `band tasks list` shows it. It cannot take more repos, because it has no task folder. A task group from step 6.3 became a task with its members, merge order and pull request numbers.

## Ephemeral workers

A task on an ephemeral worker sleeps and wakes with its worktrees. The hub keeps the brief and the task chat's agent session, and a message to the task chat wakes the worker. A task with no worktree yet blocks the sleep, because there is nothing to restore it from. See `docs/ephemeral-workers.md`.
