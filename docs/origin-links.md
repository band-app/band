---
title: Origin links
description: How Band records which worktree, chat or terminal a worktree was started from, and how to set or clear the parent.
section: using-band
order: 90
---

A worktree remembers where it was started from. When an agent in worktree A starts worktree B, B records A as its parent. The sidebar shows B nested under A, so a piece of work and the work it spawned stay together. This replaced the removed projects feature.

## How the parent is set

A parent is set in one of these ways.

- **From an agent.** Every chat gets a built-in MCP server named `band`, with the tool `worktrees_create`. A worktree the agent creates records the agent's worktree and chat as its origin. The new worktree's chat has the same tool, so the links form a tree. A chat running on a worker creates worktrees on that worker only. A chat on the hub's own machine can name another worker.
- **From the CLI.** `band worktrees create` run in a Band terminal or agent records the worktree it runs in. Inside a worker's terminal, the hub also records the terminal. Pass `--origin <id>` to choose a parent, or `--no-origin` to record none.
- **By hand.** Use **Set parent…** in the card menu, `band worktrees set-origin`, or drag a card onto the middle of another card.

```sh
band worktrees create atlas feat-login-tests --origin atlas-feat-login
band worktrees create atlas feat-spike --no-origin
band worktrees set-origin atlas feat-login-tests --origin atlas-feat-login
band worktrees set-origin atlas feat-login-tests --none
band worktrees list
```

`worktrees list` has an ORIGIN column. For `set-origin`, the second argument is the worktree name, which is the branch it was created on, and `--worker` names its worker when it is not on `local`.

The hub refuses a parent that would make a cycle, meaning the worktree itself or any worktree started from it. **Set parent…** opens a searchable list of every other worktree, on any repo and worker, minus those. **Remove parent** clears the link and shows when there is one.

A chat or terminal is recorded only by the hub, from the identity of the caller. A request cannot name a chat or terminal of its own, so an agent cannot claim to come from a chat that is not its own. A parent you set by hand has no chat or terminal.

The `worktrees_create` tool takes `repo`, `branch`, and optionally `base`, `hostId`, `prompt`, `codingAgentId`, `origin` and `noOrigin`. It returns the path and worktree id.

## What the sidebar shows

The sidebar is one list. Pinned worktrees come first, then each [group](groups.md) as a collapsible header, then worktrees with no group. Under a header the worktrees nest by parent.

- A worktree with no parent, or whose parent is gone, sits under its repo's default-branch worktree when that one is in the same group. A gone parent also shows "parent removed".
- A worktree started from one in another group is a top-level row with a "from <parent>" label. Click the label to open the parent.
- A chevron collapses a parent's children. Each device keeps its own choice.
- Each pin shows the worktrees started from it, all the way down. Those worktrees leave the normal tree, so nothing is listed twice.
- The header button folds every group, the Pinned section and every parent with children, then unfolds the same ones.

Drag and drop moves things around:

- A mouse drags after 8 px of movement and a finger after a 250 ms hold, so a click or tap still opens the worktree.
- Dropping on a group header moves the worktree to that group. A dialog asks "Move its N children too?" when it has children.
- Dropping on the middle of another card makes the dragged worktree its child, and moves it into that card's group.
- Dropping in the gap above or below a card makes it a sibling of that card.
- Dropping on a top-level row, or on the strip above the first group, takes the worktree out of its group and out of a parent that is in a group.
- A worktree cannot go under itself or under a worktree started from it. The sidebar says why.
- Pins reorder among themselves. Dragging into or out of Pinned does not pin or unpin.

The phone layout has the same list and filter. A row's long-press menu has **Set parent…** and **Remove parent** in place of drag and drop. The worktree view itself has no "Started from" bar.

A new worktree joins its parent's group, unless you pick a group or the sidebar is filtered to one.

## Details

The links are stored on the worktree as three plain ids: the origin worktree, chat and terminal. They have no foreign key, because the origin can be on any repo and worker. Removing the origin worktree keeps the ids, and the list marks the origin as removed.

Through a worker's relay, an explicit `origin` must be a worktree on that worker. A call on the hub's own machine that carries identity headers directly is as trusted as the device token that made it. `repos.list` returns `origin` and `children` for each worktree, and `worktrees.setOrigin` sets or clears a parent.
