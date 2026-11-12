---
paths:
  - "**/app.json"
  - "**/cli-sidecar-path.test.ts"
  - "**/compose.build.yml"
  - "**/images.yml"
  - "**/pnpm-lock.yaml"
  - "**/release.yml"
  - "apps/hub/tests/cli-check.test.ts"
  - "apps/mobile/**"
  - "apps/mobile/.eas/workflows/build.yml"
  - "apps/mobile/scripts/release.mjs"
  - "apps/mobile/tests/release.test.ts"
  - "apps/web/e2e/cli-banner.spec.ts"
  - "apps/web/e2e/settings-hosts.spec.ts"
  - "apps/worker/src/service.ts"
  - "apps/worker/tests/service.test.ts"
  - "deploy/compose/**"
  - "deploy/compose/compose.yml"
  - "docker/**"
  - "docker/Dockerfile"
  - "docker/worker.Dockerfile"
  - "docs/install.md"
  - "packages/client/**"
  - "packages/host-local/src/process/cli-binary.ts"
  - "packages/shared/**"
---

# Architecture: distribution

`release.yml` publishes the DMGs, the Homebrew cask, `@band-app/server` and `@band-app/worker` on npm, and then calls `images.yml`, which builds `docker/Dockerfile` and `docker/worker.Dockerfile` as `ghcr.io/band-app/band-hub` and `band-worker` (amd64 on `ubuntu-latest`, arm64 on `ubuntu-24.04-arm`, pushed by digest and merged into a manifest tagged `<version>` and `latest`). The same workflow runs on a pull request that touches `docker/`, `deploy/compose/` or the release workflows, with nothing pushed. `deploy/compose/compose.yml` pulls `ghcr.io/band-app/band-hub:${BAND_VERSION:-latest}` (`BAND_IMAGE` overrides the whole name), and `compose.build.yml` is the override that builds from the checkout. The CI `docker` job tags its build as `ghcr.io/band-app/band-hub:ci` and runs compose with `BAND_VERSION=ci`. `band-worker install-service | uninstall-service | status` (`apps/worker/src/service.ts`) manage a systemd user unit or a launchd agent, with the token only in a 0600 file under a 0700 `~/.band/worker-service`. `install-service` and `uninstall-service` exit 2 before writing any file when HOME is not the passwd home (`os.userInfo().homedir`) and `launchctl` or `systemctl` is the system binary (no `BAND_LAUNCHCTL_BIN` / `BAND_SYSTEMCTL_BIN`, and found on PATH only under `/bin`, `/sbin`, `/usr/bin`, `/usr/sbin`), because the label is per user and a temp-HOME run would unload the real worker; `--allow-other-home` skips the guard. `detectServiceManager` (`update.ts`) returns null in the same case, so a worker started from an agent shell inside the real service never runs `kickstart` or `systemctl restart`. The `mobile` job runs after `publish` (`apps/mobile/scripts/release.mjs`, tested by `apps/mobile/tests/release.test.ts`): the `mobile` input (`auto`, `always`, `skip`) decides, `auto` shipping only when `apps/mobile`, `packages/client`, `packages/shared` or `pnpm-lock.yaml` changed since the previous `v*` tag. It writes the release version into `app.json`, runs `eas build` for iOS (production, auto-submit to TestFlight) and Android (preview) with `EXPO_TOKEN`, and links the builds in the summary and release notes. The EAS workflow `apps/mobile/.eas/workflows/build.yml` has no push trigger. Tests: `apps/worker/tests/service.test.ts` (the real binary against stub `systemctl`, `loginctl` and `launchctl` on PATH) and `apps/web/e2e/settings-hosts.spec.ts` for the install tabs of Add worker. The guide is `docs/install.md`.

The hub's own `band` CLI (`findCliBinaryAt`, `packages/host-local/src/process/cli-binary.ts`) comes from `BAND_CLI_PATH`, a cargo build, the desktop sidecar, the `@band-app/worker-cli-<platform>-<arch>` package beside the bundle (an optional dependency of `@band-app/server`, pinned by `apps/worker/scripts/cli-packages.mjs --pin` in the release, which publishes the CLI packages first), then PATH. `cli.check` answers `{ status, applicable }`: `applicable` is false on a hub with `BAND_LOCAL_WORKER=off` or for a non-admin token, and the dashboard shows no "Install band CLI" banner then. `cli.install` is admin only. A link whose real path is the binary the hub resolved counts as `Installed`. The hook checks again when the window regains focus, and an install the hub cannot write says "On the hub's server, run: sudo ln -sf ...". The desktop admin dialog runs only for a hub on this Mac. Tests: `apps/hub/tests/cli-check.test.ts`, `cli-sidecar-path.test.ts`, `apps/web/e2e/cli-banner.spec.ts`.
