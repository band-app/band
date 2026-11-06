---
paths:
  - "**/GroupedWorktrees.tsx"
  - "**/SetParentDialog.tsx"
  - "**/dashboard/lib/sidebar-grouping.ts"
  - "**/lib/sidebar-drop.ts"
  - "**/origin-links-relay.test.ts"
  - "apps/cli/tests/integration.rs"
  - "apps/hub/src/server/api/mcp-proxy/band-tools.ts"
  - "apps/hub/tests/origin-links.test.ts"
  - "apps/web/e2e/sidebar-grouping.spec.ts"
  - "docs/origin-links.md"
---

# Architecture: origin links

A worktree records where it was started from (plan section 15, guide: `docs/origin-links.md`). `worktrees.origin_worktree_id`, `origin_chat_id` and `origin_terminal_id` hold plain ids. `RepoQueries.saveAll` rewrites both tables and so copies these columns from the rows it replaces, ignoring its snapshot. Only `RepoQueries.setOrigin` changes them.

- `worktrees.create` takes `origin` (a worktree id) and `noOrigin`. With neither, `WorktreeService.resolveOrigin` uses the caller: the worktree, chat and terminal from the `x-band-worktree-id`, `x-band-chat-id` and `x-band-terminal-id` headers that the worker relay sets from the token's scope (`RelayScope.terminalId`), or from the chat of an `mcp_` session token. A request body never names the chat or terminal. A stored placement request keeps the settled origin (`originLink`) for the replay.
- Every chat session gets the built-in `band` MCP server at `/mcp-proxy/band` (`api/mcp-proxy/band-tools.ts`, `BUILTIN_BAND_SERVER`), with the tool `worktrees_create`. A chat on a worker creates only on that worker. A saved MCP server cannot take the name `band`.
- `repos.list` returns `origin` (with `removed` once the parent is gone) and `children` per worktree. The CLI is `band worktrees create --origin | --no-origin`.
- Tests: `apps/hub/tests/origin-links.test.ts`, `origin-links-relay.test.ts` (real worker), `worktrees_create_records_the_origin_and_list_shows_it` and `repos_set_meta_persists_and_lists` in `apps/cli/tests/integration.rs`.
- Sidebar: one list of groups with worktrees nested under their parent (`dashboard/lib/sidebar-grouping.ts`, `GroupedWorktrees.tsx`; dropping on a worktree is `planParentDrop` in `lib/sidebar-drop.ts`) and the card's Set parent / Remove parent context-menu items (`SetParentDialog.tsx`, `worktrees.setOrigin`, `band worktrees set-origin`; the procedure is left out of the MCP endpoint and the relay). Test: `apps/web/e2e/sidebar-grouping.spec.ts`.
- Not done yet: chat or terminal identity for a local CLI call (it records the worktree from `$BAND_WORKTREE_ID` only).
