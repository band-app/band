---
paths:
  - "**/RepoEnvironment.tsx"
  - "**/config.json"
  - "**/environment-build-auto.test.ts"
  - "**/environment-build-docker.test.ts"
  - "**/environment-remote.test.ts"
  - "**/process/tools.ts"
  - "apps/cli/tests/integration.rs"
  - "apps/hub/src/server/api/environment/router.ts"
  - "apps/hub/src/server/services/environment-build-service.ts"
  - "apps/hub/src/server/services/environment-service.ts"
  - "apps/hub/tests/environment-build.test.ts"
  - "apps/hub/tests/environment.test.ts"
  - "apps/hub/tests/fixtures/docker-stub-bin.mjs"
  - "apps/web/e2e/settings-repo-environment-image.spec.ts"
  - "apps/web/e2e/settings-repo-environment.spec.ts"
  - "docs/agent-environments.md"
  - "packages/environment/**"
  - "packages/environment/src/image.ts"
  - "packages/environment/tests/**"
  - "packages/worker-api/src/contract.ts"
---

# Architecture: agent environments

A repo declares its environment in `.band/environment.json` (format and relation to devcontainer and `config.json`: `docs/agent-environments.md`). `packages/environment` (`@band-app/environment`) holds the zod schema, the parser (`parseEnvironment`, `validateEnvironment`), the `requires` range matcher (`satisfies`, `unmetRequirements`) and `scriptFor`. It touches no file system. Unknown keys are errors with the key path, and a `build.devcontainer` or `build.dockerfile` path must stay inside the repo and exist.

- `HostScripts.environment` reads and validates the file on the worktree's worker (worktree first, then the repo checkout) and never rejects. `HostScripts.command` asks it first: a valid file's `install` then `start` is the setup command and its `teardown` is the teardown command, otherwise `.band/config.json` answers. A file with problems is logged and skipped. `WorktreeScriptService.startSetup` opens the file's `terminals` once setup exits 0. Remote worktrees go through the worker's `scripts.environment` call.
- `HostInfo.tools` (`node`, `python`, `go`, `pnpm`, `uv`, `docker`, `git`, from `process/tools.ts`, cached 60 s) comes back in `worker.info` and in the worker's hello (`Hello.tools`, optional). The hub stores it in `workers.info`, and `workers.list` returns it as `tools`.
- `environment.forRepo` and `environment.validate` (`api/environment/router.ts`, `services/environment-service.ts`) back the Environment section of a repo's page in Settings > Repos (`RepoEnvironment.tsx`) and `band env validate`. They read on the hub's machine. `validate` takes a path, so the MCP endpoint leaves it out, and the relay refuses both because they are not in `RELAY_PROCEDURES`.
- Not done yet: placement by the repo's own `requires` (placement takes `requires` from the create call), and using `services` and `secrets`. The `docker` runner hook uses `isolation` and `resources` (see Architecture: runners).
- Images (`services/environment-build-service.ts`, `environment_builds` table, `environment.imageStatus` / `environment.build`, `band env build | status`, the Image in the Environment section of a repo's page in Settings > Repos; how they are built and cached: `docs/agent-environments.md`). The key is `imageKey` in `packages/environment/src/image.ts`, a SHA-256 over git object hashes at `origin/<default branch>` (the environment file, the Dockerfile or devcontainer and its directory, root lockfiles) and the worker base image ID. The build exports the commit with `git read-tree` and `checkout-index` (no worktree is registered), builds layer 2, adds layer 1 with a generated Dockerfile, runs `install` in a created container with `docker cp` and `docker commit`, and pushes when `environmentBuilder.registry` is set. A ready row for the key whose image still exists on the builder worker is a cache hit. The newest ready row is the repo's current image, and a failed build never replaces it. `environmentBuilder.hostId | registry | workerImage` in settings pick the builder worker (default `local`). Every command runs through `Worker.exec` with credential-like and `BAND_*` variables blanked (`scrubEnv`). `BAND_DOCKER_BIN` and `BAND_DEVCONTAINER_BIN` override the binaries on the local worker and are read on every call, which is how tests run `apps/hub/tests/fixtures/docker-stub-bin.mjs`. `environment.build` is admin only, left out of the MCP endpoint and refused by the relay. The auto trigger (`BAND_ENVIRONMENT_BUILD_POLL_MS`, default 60 s) rebuilds only repos that have a build already. Not done yet: snapshots, a settings page for `environmentBuilder`, and pruning old images.
- Tests: `packages/environment/tests` (node:test, pure functions with no state to fake, which is why they are not integration tests), `apps/hub/tests/environment-build.test.ts`, `environment-build-auto.test.ts` (docker stub) and `environment-build-docker.test.ts` (real Docker, skipped with no daemon), `apps/web/e2e/settings-repo-environment-image.spec.ts`, the `env_build_*` tests in `apps/cli/tests/integration.rs`, the contract suite in `packages/worker-api/src/contract.ts` against local and remote workers, `apps/hub/tests/environment.test.ts` and `environment-remote.test.ts` (real worker), the `env_validate_*` tests in `apps/cli/tests/integration.rs`, and `apps/web/e2e/settings-repo-environment.spec.ts`.
