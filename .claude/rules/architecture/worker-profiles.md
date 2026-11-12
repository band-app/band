---
paths:
  - "apps/hub/src/server/services/worker-profile-service.ts"
  - "apps/hub/src/server/services/_utils/worker-profile.ts"
  - "apps/hub/src/server/api/worker-profiles/router.ts"
  - "apps/web/src/dashboard/components/settings/WorkerProfilesSettings.tsx"
  - "apps/hub/tests/worker-profiles.test.ts"
  - "docs/worker-profiles.md"
---

# Architecture: worker profiles

A profile (`settings.workerProfiles[]`, shape in `services/_utils/worker-profile.ts`) fixes how a worker is provisioned and which vault credentials it may receive (guide: `docs/worker-profiles.md`). It names vault git items (by name) and agent logins (by label or id) and never holds a secret.

- Storage and checks: `WorkerProfileService` reads the array on every call and parses each entry with `workerProfileSchema`. An invalid or duplicate entry goes to `list().invalid` and is never applied. `create | update | remove` validate first (schema, reserved env names, `checkRepoUrl` and `checkStartCommand` from `_utils/provision-checks.ts`, vault items of kind `git`, agent logins) and write through `settingsService.update`. A rename is refused. `remove` is refused while a `hosts.profile` points at the name. The worker's profile is `hosts.profile` (migration `worker_profiles`, also `host_provisions.profile`), written only by `setHostProfile`, which also sets the worker's trust to the profile's.
- API: `workerProfiles.list | create | update | delete | setWorkerProfile` use `adminProcedure`, are refused by the relay (`NEVER_FOR_AGENTS`, `workerProfiles.`) and left out of the MCP endpoint. `settings.get` returns `workerProfiles` only to an admin, and `settings.update` refuses it to anyone else (the relay's `AGENT_SETTABLE_SETTINGS` allow-list already cuts both). `workers.list` returns each worker's `profile` name, which the relay's `agentHostView` leaves out.
- Provisioning: `provisioning.createCommand { profile }` uses the profile's repo (replacing `settings.provisioning`), stores the name on the code, and `exchange()` reads the profile again: it creates the worker with the profile's trust, labels and name through `issueWorkerBootstrap`, and adds `ownChats=1` and `env=KEY=VALUE` lines to the answer. A profile that vanished before the exchange refuses it. The script passes `--own-chats` and `--env` to `install-service`, exports the env to the start command, and fails with a message when an older `band-worker` reports an unknown option. `install-service --env` (`apps/worker/src/service.ts`, `parseServiceEnv`) accepts only `BAND_WORKER_*`.
- Credential policy: `policyFor(hostId)` returns null (today's rules) for a worker with no profile or a profile with no `credentials`, the profile's lists otherwise, and the empty policy for a profile that no longer resolves. `GitCredentialService.handle` passes `onlyItems` to the vault lookup. `handleGhToken` answers from `findGitTokenByName(policy.gh)` without the opt-in, or refuses. `AgentLoginService.resolve` and `pickedId` take `hostId` and skip a login the policy does not list. Callers: `withAgentLogin`, `launchForOwner`, `TerminalService.spawn`.
- CLI: `band workers provision | profiles | set-profile`. UI: Settings > Workers > Profiles (`WorkerProfilesSettings.tsx`), the profile select in `ProvisionHostForm.tsx` and in `WorkerDrawer.tsx`.
- Tests: `apps/hub/tests/worker-profiles.test.ts` (real hub and worker), the profile cases in `provisioning.test.ts`, the relay probes in `remote-relay.test.ts`, `apps/worker/tests/service.test.ts`, `apps/web/e2e/settings-worker-profiles.spec.ts`, `workers_profiles_provision_and_set_profile` in `apps/cli/tests/integration.rs`.
- Not done yet: rewriting an existing worker's service when its profile changes, profiles for runner-started workers.
