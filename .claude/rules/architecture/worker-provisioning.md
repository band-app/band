---
paths:
  - "**/ProvisionHostForm.tsx"
  - "**/start-server.ts"
  - "apps/hub/src/server/api/provisioning/handler.ts"
  - "apps/hub/src/server/infra/db/queries/provisions.ts"
  - "apps/hub/src/server/services/_utils/provision-script.ts"
  - "apps/hub/src/server/services/provisioning-service.ts"
  - "apps/hub/src/server/services/ssh-install-service.ts"
  - "apps/hub/src/server/services/_utils/ssh-config.ts"
  - "**/SshInstallForm.tsx"
  - "apps/hub/tests/ssh-install.test.ts"
  - "apps/web/e2e/settings-hosts-ssh-install.spec.ts"
  - "apps/hub/tests/provisioning.test.ts"
  - "apps/web/e2e/settings-hosts-provision.spec.ts"
  - "docs/provisioning.md"
---

# Architecture: worker provisioning

An admin gets a one-line command for a blank Linux or macOS machine (guide: `docs/provisioning.md`): `curl -fsSL <hub>/api/provision/<code>/script | sh`. Settings > Workers > Add worker (`AddWorkerDialog.tsx`, `ProvisionHostForm.tsx`) shows it with the expiry, a "Copy as cloud-init" variant, the live status and the log. Manual install is the dialog's other tab.

- State: `services/provisioning-service.ts` and the `host_provisions` table (`infra/db/queries/provisions.ts`). The code (`bpc_`) and the run token (`bpr_`) are stored as SHA-256 hashes. A row holds the pinned commit, the worker id the exchange created, the state (`pending`, `running`, `failed`, `done`), the exit code and the scrubbed log (last 256 KiB). The status the UI sees is derived: `online` when the worker row is online, else `failed`, `provisioning` (spent), `expired` or `waiting`. The service is on the exempt list of the machine-access Biome override, because it runs `git` and `tar` on the hub's machine and keeps bundle files under `<BAND_HOME>/provisioning/<id>/`.
- Endpoints (`api/provisioning/handler.ts`, answered in `start-server.ts` before the device-token check): `GET /api/provision/<code>/script` (no secret, spends nothing, rendered by `services/_utils/provision-script.ts`), `POST /api/provision/exchange` (spends the code with a guarded SQL update, calls `tokenService.issueWorkerBootstrap`, answers `key=value` lines because the script has no JSON parser), `GET /api/provision/<code>/bundle` and `POST /api/provision/<code>/log[?exit=N]` (both need the run token as a Bearer header). A refusal is one generic 401. The bootstrap token cannot authorize the bundle or log, because the worker spends it before the script finishes.
- `provisioning.createCommand | status | settings | updateSettings` use `adminProcedure`, are left out of the MCP endpoint and refused by the relay (`NEVER_FOR_AGENTS`). The repo is `settings.provisioning { repoUrl, branch, command }`, admin only to read or write. The hub URL must be https, or http on loopback.
- The provisioning repo is fetched when the command is created (`git clone --depth 1` on the local worker, the vault's git credential passed as `GIT_CONFIG_*` `http.extraHeader` in the child's environment only), so a bad URL fails there. The commit is pinned and the files are packed without `.git`.
- With a provisioning repo, `custom_install` runs the start command, then the same steps as `default_install` (`install_worker` pinned to `WORKER_VERSION`, `install-service`, `root_steps`), so the repo owns the machine and Band owns the worker. The start command gets `BAND_WORKER_VERSION` beside the other `BAND_*` variables. If a service file naming this worker id exists and `band-worker status` (from `BAND_WORKER_CMD`, `PATH` or `~/.band/npm`) reports it running when the start command exits, Band skips its own install and service steps, logs that it did, and still runs the root steps (enable-linger, `doctor` fixes).
- The script runs as the normal user and uses `sudo -n` for root steps. `BAND_WORKER_CMD` replaces the installed `band-worker`, `BAND_PROVISION_ROOT_STEPS=off` skips root steps, `BAND_PROVISION_HOME` moves the unpack directory, and `BAND_PROVISION_TTL_MS` (hub, read on every command) changes the one hour life. `BAND_PROVISION_TIMEOUT_MS` (hub, read on every check, default 30 minutes) fails a run whose worker has not said hello since the exchange (`ProvisioningService.settle`, run when a command is read). Production settings read at run time, beyond TEST-1's carve-outs, because the tests cannot install a launchd or systemd unit or touch swap.
- Tests: `apps/hub/tests/provisioning.test.ts` (real hub, the real script under `sh`, the real `band-worker`; a wrapper given as `BAND_WORKER_CMD` starts the worker as a background process in place of a service manager), `apps/web/e2e/settings-hosts-provision.spec.ts`. The script passes `shellcheck`.
- Over ssh: `provisioning.sshHosts | sshInspect | sshInstall` (admin only, under `provisioning.*` so the relay and MCP already refuse them) run `ssh`, `ssh-keyscan` and `ssh-keygen` on a worker the admin picks, through `host.exec` and `host.fs` (`services/ssh-install-service.ts`; the config parser and target check are `_utils/ssh-config.ts`). The web dialog uses this computer's worker when the desktop app has one, else a picker of online workers (`SshInstallForm.tsx`). The target is validated and passed after `--`; ssh runs with `BatchMode=yes` and `StrictHostKeyChecking=yes`. `sshInspect` resolves the target with `ssh -G`, scans its key and compares it with known_hosts: `known`, `unknown` (with fingerprints) or `changed`. `sshInstall` refuses `changed`, refuses `unknown` unless `trustFingerprints` equals the fingerprints it just scanned (then it appends the scanned keys to the worker's known_hosts), creates an ordinary provisioning command and runs its `curl | sh` line over ssh in the background. `ProvisioningService.sshEnded` marks the run failed with ssh's message and a hint when ssh fails, or exits 0 without the script contacting the hub. `BAND_SSH_BIN`, `BAND_SSH_KEYSCAN_BIN` and `BAND_SSH_KEYGEN_BIN` (hub, read on every call) replace the binaries; tests stub the first two.
- Not done yet: Windows, re-provisioning a worker that already joined, creating the VM, ephemeral runners, vault secrets for the start command, the mobile app.
