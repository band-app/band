---
paths:
  - "**/DevicesSettings.tsx"
  - "**/HostsSettings.tsx"
  - "**/PairingDialog.tsx"
  - "**/dashboard/lib/pairing-options.ts"
  - "**/src/mcp/server.ts"
  - "**/start-server.ts"
  - "apps/hub/src/server/api/pairing/handler.ts"
  - "apps/hub/src/server/api/trpc.ts"
  - "apps/hub/src/server/infra/db/queries/tokens.ts"
  - "apps/hub/src/server/services/_utils/pairing-addresses.ts"
  - "apps/hub/src/server/services/_utils/vault-crypto.ts"
  - "apps/hub/src/server/services/token-service.ts"
  - "apps/hub/tests/device-pairing.test.ts"
  - "apps/hub/tests/remote-host.test.ts"
  - "apps/mobile/src/lib/pairing.ts"
  - "apps/mobile/tests/pairing.test.ts"
  - "apps/web/e2e/settings-devices.spec.ts"
---

# Architecture: hub tokens

The hub authenticates with revocable tokens in the `tokens` table (`services/token-service.ts`, `infra/db/queries/tokens.ts`). Only a SHA-256 of a token is stored, and no log line carries one.

- Device tokens (`bdt_…`) are for UIs and the CLI. The auth middleware and the WebSocket upgrade in `start-server.ts` accept any live device token (not revoked, not expired) as a Bearer header, the `band_token` cookie, a `?token=` link login, or the `band-token.<token>` subprotocol. `settings.tokenSecret` is the device token with id `shared`, re-synced at every boot (a changed secret replaces its hash). `tokens.revoke` refuses it, because the desktop app and the CLI read it from `settings.json`. A device token has an `admin` flag (default false). The shared token is admin, and `tokens.createDevice` / `band tokens create-device --admin` makes others. Every `tokens.*` procedure uses `adminProcedure` (`api/trpc.ts`) and answers 403 to a non-admin token; the token that authenticated a request is resolved in `start-server.ts` (`requestIsAdmin`) for both the HTTP and the WebSocket tRPC handlers, and dev mode, which has no auth, counts as admin. `workers.list` is readable by any device token. Revoking any other token also destroys the sockets it opened. SSE streams are not tracked and last until the client reconnects. Dev mode still runs with no auth.
- Pairing (`device_pairing` kind, `bdp_…`, `TokenService.pairing` and `exchangePairing`). `tokens.createUnpairedDevice` makes a device with a secret nobody holds, and `tokens.pairing { tokenId, regenerate? }` returns a one-time code bound to that device row (`tokens.device_id`). It lasts 15 minutes (`BAND_PAIRING_TTL_MS`, read on every code) and works for one exchange, spent by a guarded SQL update. The pending code is kept sealed in `tokens.sealed` (AES-256-GCM with the vault key, the row id as authenticated data, `services/_utils/vault-crypto.ts`) so Connect details can show the same link again. The seal is cleared when the code is spent, and the hash is what lookups use. `POST /api/pair/exchange {code}` (`api/pairing/handler.ts`, answered before the device-token check) replaces the device's secret with a new one (same id, label and admin flag), closes its sockets, answers `{ token, deviceId, label, admin }` and sets the `band_token` cookie. A refusal is 401 with one message for every reason. `GET /?pair=<code>` serves a small page that makes that POST, so a link preview does not spend the code. `?token=bdt_…` links still work. `tokens.revoke` of a device deletes its row and its pairing codes, and `tokens.list` deletes revoked or expired device rows first. `tokens.pairingAddresses` returns `BAND_PUBLIC_URL`, the hub machine's interfaces (`services/_utils/pairing-addresses.ts`: no loopback, `fe80::/10` or `198.18.0.0/15`, ordered Tailscale, IPv4, IPv6, then bridges by name) and `settings.pairingAddresses`, which `tokens.addPairingAddress | removePairingAddress` edit. A custom address is checked to be an http(s) URL and not probed. The Connect details dialog is `PairingDialog.tsx`, the choices are built by `dashboard/lib/pairing-options.ts`, and the mobile app exchanges codes in `apps/mobile/src/lib/pairing.ts`. Tests: `apps/hub/tests/device-pairing.test.ts`, `apps/web/e2e/settings-devices.spec.ts`, `apps/mobile/tests/pairing.test.ts`.
- Worker tokens: `tokens.issueWorkerBootstrap` creates a `hosts` row (`h-<12 hex>`, offline) and a one-time bootstrap token (`bwb_…`, 1 hour by default, 7 days at most) whose `host_id` is the worker id. `TokenService.authenticate` has the shape `LinkServer` takes: a live session token (`bws_…`) for the hello's workerId passes as `token` or `sessionToken`, anything else must be a bootstrap token for that workerId, which is exchanged once (the update that spends it is guarded in SQL) for a session token. A wrong workerId doesn't spend the token. Refusals reach the worker as one generic reason. `/api/workers/exchange` and `/api/workers/connect` call it (see Architecture: remote workers), and `apps/hub/tests/remote-host.test.ts` covers the exchange and `authenticate` through them. Session tokens aren't rotated yet.
- `tokens.*` is left out of the MCP endpoint (`src/mcp/server.ts`), so an agent can't mint or list tokens, and neither is `workers.*` (nor its alias `hosts.*`). `tokens.current` (any device token) returns the caller's own token id and admin flag, never a secret. The UI is Settings > Devices (`DevicesSettings.tsx`, admin only: Add device shows a sign-in link, QR code and token once; Revoke asks for confirmation on the session's own token) and Settings > Workers (`HostsSettings.tsx`, worker tokens). The CLI is `band tokens list | create-device | revoke`. Tests: `apps/web/e2e/settings-devices.spec.ts`.
