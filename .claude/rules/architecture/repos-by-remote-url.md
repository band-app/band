---
paths:
  - "**/AddRepoDialog.tsx"
  - "**/RepoHostsFields.tsx"
  - "**/RepoSettingsPage.tsx"
  - "**/RepoWorkers.tsx"
  - "**/ReposOverview.tsx"
  - "**/repo-avatar-service.ts"
  - "**/repo-page-ui.tsx"
  - "**/repo-service.ts"
  - "**/repos-url-migration.test.ts"
  - "**/sync-service.ts"
  - "**/worktree-service.ts"
  - "apps/cli/tests/integration.rs"
  - "apps/hub/tests/repos-by-url.test.ts"
  - "apps/web/e2e/repos-add-repo.spec.ts"
  - "apps/web/e2e/settings-repos.spec.ts"
  - "apps/worker/src/methods-basic.ts"
  - "docs/glossary.md"
  - "packages/shared/src/remote-url.ts"
  - "packages/shared/tests/remote-url.test.ts"
---

# Architecture: repos by remote URL

A repo on the hub is `{name, remoteUrl, defaultBranch}` (`repos.remote_url`, `repos.remote_key`). Each worker maps the URL to a folder, so the hub needs no checkout. The terms are in `docs/glossary.md` (Repo mapping).

- Identity (`packages/shared/src/remote-url.ts`): `parseRemoteUrl` and `normalizeRemoteUrl` give one key for `git@host:o/r.git`, `ssh://`, `https://` and `git://` spellings, with or without `.git`, with the host lowercased. A local path or `file://` URL keys as `file:///abs/path` (tests use local bare repos as remotes). `stripUrlCredentials` removes web userinfo and any password, and the hub stores and logs only the stripped URL.
- `repos.path` stays a non-null column because SQLite cannot relax it without rebuilding the table that `worktrees` cascades from. `""` means the hub holds no checkout on its own machine (the `local` worker), and every reader of `repo.path` treats it as absent (`sync-service.ts`, `repo-service.ts`, `repo-avatar-service.ts`). A repo with `remoteUrl` and no path is the normal case on a headless hub. `setHostPath` for `local` also sets `repos.path`.
- Workers: `Worker.repos` (`HostRepos`, `packages/worker-api`) has `inspect(path)` (git root, origin URL without credentials, default branch from `origin/HEAD`), `ensure({remoteUrl, defaultBranch})` (the mapped folder while it exists, else `git clone` to `~/band/repos/<owner>/<name>`, or `BAND_REPOS_DIR` / the worker's `--repos-dir`, with one clone shared by concurrent calls), `map`, `unmap`, `list` and `addRoot`. `Worker.fs.browse(path?)` lists directories for the picker. `LocalRepos` (`packages/worker-local/src/repos/worker-repos.ts`) implements them. A worker keeps the table in `<state dir>/repos.json`, the hub's local worker in `<BAND_HOME>/repo-mappings.json`. `worker.info` carries `repoMappings`, and `WorkerLinkService.onConnected` copies them into `repo_hosts`, the hub's cache. Worker methods `repos.*` and `fs.browse` live in `apps/worker/src/methods-basic.ts`. They may look under the worker's home as well as its roots, but `repos.addRoot` is the only way to add a root (saved in `<state dir>/roots.json` and served again at the next start), and the hub calls it only after the UI confirmed (`addRoot: true`).
- Hub: `repos.addFromWorker { hostId, path, addRoot?, name? }` (admin, left out of the MCP endpoint) inspects the folder on the worker, answers PRECONDITION_FAILED with `OUTSIDE_ROOTS:` for a folder outside the roots until `addRoot` is true, creates the repo (or records the mapping on the repo that already has that remote), and maps the folder on the worker. `repos.addByUrl { remoteUrl, defaultBranch?, ... }` resolves the branch with `git ls-remote --symref` on the local worker or an online worker, then the GitHub API when the vault has a git credential for github.com (`BAND_GITHUB_API_URL` overrides the API base). `workers.browse { hostId, path? }` is admin only. A second repo with the same remote key is a 409. `worktrees.create` calls `checkoutOn` (`worktree-service.ts`): a caller's `hostRepoPath` (recorded, and mapped on the worker), else the folder the hub last saw while it still exists on the worker, else `worker.repos.ensure`. A repo with no remote can only run on a worker that holds it. `RunnerService.repoUrls` hands the hooks the stored URL as `BAND_REPO_URLS`.
- Boot (`RepoService.backfillRemotes`, run by `runFirstTimeSetup` after the first sync, which repairs repo kinds first): a repo with a path and no key reads its `origin` from the hub's checkout and stores it, and the folder goes into the local worker's mapping. It is safe on every boot. The migration `repo_remote_url` only adds columns.
- UI: a repo is added from the "+" in the sidebar's Repos panel header (or its empty state), with the form in `AddRepoDialog.tsx`: a worker folder browser (breadcrumbs, a filter, and a preview of the remote URL and branch from `repos.inspectFolder` before anything is added, with a note when the folder has no remote and so stays on that worker), confirmation outside the roots, and By URL showing the default branch `repos.resolveRemote` read. With no worker online it shows a notice linking to Settings > Workers and still offers By URL. The desktop app's native folder button shows only for the hub's local worker when the hub URL is loopback. There is no hub-side path probe (`repos.checkPath` is gone). Settings > Repos is an overview list with no add (`ReposOverview.tsx`: each repo's name, remote and, for a limited repo, its workers; a filter that has focus and opens the first match on Enter; a worker filter) and one page per repo (`RepoSettingsPage.tsx`, laid out with `repo-page-ui.tsx`): label, remote, default branch, workers (`RepoWorkers.tsx`: All workers or Only these, "Add worker…" in a dialog with a filter, a Primary switch and Remove per worker, each change saved at once; Only these on a repo whose checkpoints follow the default asks whether to keep them, because turning them off deletes them; a worker the repo is no longer allowed on stays listed, marked), agent login overrides, environment, checkpoints and auto-continue, the default browser profile, the MCP servers and cronjobs that reach the repo, and Remove once the repo has no worktrees. The repo pages have no Save button. The Add repo dialog keeps `RepoHostsFields.tsx`. Tests: `apps/web/e2e/settings-repos.spec.ts`. CLI: `band repos add --url <url> [--branch]`, `band repos add --from <worker> <path> [--add-root]`, and `band repos list` shows the URL and the clones.
- Tests: `packages/shared/tests/remote-url.test.ts` (node:test), `apps/hub/tests/repos-by-url.test.ts` (real hub, real worker, local bare repos as remotes, runner hook env), `repos-url-migration.test.ts` (seeded pre-change DB, then a real boot), `apps/web/e2e/repos-add-repo.spec.ts` (the Repos panel's Add repo, with a real worker), `repos_add_*` in `apps/cli/tests/integration.rs`.
- Not done yet: GitHub App token source for the clone, pruning a stale `repo_hosts` row when the worker's folder disappears (the next `ensure` repairs it), importing a plain worker folder's existing worktrees, and a placement picker.
