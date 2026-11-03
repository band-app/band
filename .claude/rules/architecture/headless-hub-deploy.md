---
paths:
  - "**/start-server.ts"
  - "apps/hub/tests/headless-hub.test.ts"
  - "deploy/compose/compose.yml"
  - "docs/run-the-hub-on-a-server.md"
---

# Architecture: headless hub deploy

`deploy/compose/compose.yml` runs the hub image with a `band-data` volume for BAND_HOME, a healthcheck that reads the token from `settings.json`, and an optional Caddy `tls` profile. The guide is `docs/run-the-hub-on-a-server.md`, and the CI `docker` job runs the compose file.

- `BAND_ADMIN_TOKEN` sets the shared admin token (`SettingsQueries.resolveAdminToken`) and replaces a stored secret that differs. With none set, the first boot mints one and, when `BAND_PRINT_ADMIN_TOKEN` is true (the Docker entrypoint sets it), prints it once in `start-server.ts`. `BAND_ACCESS_TOKEN` is the entrypoint's older name for `BAND_ADMIN_TOKEN`. The image bakes in no token.
- `BAND_SERVE_UI=false` skips sirv and the shell, so every non-API path answers 404 and a missing UI build doesn't stop the boot. Dev mode ignores it.
- `BAND_ALLOWED_ORIGINS` adds to `BAND_CORS_ORIGINS` and `corsAllowedOrigins`, for both CORS and the WebSocket origin check.
- Tests: `apps/hub/tests/headless-hub.test.ts`.
