---
paths:
  - "**/after-pack.mjs"
  - "**/electron-builder.yml"
  - "**/ipc/worker.ts"
  - "apps/desktop/src/main/services/this-computer-worker.ts"
  - "apps/desktop/tests/this-computer-worker.test.ts"
  - "apps/web/e2e-desktop/desktop-this-computer-worker.spec.ts"
  - "apps/web/e2e-desktop/fixtures/fake-launchctl.mjs"
  - "apps/worker/dist-desktop/**"
  - "apps/worker/scripts/build-desktop.mjs"
  - "docs/install.md"
---

# Architecture: this computer as a worker

A desktop app connected to a remote hub can make its Mac a worker (`apps/desktop/src/main/services/this-computer-worker.ts`, `ipc/worker.ts`, IPC `worker_status | worker_add | worker_remove | worker_switch_bundled | worker_dismiss_prompt`). Docs: `docs/install.md` (This Mac, from the desktop app).

- The worker ships in the app as `Resources/worker` (`apps/worker/scripts/build-desktop.mjs` writes `apps/worker/dist-desktop`, an `extraResources` entry in `electron-builder.yml`): the worker and terminal daemon bundles with every pure-JS dependency inlined, the ACP adapters in `agents/`, and `node_modules` with only node-pty and ripgrep. `after-pack.mjs` deep-signs it like `Resources/web`. The service runs it with the app's executable and `ELECTRON_RUN_AS_NODE=1`, the way the hub already runs, so no Node install is needed and an app update replaces it.
- The launchd label, plist and 0600 token handling are the worker's own: main runs the bundled `band-worker install-service | uninstall-service` with the token in the child's environment only, so the npm and desktop paths write one layout. `install-service` adds `ELECTRON_RUN_AS_NODE=1` to the plist when it runs under Electron. `BAND_LAUNCHCTL_BIN` replaces `launchctl` for the worker's service code and for main (tests point it at `apps/web/e2e-desktop/fixtures/fake-launchctl.mjs`).
- Main asks the hub for the bootstrap token (`tokens.issueWorkerBootstrap` with the admin token it holds for the remote hub), installs, and polls `workers.list` until the worker is online (60 s). A failure uninstalls and removes the worker row again, so Retry starts clean. Remove uninstalls, waits for the worker to go offline, then `workers.remove`.
- The prompt shows only for a remote hub with no service installed and no answer saved in `~/.band/desktop-worker.json` (`answered` per hub URL). A service installed by npm is detected by its plist not pointing into `Resources/worker`, and Switch reinstalls it from the bundle with the same worker id, name, labels, roots and state dir. On the first start after an update main runs `launchctl kickstart -k` (the file's `serviceVersion`).
- Tests: `apps/desktop/tests/this-computer-worker.test.ts` and `apps/web/e2e-desktop/desktop-this-computer-worker.spec.ts` (real app, real hub, real bundled worker, fake launchctl; the packaged job also checks the plist points into the app bundle). `launchDesktop({ answeredWorkerPrompt })` marks hubs as answered for specs that are not about the prompt. Not done yet: LSP servers in the bundled worker, Linux and Windows.
