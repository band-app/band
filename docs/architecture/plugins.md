# Plugins

Status: phase 1 and the first steps of phase 2 are built. Phases 3 and 4 are planned.

## Decision

Band has two tiers of plugin, and the core keeps every pixel of UI that two plugins could share.

- Tier 1 is bundled, in-process, server-side code written by the Band team (`plugins/github`). It implements provider interfaces the core defines and returns plain JSON. It draws nothing.
- Tier 2 is extensions: third-party code that runs out of process and draws its own panel inside a sandboxed iframe. Nothing of tier 2 exists yet, and Band loads no third-party code today.

A provider returns data, and the core draws it. A plugin never imports Band internals, so a provider can move out of process later without changing its interfaces.

## Phases

1. Import boundary. A Biome `noRestrictedImports` override for `plugins/**` allows only `@band-app/plugin-api`, `@band-app/ui` and the plugin's own dependencies. Done: `pnpm lint` fails on an import of `apps/*` or any other `@band-app/*` package.
2. Data-only providers. The core owns the screens and the plugin supplies facts. Done: the Checks tab (`apps/web/src/components/review`) is drawn by the core for any `ReviewProvider`, and review actions are data. The PR badge and CI icon come from a `BranchStatusProvider`, and the batched GraphQL query lives in `plugins/github`. The change signal is built: a plugin calls `api.reviews.changed({ repo, branch?, number? })` and the core sends a `review-changed` status event so open Checks panels refetch (the core's GitHub webhook and poll services and `reviews.runAction` fire it today; the GitHub plugin will fire it itself once subscriptions move into it). Next: subscription sources moved into the plugin.
3. Worker half and panels. A plugin gets a part that runs on a worker, a stream channel to the hub, and a `worktree.panels` slot for views such as a simulator. The panel is the core's, the stream is the plugin's.
4. Extensions. Out-of-process plugins with an iframe runner and a permission model. Needs its own design before any code.

## Data-only providers

`packages/plugin-api/src/providers.ts` defines what crosses the boundary. Everything is plain JSON: no functions, no components, no class instances.

- `ReviewProvider` returns a `ReviewInfo` for a branch (title, state, checks, reviewers, discussion, `actions`) plus its display `name` and a `fixHint`. The core uses `name` in copy ("Open on GitHub", "Older comments are on GitHub") and `fixHint` in the Fix prompt it sends an agent.
- `ChecksProvider` returns the checks for a ref that has no review.
- `reviews.provider { worktreeId }` tells the web app which provider serves a worktree without running a forge command. The Checks tab shows only when it returns one.

## Actions as data

A review lists what a person can do to it in `ReviewInfo.actions`. An action has an `id`, a `label`, an `icon` from a fixed set (`merge`, `rerun`, `ready`), a `placement`, optional `args`, optional `confirm` text and an optional `disabledReason`. The core draws each one and sends it back through `reviews.runAction { worktreeId, actionId, args }`, which calls `ReviewProvider.runAction(repo, number, actionId, args, ctx)`.

- Placement `header` shows in the panel header. A `header` action with the `rerun` icon appears in the failing checks banner. Placement `check` belongs to one check row, and `args.checkId` names the check.
- Actions with the same `group` form one split button, the first being the default. GitHub offers one `merge` action per method (`args.method` is `squash`, `merge` or `rebase`) in group `merge`. That keeps the label, the confirm text and the disabled reason of each method in the provider's hands.
- GitHub also offers `rerun-job` (placement `check`, args `runId`, `jobId`, `checkId`), `rerun-failed` (placement `header`, one per run with a failure, args `runId`) and `ready` on a draft pull request (`gh pr ready`).
- An action is identified by its `id` and `args`, so several actions may share an `id`.
- The provider validates `args` and rejects unknown ids with the forge's own message. The hub does not check that an action was offered.
- `ChecksReport.actions` carries the re-run actions of its checks, so a branch with no review still has re-run buttons. A review's `actions` repeat them, and the hub runs re-run actions without requiring an open review.
- `reviews.merge` and `reviews.rerunChecks` stay as thin wrappers over `runAction`, because the mobile app calls them. The mobile app does not draw actions yet.

## Comparison with VS Code's SCM API

VS Code lets an extension push imperative UI into the core: it creates a source control, resource groups and commands, and the editor renders them. Band takes the same split (the host draws, the extension supplies content) with one difference. The VS Code API is a set of objects with methods and events that live in the extension host. Band's providers answer a request with a JSON document, so the same interface works in process today and over a link to a worker or an iframe later. The cost is that the core must know every kind of thing it can draw, which is why the icon set and the placements are closed lists.

## Where the code is

- Contract: `packages/plugin-api`.
- GitHub provider: `plugins/github/src/server` (`actions.ts` builds the actions and the `gh` arguments).
- Hub: `services/review-service.ts`, `api/reviews/router.ts`, and the `gh` subcommand allowlist in `services/_utils/worktree-gh.ts`.
- Web: `apps/web/src/components/review`, and the tab list in `apps/web/src/plugins/use-plugin-slot.ts`.
- Tests: `apps/hub/tests/pr-checks.test.ts`, `apps/web/e2e/pr-checks-panel.spec.ts`, `apps/web/e2e/pr-checks-panel-disabled.spec.ts`.
