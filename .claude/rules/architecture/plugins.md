---
paths:
  - "**/_utils/worktree-gh.ts"
  - "**/biome.json"
  - "**/branch-status-poller.ts"
  - "**/client.tsx"
  - "**/dashboard/components/PullRequestBadge.tsx"
  - "**/dashboard/lib/checks-tab.ts"
  - "**/gh-stub.ts"
  - "**/manifest.ts"
  - "**/plugin-host-service.ts"
  - "**/providers.ts"
  - "**/server.ts"
  - "**/worker.ts"
  - "apps/hub/src/server/services/bundled-plugins.ts"
  - "apps/hub/src/server/services/review-signal-service.ts"
  - "apps/hub/tests/fixtures/gh-stub-bin.mjs"
  - "apps/hub/tests/review-changed-signal.test.ts"
  - "apps/web/e2e/pr-checks-review-signal.spec.ts"
  - "apps/web/src/components/review/**"
  - "docs/architecture/plugins.md"
  - "packages/plugin-api/**"
  - "packages/plugin-api/src/server.ts"
  - "plugins/**"
  - "plugins/github/**"
  - "plugins/github/src/server/branch-query.ts"
  - "plugins/github/src/server/checks-query.ts"
  - "plugins/github/src/server/subscriptions.ts"
  - "apps/web/src/plugins/use-plugin-slot.ts"
---

# Architecture: plugins

GitHub features live in a bundled, in-process plugin (`plugins/github/`), following the plugin architecture plan in `docs/architecture/plugins.md`. Band loads no third-party code.

- `packages/plugin-api` holds the contract: the `band-plugin.json` schema (`manifest.ts`), the provider interfaces the core owns (`providers.ts`: `ReviewProvider`, `ChecksProvider`, `ReviewAction`, `WorktreeReview`), the server API (`server.ts`, `definePlugin`, `workers.call`, `tools.register`), the worker API (`worker.ts`, `defineWorkerPlugin`) and the client contributions (`client.tsx`, `defineClientPlugin`, `ClientPluginHost`). A Biome override (`plugins/**` in `biome.json`) lets a plugin import only `@band-app/plugin-api`, `@band-app/ui` and its own dependencies, never `apps/*` or another `@band-app/*` package.
- The server half is listed in `apps/hub/src/server/services/bundled-plugins.ts` and run by `PluginHost` (`plugin-host-service.ts`). It activates a plugin on `onStartup` or on the first provider lookup for a matching `onRepoRemote:<host glob>`, skips ids in `plugins.disabled` in `~/.band/settings.json`, and contains a plugin that throws. `ReviewService` resolves a worktree and asks the matching provider. The tRPC surface is `reviews.forWorktree`, `reviews.provider` (the provider for a worktree, no forge command), `reviews.runAction`, the wrappers `reviews.merge` and `reviews.rerunChecks` (kept for the mobile app), and `plugins.list`.
- Providers return plain JSON and the core draws it. The Checks tab is the core's (`apps/web/src/components/review`, listed by `useWorktreeSideTabs` in `plugins/use-plugin-slot.ts`): it shows when `reviews.provider` finds a provider for the worktree, keeps the test id slug `github-pull-request`, and takes the forge's name and the Fix prompt's `fixHint` from the provider. A review lists `actions` (id, label, icon from a fixed set, placement `header` or `check`, args, confirm text, disabled reason). The core draws them and calls `reviews.runAction`. GitHub offers `merge` (one action per method, group `merge`), `rerun-job`, `rerun-failed` and `ready` (`gh pr ready`), and `gh` subcommands must be on the allowlist in `_utils/worktree-gh.ts`. The `worktree.sideTabs` slot and `ClientPluginHost` stay for client halves, and no bundled plugin has one.
- The GitHub plugin's review data is the branch's pull request with the checks on its head commit, or the CI jobs on the branch head when there is no PR. It gets both from one `gh api graphql` query (`plugins/github/src/server/checks-query.ts`). `BAND_GH_BIN` overrides the `gh` binary and is read on every call; tests point it at `apps/hub/tests/fixtures/gh-stub-bin.mjs`, which forwards to the Express stub in `gh-stub.ts`. A fake `gh` on `PATH` would not work, because `/opt/homebrew/bin` and `/usr/local/bin` are always prepended.
- Change signal. `BandServerApi.reviews.changed({ repo, branch?, number? })` (`packages/plugin-api/src/server.ts`) tells the core a review changed on the forge. `ReviewSignalService` (`services/review-signal-service.ts`) maps it to the worktrees whose repo `remoteKey` is `host/owner/repo` and whose branch matches (all of the repo's worktrees when no branch is given) and sends one `review-changed { worktreeIds }` status event, coalesced over 1 s. The GitHub plugin's subscription source fires it (`plugins/github/src/server/subscriptions.ts`): from `parseDelivery` after the signature check, for `pull_request`, `pull_request_review`, `pull_request_review_comment`, `issue_comment`, `check_run`, `check_suite` and `workflow_run` whether or not a subscription exists (`reviewTargetOf`), and from `poll` when it sees a new comment or a new CI verdict. `ReviewService.runAction` fires it after an action succeeds. `useWorktreeReview` refetches on the event for its worktree, and `PullRequestPanel` polls every 30 s while checks run and every 180 s otherwise, as a fallback for a hub with no webhook. Mobile keeps its own polling. Tests: `apps/hub/tests/review-changed-signal.test.ts`, `apps/web/e2e/pr-checks-review-signal.spec.ts`.
- The worktree card's PR badge (`dashboard/components/PullRequestBadge.tsx`) is stored by `branch-status-poller.ts` in the core. The batched query also returns each branch's PR (open first, then the latest merged, then the latest closed; on the default branch only an open one), stored in `branch_statuses.ci_pr`. The badge is the PR number colored by CI state: red failing, yellow pending or running, green passed, gray with no checks or only cancelled ones, violet merged, struck-through gray closed. A branch without a PR shows the older CI icon, or nothing without checks. Hovering or keyboard focus opens a popover with the title, status, "Open on GitHub" and "Copy link"; a click opens the Checks tab (`dashboard/lib/checks-tab.ts`). The poller queries on its first tick too. It asks `pluginHost.branchStatusProviderFor(repo)` for one `getBranchStatuses` call per repo and checkout (a `BranchStatusProvider` in `plugin-api`), and the GitHub plugin's batched GraphQL query (`plugins/github/src/server/branch-query.ts`) runs `gh` through the core's `ghRunner`, which honors `BAND_GH_BIN`. With the GitHub plugin in `plugins.disabled` the poller never runs `gh`, so rows show neither the PR badge nor the CI icon. Step 1 of the plan's migration (the badge in the plugin) is done; the poller keeps the cadence, battery rules and the once-per-failure log throttle.
