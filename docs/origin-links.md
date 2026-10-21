# Origin links

A worktree records where it was started from. This replaces the removed projects feature (implementation plan, section 15).

## What is stored

Three nullable columns on `worktrees`: `origin_worktree_id`, `origin_chat_id` and `origin_terminal_id`. They hold plain ids, with no foreign key, because the origin can be on any repo and worker.

`RepoQueries.saveAll` rewrites the whole repo and worktree tables, so it copies the origin columns from the rows it replaces and ignores what its snapshot says. They change only through `RepoQueries.setOrigin`.

## How the origin is set

`worktrees.create` takes two optional fields.

- `origin` is the id of the worktree to record as the parent. It must exist.
- `noOrigin: true` records none. Passing both is an error.

With neither, the hub uses the caller's identity. The chat or terminal is never read from the request body. It comes from one of two places the hub controls:

- The worker relay. A relay token is issued for one process with a scope of `{ worktreeId, chatId?, terminalId? }`. The hub sets the `x-band-worktree-id`, `x-band-chat-id` and `x-band-terminal-id` headers from that scope when it replays a call, and drops any such header the caller sent. A shell on a worker that runs `band worktrees create` gets its worktree and terminal recorded.
- The built-in `band` MCP server. Every chat session gets an MCP entry at `<hub or relay URL>/mcp-proxy/band` with the chat's session token (`mcp_...`). The token names the chat, and the chat names its worktree.

An explicit `origin` keeps the caller's chat or terminal only when it names the caller's own worktree. Through a relay it must be a worktree on the worker's worker.

On the hub's own machine the CLI has no relay token. `band worktrees create` sends `$BAND_WORKTREE_ID` as `origin`, so a local terminal or agent records the worktree but not the chat or terminal. A call that carries the identity headers directly is as trusted as the device token that made it.

## The `band` MCP server

The tool `worktrees_create` takes `repo`, `branch`, and optionally `base`, `hostId`, `prompt`, `codingAgentId`, `origin` and `noOrigin`. It returns the path and worktree id (or a provisioning request id). The new worktree's chat can call the tool too, which builds a tree.

A chat on a worker creates worktrees on that worker only. A chat on the hub's machine may name any worker. The name `band` is reserved, so `mcp.add` refuses it.

## Setting the parent by hand

`worktrees.setOrigin { repo, name, hostId?, origin }` sets a worktree's parent, or clears it when `origin` is null. A manual parent has no chat or terminal, and clearing removes all three ids. The hub refuses the worktree itself and any of its descendants (a cycle) and an unknown id, then emits a `worktree-origin-changed` status event so other clients refetch the repo list. In the sidebar, the card's context menu has "Set parent…" (a searchable list of every other worktree, on any repo and worker, minus the worktree and its descendants) and "Remove parent" (shown only when there is a parent).

## Reading links

`repos.list` returns, for every worktree:

- `origin`: `{ worktreeId, chatId?, terminalId?, removed, repo?, branch? }` or `null`. `removed` is true when the origin worktree no longer exists. The ids stay so a view can say "parent removed". `repo` and `branch` are present while it exists.
- `children`: the ids of worktrees whose origin is this one, across repos and workers.

## CLI

```sh
band worktrees create <repo> <branch> [--origin <worktree id> | --no-origin]
band worktrees set-origin <repo> <name> [--worker <worker>] (--origin <worktree id> | --none)
band worktrees list            # ORIGIN column
```

## Tests

`apps/hub/tests/origin-links.test.ts` (explicit origins, the tree, removal), `origin-links-relay.test.ts` (a real worker: a chat through the `band` MCP server, a shell through the relay, forged identity), and `worktrees_create_records_the_origin_and_list_shows_it` in `apps/cli/tests/integration.rs`.

## Sidebar

The sidebar has a Group by switch: Repo, Origin or Worker. The choice is kept per device in localStorage (`band.sidebar.group-by`) and defaults to Repo.

- Repo is the list by repo.
- Origin has each repo's main worktree at the top level. A worktree nests under the one that started it, across repos. A worktree with no origin nests under its repo's main on the same worker, and so does one whose parent was removed, which also shows a "parent removed" hint. A worktree on a worker with no main of its repo stays at the top level. Every row shows the repo avatar, the repo name and a gray worker tag. A chevron collapses a subtree, and the choice is kept per device. Repo view shows the worker tag only for a repo with worktrees on more than one worker.
- Worker groups by worker (the hub's own machine first) with its online state, then by repo.
- Pinned is the first section in all three views. Each pin shows the worktrees started from it, all the way down, and those leave the normal tree, so nothing is listed twice. A pin with children has a chevron that uses the same collapsed set as the Origin view. The label filter applies to pins and their children: a pin shows only when its repo has the selected label. "Collapse all" folds the groups of the current view, the Pinned section and every pin with children.
- Dragging works in every view. A mouse drags after 8 px and a finger after a 250 ms hold, so a click or tap still opens the worktree. The order is one `worktrees.sort_index` per worktree, shared by every view and device (`worktrees.reorder`, which also takes the new parent of the dragged worktree). A worktree with no index keeps the older order and sorts after those with one. Pins have their own order, `pin_sort_index`. Dragging a worktree into or out of Pinned does not pin or unpin it, and children of a pin can be dragged only in the Origin view.
  - Repo view: a worktree reorders within its repo.
  - Origin view: dropping on the middle of a row makes the dragged worktree its child, and dropping in the gap between rows makes it a sibling there. Among a repo main's own children the explicit parent is cleared. A worktree can't go under its own descendant, and a repo's main worktree only reorders among the top-level rows.
  - Worker view: dropping on another worker's group opens "Open on another worker" with that worker selected, and the move happens on confirm. A drop that the move can't do (the hub's own machine, a worker the repo isn't allowed on without an admin token) shows the reason instead. Dropping within the same worker and repo reorders.
- The worktree view has no "Started from" bar. The relationship shows only in the Origin tree.

Tests: `apps/web/e2e/sidebar-grouping.spec.ts`, `apps/web/e2e/sidebar-pins-drag.spec.ts` (pins, label filter, collapse, drag and drop in every view, a phone), `apps/hub/tests/worktree-reorder.test.ts`.
