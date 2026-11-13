---
paths:
  - "apps/hub/src/server/services/worker-profile-service.ts"
  - "apps/hub/src/server/services/_utils/worker-profile.ts"
  - "apps/hub/src/server/api/worker-profiles/router.ts"
  - "apps/web/src/dashboard/components/settings/WorkerProfilesSettings.tsx"
  - "apps/hub/tests/worker-profiles.test.ts"
  - "apps/hub/src/server/services/worker-secrets-service.ts"
  - "apps/hub/src/server/infra/db/legacy-credentials.ts"
  - "apps/worker/src/secrets.ts"
  - "docs/worker-profiles.md"
---

# Architecture: worker profiles

A profile (`settings.workerProfiles[]`, shape in `services/_utils/worker-profile.ts`) fixes how a worker is provisioned and which vault items it receives as environment variables or files (guide: `docs/worker-profiles.md`). It names vault items and never holds a secret. Band has no git, `gh`, `glab` or Claude logic here.

- Storage and checks: `WorkerProfileService` reads the array on every call and parses each entry with `workerProfileSchema`. An invalid or duplicate entry goes to `list().invalid` and is never applied. `create | update | remove` validate first (schema, reserved env names, `checkRepoUrl` and `checkStartCommand` from `_utils/provision-checks.ts`, secret mappings) and write through `settingsService.update`. A rename is refused. `remove` is refused while a `hosts.profile` points at the name. The worker's profile is `hosts.profile` (migration `worker_profiles`, also `host_provisions.profile`), written only by `setHostProfile`, which also sets the worker's trust to the profile's.
- API: `workerProfiles.list | create | update | delete | setWorkerProfile` use `adminProcedure`, are refused by the relay (`NEVER_FOR_AGENTS`, `workerProfiles.`) and left out of the MCP endpoint. `settings.get` returns `workerProfiles` only to an admin, and `settings.update` refuses it to anyone else (the relay's `AGENT_SETTABLE_SETTINGS` allow-list already cuts both). `workers.list` returns each worker's `profile` name, which the relay's `agentHostView` leaves out.
- Provisioning: `provisioning.createCommand { profile }` uses the profile's repo (replacing `settings.provisioning`), stores the name on the code, and `exchange()` reads the profile again: it creates the worker with the profile's trust, labels and name through `issueWorkerBootstrap`, and adds `ownChats=1` and `env=KEY=VALUE` lines to the answer. A profile that vanished before the exchange refuses it. The script passes `--own-chats` and `--env` to `install-service`, exports the env to the start command, and fails with a message when an older `band-worker` reports an unknown option. `install-service --env` (`apps/worker/src/service.ts`, `parseServiceEnv`) accepts only `BAND_WORKER_*`.
- Secrets: `secrets: [{ item, env } | { item, file, mode? }]` (`_utils/worker-profile.ts`). `item` is a global `api_key` or `env` vault item. `env` matches `^[A-Z_][A-Z0-9_]*$` and is not `PATH`, `HOME`, `USER`, `SHELL` or `BAND_*`. `file` is `~/path` under the worker user's home with no `..`, `mode` an octal string of at most 0700 (default 0600). Duplicate env names or files are refused. `provisioning.tokenItem` clones the provisioning repo over HTTPS.
- Delivery: `WorkerSecretsService` answers `secrets.fetch` on the link. The worker id comes from the link session, so a worker gets only its own profile's mappings, and a worker with no profile gets an empty answer. It sends `secrets.changed` when the profile or a mapped item changes, and records the worker's `secrets.report` (refused files) for the drawer. The `local` worker runs in the hub process and takes none.
- Worker side (`apps/worker/src/secrets.ts`): env values stay in memory and are fetched for every process the worker starts (agents, terminals, worker-owned chats, hub-requested git, gh and exec, clones through the worker), so a rotated item applies to the next process. If the hub is unreachable the last values are used. Files are synced at connect and on `secrets.changed`: temp file created with the final mode, then rename. The worker lists the files it created in `<state dir>/secret-files.json`, never overwrites or deletes any other file (the mapping is refused and reported), refuses a symlink that leaves the home, and deletes its files when a mapping goes away, the profile is set to none, or `band-worker uninstall-service` runs.
- Agents: `workerProfiles.*` and `vault.*` stay admin-only and refused for agents, so an agent cannot list profiles, read mappings or fetch secrets.
- Runners: a runner config (`settings.runners[]`) has an optional `profile`. `runner-service.ts` gives the worker it starts that profile through `setHostProfile`. When the profile maps secrets and the repo has an https remote, the hub sets `BAND_CLONE_BY_HUB=1` and clones through the worker after hello.
- Migration: `legacy-credentials.ts` rewrites old `credentials` (see `credential-vault.md`).
- Min worker version: `MIN_WORKER_VERSION` in `packages/shared/src/versions.ts` is 0.67.0.
- CLI: `band workers provision | profiles | set-profile`. UI: Settings > Workers > Profiles (`WorkerProfilesSettings.tsx`), the profile select in `ProvisionHostForm.tsx` and in `WorkerDrawer.tsx`.
- Tests: `apps/hub/tests/worker-profiles.test.ts` (real hub and worker), the profile cases in `provisioning.test.ts`, the relay probes in `remote-relay.test.ts`, `apps/worker/tests/service.test.ts`, `apps/web/e2e/settings-worker-profiles.spec.ts`, `workers_profiles_provision_and_set_profile` in `apps/cli/tests/integration.rs`.
- Not done yet: rewriting an existing worker's service when its profile changes, tmpfs mounts, an ssh-agent and tool-specific adapters (non-secret tool setup such as a git credential helper or `known_hosts` belongs in the provisioning repo).
