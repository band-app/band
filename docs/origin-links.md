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

The sidebar has one list. Worktrees in no group are plain top-level rows below Pinned, with no header. Then each worktree group is a collapsible header (color dot, name, count) in the order Settings > Groups sets. Headers share the Pinned header's left edge, and rows sit one level under their header. Dragging a header above or below another, or Move up / Move down in its menu, reorders the groups (`groups.reorder`). Under a header the group's worktrees nest by origin, and every card shows the repo avatar and name. With no group defined the sidebar lists worktrees under their repos until the first group exists.

- A worktree with no origin, or whose origin is gone, nests under its repo's main when that main is in the same group, and a gone parent also shows a "parent removed" hint. A worktree started from one in another group is a top-level row, with a "from <parent>" chip that opens the parent. A chevron collapses a subtree, and the choice is kept per device. A card shows a worker tag when its worker is not the hub's own machine.
- The group filter (All, each group, and "New group…" after a separator) shows one group laid out exactly as in All: same header, collapse control, indent and order. A header's menu renames, recolors and deletes the group (deleting leaves its worktrees ungrouped), and its "+" starts a worktree in that group. A new worktree joins its origin's group, the group the sidebar is filtered to, or none.
- Pinned is the first section. Each pin shows the worktrees started from it, all the way down, and those leave the normal tree, so nothing is listed twice. A pin with children has a chevron that uses the same collapsed set as the group tree. The group filter applies to pins and their children. The header button folds every group header, the Pinned section and every parent with children the list shows for the current filter, then unfolds the same ones, and its icon and label show the next action. A group the filter hides keeps its state.
- Dragging: a mouse drags after 8 px and a finger after a 250 ms hold, so a click or tap still opens the worktree. The drag preview is the row's own card. Dropping on a group header moves the worktree to that group, and dropping on a top-level row or the strip above the first group (drawn while no top-level row exists) takes it out of its group and out of a parent that is in a group (`worktrees.setGroup`), and a dialog asks "Move its N children too?" when it has children. Dropping on the middle of another worktree makes the dragged one its child (`worktrees.setOrigin`) and moves it into that worktree's group. Dropping in the gap above or below a row makes it a sibling of that row, so beside a top-level row its parent is cleared. A worktree can't go under itself or under a worktree started from it, and the sidebar shows the reason. Pins reorder among themselves, and dragging into or out of Pinned does not pin or unpin. While no group exists, a worktree reorders within its repo (`worktrees.reorder`, `sort_index`; pins use `pin_sort_index`).
- The mobile list matches: a section per group holding the origin tree, the same filter, and "New group…" in its group picker. A row's long-press menu has "Set parent…" and "Remove parent" in place of drag and drop.
- The worktree view has no "Started from" bar. The relationship shows only in the tree.

Tests: `apps/web/e2e/sidebar-grouping.spec.ts`, `apps/web/e2e/sidebar-pins-drag.spec.ts` (pins, collapse, reordering while no group exists, a phone), `apps/web/e2e/sidebar-groups.spec.ts`, `apps/web/e2e/settings-groups.spec.ts`, `apps/hub/tests/worktree-reorder.test.ts`.
