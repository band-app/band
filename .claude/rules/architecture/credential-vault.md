---
paths:
  - "**/CredentialsSettings.tsx"
  - "**/fixtures/oauth-stub.ts"
  - "**/remote-relay.test.ts"
  - "**/runner-docker.test.ts"
  - "**/subscriptions-github-poll.test.ts"
  - "apps/cli/tests/integration.rs"
  - "apps/hub/src/server/infra/db/queries/vault.ts"
  - "apps/hub/src/server/services/_utils/hub-gh-auth.ts"
  - "apps/hub/src/server/services/_utils/oauth-client.ts"
  - "apps/hub/src/server/services/_utils/vault-crypto.ts"
  - "apps/hub/src/server/services/vault-service.ts"
  - "apps/hub/src/server/services/worker-secrets-service.ts"
  - "apps/hub/src/server/infra/db/legacy-credentials.ts"
  - "apps/worker/src/secrets.ts"
  - "apps/hub/tests/vault.test.ts"
  - "apps/web/e2e/settings-credentials.spec.ts"
  - "docs/runner-hooks.md"
---

# Architecture: credential vault

The hub stores credentials encrypted in `vault_items` (`services/vault-service.ts`, `infra/db/queries/vault.ts`, `services/_utils/vault-crypto.ts`). Kinds are `api_key`, `env` and `oauth`. The `git` kind and its host and path matching were removed: the migration `20261113084052_drop_agent_logins` turns each existing `git` item into an `api_key` item and keeps the value. Scope is `global` or `repo:<name>`, and a name is unique per scope.

- Encryption is AES-256-GCM with a random 12-byte nonce per write and the item id as authenticated data, so a blob copied onto another row fails to decrypt. The key is `BAND_VAULT_KEY` (32 bytes as base64 or 64 hex characters) or, with that unset, `<BAND_HOME>/vault.key` (mode 0600, generated on first use). `band vault rotate-key` (`vault.rotateKey`) re-encrypts every item in one transaction and then replaces the key file. It is refused when the key comes from the environment.
- No API returns a secret. `vault.list` shows metadata (kind, scope, OAuth account, scopes, expiry), and `getSecret` and `getAccessToken` are for hub services only (the MCP proxy and environment `secrets` in later steps). Metadata never holds a secret, and no log line or error message does. `vault.*` uses `adminProcedure`, is left out of the MCP endpoint, and is not in `RELAY_PROCEDURES`, so a worker's agent gets 403.
- OAuth (`services/_utils/oauth-client.ts`): `vault.startOAuth` discovers the server (RFC 9728 protected resource metadata, also from a 401's `resource_metadata`, then RFC 8414 or OpenID metadata), registers a public client with RFC 7591 when the server offers it (otherwise the caller supplies `clientId`), and returns a PKCE (S256) authorization URL with the RFC 8707 `resource`. Endpoints must be https, or http on loopback. The redirect URI is `<redirectBase>/api/oauth/callback`, where `redirectBase` is the origin the UI is served from, `BAND_PUBLIC_URL` or the loopback address.
- `GET /api/oauth/callback` is answered before the device-token check, because the browser that returns may not hold the hub's session. The state is the credential: it is random, held as a SHA-256 in memory, compared in constant time against each pending flow, valid for 10 minutes and used once. A response whose `iss` names another issuer is refused. The UI follows a flow with `vault.oauthStatus`.
- A sweep every `BAND_VAULT_REFRESH_POLL_MS` (default 30 s) refreshes a token that expires within `BAND_VAULT_REFRESH_SKEW_MS` (default 2 minutes), and `getAccessToken` refreshes on demand. Concurrent refreshes of one item share one request. A failed refresh stores `refreshError` in the metadata. Deleting an OAuth item revokes its token at the server (RFC 7009, best effort) before removing the row.
- UI: Settings > Credentials (`CredentialsSettings.tsx`). CLI: `band vault list | put | delete | rotate-key` (`put` reads the value from stdin and refuses `--kind git` with a pointer to worker profiles).
- Tests: `apps/hub/tests/vault.test.ts` (real hub, real local OAuth server in `fixtures/oauth-stub.ts`), the vault probes in `remote-relay.test.ts`, `apps/web/e2e/settings-credentials.spec.ts`, `vault_put_list_delete` in `apps/cli/tests/integration.rs`.
- Delivery to workers is generic and lives in worker profiles (`worker-profiles.md`, `services/worker-secrets-service.ts`, `apps/worker/src/secrets.ts`). A profile maps a global `api_key` or `env` item (never `oauth`) to an environment variable or a file. The vault knows nothing about git, `gh`, `glab` or Claude. `getGlobalSecret` is the hub-side read. A change to an item calls `credential-events.ts`, which makes the secrets service push `secrets.changed` to the workers whose profile maps it.
- Hub GitHub token: setting `hubGithubToken` (a vault item name, Settings > Credentials). `services/_utils/hub-gh-auth.ts` runs the hub's own `gh` (PR polling, webhooks) and the default-branch lookup with the machine's `gh` login or `GH_TOKEN` first, then this item. With neither, the error is "No GitHub credential for gh on this hub ...". The provisioning clone token is `settings.provisioning.tokenItem` (default repo) or the profile's `provisioning.tokenItem`: an HTTPS token with username `x-access-token`, else plain git with the hub machine's auth.
- Removed: agent logins, the worker's git credential helper (`git.credential` RPC), the `gh.token` RPC and `BAND_WORKER_GH_TOKEN`, `--hub-git-credentials-only`. `legacy-credentials.ts` converts old settings once at startup (profile `credentials.gh` to `GH_TOKEN`, agent logins to the variable their kind used, `git` dropped with a log line, `hubGithubToken` set to the broadest github.com git item) before the migration drops the tables.
- The MCP proxy that uses these credentials is below (Architecture: MCP proxy). Environment `secrets` in `.band/environment.json` are separate from profile secrets.
