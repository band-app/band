---
paths:
  - "**/checkpoints.test.ts"
  - "**/settings-groups.spec.ts"
  - "**/trpc.test.ts"
  - "**/worktree-groups-relay.test.ts"
  - "apps/cli/tests/integration.rs"
  - "apps/hub/src/server/infra/db/queries/worktree-groups.ts"
  - "apps/hub/src/server/services/worktree-group-service.ts"
  - "apps/hub/tests/worktree-groups-migration.test.ts"
  - "apps/mobile/tests/renaming.test.ts"
  - "apps/web/e2e/sidebar-groups.spec.ts"
  - "apps/web/e2e/worktree-rename.spec.ts"
---

# Architecture: worktree groups

A group is a hub entity that collects worktrees across repos and hosts (`worktree_groups { id, name, color, sort_order, created_at }`, `infra/db/queries/worktree-groups.ts`, `services/worktree-group-service.ts`). A worktree is in at most one group, named by `worktrees.group_id`. It replaced the repo labels: `repos.label` and `settings.labels` are gone.

- Writes. Only `RepoQueries.setGroup` writes `group_id`, like the `origin_*` columns: `saveAll` copies it from the rows it replaces, and `repos.list` carries it through the rebuilt worktree list. `CheckpointService.restoreFrom` sets it on the restored copy, so a move, restore or continuation keeps the group. Deleting a group nulls the column for its worktrees and never touches the rows.
- Default group for a new worktree (`WorktreeService.create`): an explicit `groupId` (null means none), else the origin worktree's group, else none. The web sends the group the sidebar is filtered to. A replayed placement request keeps the settled `groupId`.
- API: `groups.list | create | update | remove | reorder`, `worktrees.setGroup { worktreeId, groupId | null, withChildren? }` (`withChildren` moves the whole origin subtree) and `groupId` on `worktrees.create`. `repos.list` returns `groups` and a `groupId` per worktree. Mutations emit `worktree-origin-changed`, which refreshes the sidebar.
- Agents. The relay allows `groups.list` and `worktrees.setGroup` for a worktree on the caller's host, and refuses `withChildren` (it would move worktrees the relay never checked). `groups.create | update | remove | reorder` are refused by the relay and left out of the MCP endpoint, so an agent assigns worktrees but does not change groups.
- Migration `worktree_groups`: copies each repo's label id into its worktrees' `group_id`, drops `repos.label` and renames the client-state keys (`band.repos-list.group-filter`, `collapsed-groups`, `group-last-worktree`, `band.mobile.group-filter`). `WorktreeGroupService.convertLegacyLabels` runs first in `runFirstTimeSetup`: it creates a group for each entry of `settings.labels` with the same id, name, color and order, clears ids that name no group and removes the `labels` key. It is idempotent.
- Titles. `worktrees.title` (null for none) is written only by `RepoQueries.setTitle`, and `saveAll` and `CheckpointService.restoreFrom` carry it like `group_id`. `worktrees.setTitle { worktreeId, title | null }` trims, treats blank as null, rejects more than 100 characters with 400 and emits `worktree-origin-changed`. The relay allows it for a worktree on the caller's host and the MCP endpoint lists it. `repos.list` returns `title` per worktree. The web card shows `title ?? name` with "Rename…" and double-click, `worktreeDisplay` uses it for headers and dialogs, and the mobile row menu has Rename…. CLI: `band worktrees rename <id> <title> | --clear`. Tests: `apps/web/e2e/worktree-rename.spec.ts`, `trpc.test.ts`, `worktree-groups-relay.test.ts`, `worktrees_rename_*` in `apps/cli/tests/integration.rs`, `apps/mobile/tests/renaming.test.ts`.
- UI: the sidebar's default view is Groups (a section per group with its origin tree, then Ungrouped), with drag onto a header, the header menu and the group filter. Settings > Groups manages them. CLI: `band groups list | create | rename | remove`, `band worktrees set-group`, `band worktrees create --group`.
- Tests: `apps/hub/tests/worktree-groups-migration.test.ts`, `worktree-groups-relay.test.ts` (real worker), the group cases in `checkpoints.test.ts` and `trpc.test.ts`, `apps/web/e2e/sidebar-groups.spec.ts`, `settings-groups.spec.ts`, `groups_*` in `apps/cli/tests/integration.rs`.
- Not done yet: several groups per worktree, nested groups, and group management in the mobile app.
