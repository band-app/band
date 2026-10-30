# Releasing

This page is for contributors. It is not part of the public docs site.

A release publishes the desktop DMGs, the Homebrew cask, `@band-app/server` and `@band-app/worker` on npm, and the two images `ghcr.io/band-app/band-hub` and `ghcr.io/band-app/band-worker`. Each image is tagged with the release version and `latest`. Pull requests that change `docker/`, `deploy/compose/` or the release workflows build both images for both architectures without pushing them (`.github/workflows/images.yml`).

## How the release workflow runs

`release.yml` is started by hand (Actions > Release > Run workflow) and has these jobs:

1. **Build (macOS).** Checks the gate, determines the version, builds the UI and hub, then builds, signs and notarizes the DMG. It uploads the DMGs, the zips, `latest-mac.yml`, the hub bundle and the built UI as artifacts.
2. **CLI (Linux).** Builds the `band` CLI at the release version on an x64 and an arm64 runner.
3. **Publish (Linux).** Downloads those artifacts, pushes the tag, creates the GitHub release, publishes the three `@band-app/worker-cli-<platform>-<arch>` packages (the `band` CLI for darwin-arm64, linux-x64 and linux-arm64, built by the macOS job and a `cli-linux` matrix) and then `@band-app/server` and `@band-app/worker` to npm (both pin those CLI packages as optional dependencies), and updates the Homebrew cask. The tag is pushed only after the signed build succeeded.
4. **Images.** Builds the two images from the tag.
5. **Mobile.** Runs after Publish. Builds the iOS app with the release version and submits it to TestFlight, and builds the Android preview APK, both through EAS with the `EXPO_TOKEN` secret. The `mobile` input is `auto` (only when `apps/mobile`, `packages/client`, `packages/shared` or `pnpm-lock.yaml` changed since the previous release tag), `always` or `skip`. The build links go in the job summary and the release notes. A failure here leaves the rest of the release shipped. App Store review stays manual.

Build and Publish use the `production` environment, so the signing, npm and tap secrets stay with the jobs that need them.

Lint and tests do not run in the release. The Build job runs `scripts/check-ci-green.sh <sha>`, which asks the GitHub API for a completed `ci.yml` run on the exact commit being released with conclusion `success` (every job succeeded or was skipped, and a re-run that succeeded counts). Runs of the `pull_request` event are ignored, because they test a merge ref. Without such a run the job fails and names the commit and the state of each `ci.yml` run it found. Start releases only after CI on main has finished.

To release a commit that CI has not passed, run the workflow with `force_tests` set to true. The gate is skipped, and the job builds the CLI, runs lint, and runs the server, web and CLI tests before building the DMG, as releases did before the gate.
