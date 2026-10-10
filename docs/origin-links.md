# Origin links and meta repos

A worktree records where it was started from. This replaces the removed projects feature (implementation plan, section 15).

## What is stored

Three nullable columns on `worktrees`: `origin_worktree_id`, `origin_chat_id` and `origin_terminal_id`. They hold plain ids, with no foreign key, because the origin can be on any repo and host. `repos.meta` is a boolean on the repo.

`RepoQueries.saveAll` rewrites the whole repo and worktree tables, so it copies the origin columns and the meta flag from the rows it replaces and ignores what its snapshot says. They change only through `RepoQueries.setOrigin` and `setMeta`.

## How the origin is set

`worktrees.create` takes two optional fields.

- `origin` is the id of the worktree to record as the parent. It must exist.
- `noOrigin: true` records none. Passing both is an error.

With neither, the hub uses the caller's identity. The chat or terminal is never read from the request body. It comes from one of two places the hub controls:

- The worker relay. A relay token is issued for one process with a scope of `{ worktreeId, chatId?, terminalId? }`. The hub sets the `x-band-worktree-id`, `x-band-chat-id` and `x-band-terminal-id` headers from that scope when it replays a call, and drops any such header the caller sent. A shell on a worker that runs `band worktrees create` gets its worktree and terminal recorded.
- The built-in `band` MCP server. Every chat session gets an MCP entry at `<hub or relay URL>/mcp-proxy/band` with the chat's session token (`mcp_...`). The token names the chat, and the chat names its worktree.

An explicit `origin` keeps the caller's chat or terminal only when it names the caller's own worktree. Through a relay it must be a worktree on the worker's host.

On the hub's own machine the CLI has no relay token. `band worktrees create` sends `$BAND_WORKTREE_ID` as `origin`, so a local terminal or agent records the worktree but not the chat or terminal. A call that carries the identity headers directly is as trusted as the device token that made it.

## The `band` MCP server

The tool `worktrees_create` takes `repo`, `branch`, and optionally `base`, `hostId`, `prompt`, `codingAgentId`, `origin` and `noOrigin`. It returns the path and worktree id (or a provisioning request id). The new worktree's chat can call the tool too, which builds a tree.

A chat on a worker creates worktrees on that worker only. A chat on the hub's machine may name any host. The name `band` is reserved, so `mcp.add` refuses it.

## Reading links

`repos.list` returns, for every worktree:

- `origin`: `{ worktreeId, chatId?, terminalId?, removed, repo?, branch? }` or `null`. `removed` is true when the origin worktree no longer exists. The ids stay so a view can say "parent removed". `repo` and `branch` are present while it exists.
- `children`: the ids of worktrees whose origin is this one, across repos and hosts.

Each repo also has `meta`.

## CLI

```sh
band worktrees create <repo> <branch> [--origin <worktree id> | --no-origin]
band worktrees list            # ORIGIN column
band repos set <repo> --meta true|false
band repos list                # META column
```

## Tests

`apps/hub/tests/origin-links.test.ts` (explicit origins, the tree, removal, meta), `origin-links-relay.test.ts` (a real worker: a chat through the `band` MCP server, a shell through the relay, forged identity), and `worktrees_create_records_the_origin_and_list_shows_it` and `repos_set_meta_persists_and_lists` in `apps/cli/tests/integration.rs`.

The sidebar grouping that uses these links is a later step.
