---
title: band groups
description: Create, rename and remove the groups that organize worktrees in the sidebar.
section: cli
order: 35
commands: [groups]
---

A group collects worktrees from any repo and any worker into one section of the sidebar. A worktree is in at most one group. `band groups` manages the groups themselves. To put a worktree in a group, use `band worktrees set-group` or `band worktrees create --group`. See [Groups](/docs/groups).

Anywhere a command takes a group, you can give its id or its name. Names match without regard to case.

## Listing groups

```sh
band groups list
```

```text
ID         NAME     COLOR
g-1a2b3c   Reviews  blue
g-4d5e6f   Spikes   -
```

The order is the sidebar order. With no groups, the command prints `No groups`. JSON output is `{"groups": [...]}` with the hub's fields for each group.

## Creating, renaming and removing

`create` prints the new group's id. Creating a group needs an admin token, the same as in the web app. `--color` takes a name such as `red` or a hex value such as `#ff0000`.

`rename` takes the group and the new name. `remove` deletes the group. Its worktrees stay and become ungrouped.

```sh
band groups create Reviews --color blue
band groups rename Reviews "Code review"
band groups remove "Code review"
```

## Putting worktrees in a group

```sh
band worktrees set-group my-app-feat-login Reviews
band worktrees set-group my-app-feat-login Reviews --with-children
band worktrees set-group my-app-feat-login --none
band worktrees create my-app feat/search --group Reviews
```

`--with-children` also moves the worktrees that were started from this one. A new worktree joins the group of its origin unless you pass `--group`.
