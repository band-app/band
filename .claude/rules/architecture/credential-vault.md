---
paths:
  - "**/CredentialsSettings.tsx"
  - "**/fixtures/git-http-auth-stub.ts"
  - "**/fixtures/oauth-stub.ts"
  - "**/remote-relay.test.ts"
  - "**/runner-docker.test.ts"
  - "**/subscriptions-github-poll.test.ts"
  - "apps/cli/tests/integration.rs"
  - "apps/hub/src/server/infra/db/queries/vault.ts"
  - "apps/hub/src/server/services/_utils/git-token-source.ts"
  - "apps/hub/src/server/services/_utils/hub-gh-auth.ts"
  - "apps/hub/src/server/services/_utils/oauth-client.ts"
  - "apps/hub/src/server/services/_utils/vault-crypto.ts"
  - "apps/hub/src/server/services/git-credential-service.ts"
  - "apps/hub/src/server/services/vault-service.ts"
  - "apps/hub/tests/gh-token-worker.test.ts"
  - "apps/hub/tests/git-credentials-no-checkout.test.ts"
  - "apps/hub/tests/git-credentials.test.ts"
  - "apps/hub/tests/vault.test.ts"
  - "apps/web/e2e/settings-credentials.spec.ts"
  - "apps/worker/src/gh-token.ts"
  - "apps/worker/src/git-credentials.ts"
  - "docs/runner-hooks.md"
---

# Architecture: credential vault

The hub stores credentials encrypted in `vault_items` (`services/vault-service.ts`, `infra/db/queries/vault.ts`, `services/_utils/vault-crypto.ts`). Kinds are `api_key`, `env`, `oauth` and `git`. Scope is `global` or `repo:<name>`, and a name is unique per scope.

- Encryption is AES-256-GCM with a random 12-byte nonce per write and the item id as authenticated data, so a blob copied onto another row fails to decrypt. The key is `BAND_VAULT_KEY` (32 bytes as base64 or 64 hex characters) or, with that unset, `<BAND_HOME>/vault.key` (mode 0600, generated on first use). `band vault rotate-key` (`vault.rotateKey`) re-encrypts every item in one transaction and then replaces the key file. It is refused when the key comes from the environment.
- No API returns a secret. `vault.list` shows metadata (kind, scope, OAuth account, scopes, expiry), and `getSecret` and `getAccessToken` are for hub services only (the MCP proxy and environment `secrets` in later steps). Metadata never holds a secret, and no log line or error message does. `vault.*` uses `adminProcedure`, is left out of the MCP endpoint, and is not in `RELAY_PROCEDURES`, so a worker's agent gets 403.
- OAuth (`services/_utils/oauth-client.ts`): `vault.startOAuth` discovers the server (RFC 9728 protected resource metadata, also from a 401's `resource_metadata`, then RFC 8414 or OpenID metadata), registers a public client with RFC 7591 when the server offers it (otherwise the caller supplies `clientId`), and returns a PKCE (S256) authorization URL with the RFC 8707 `resource`. Endpoints must be https, or http on loopback. The redirect URI is `<redirectBase>/api/oauth/callback`, where `redirectBase` is the origin the UI is served from, `BAND_PUBLIC_URL` or the loopback address.
- `GET /api/oauth/callback` is answered before the device-token check, because the browser that returns may not hold the hub's session. The state is the credential: it is random, held as a SHA-256 in memory, compared in constant time against each pending flow, valid for 10 minutes and used once. A response whose `iss` names another issuer is refused. The UI follows a flow with `vault.oauthStatus`.
- A sweep every `BAND_VAULT_REFRESH_POLL_MS` (default 30 s) refreshes a token that expires within `BAND_VAULT_REFRESH_SKEW_MS` (default 2 minutes), and `getAccessToken` refreshes on demand. Concurrent refreshes of one item share one request. A failed refresh stores `refreshError` in the metadata. Deleting an OAuth item revokes its token at the server (RFC 7009, best effort) before removing the row.
- UI: Settings > Credentials (`CredentialsSettings.tsx`). CLI: `band vault list | put | delete | rotate-key` (`put` reads the value from stdin).
- Tests: `apps/hub/tests/vault.test.ts` (real hub, real local OAuth server in `fixtures/oauth-stub.ts`), the vault probes in `remote-relay.test.ts`, `apps/web/e2e/settings-credentials.spec.ts`, `vault_put_list_delete` in `apps/cli/tests/integration.rs`.
- Git credentials (`git` kind) let workers fetch, clone and push private repositories. The item's metadata holds `host`, `pathPattern` (matched against `owner/repo`, `*` within a segment, `**` across segments) and `username` (default `x-access-token`), and the secret is the token. `band vault put <name> --kind git --host github.com --path 'owner/*'`. A worker's git runs a credential helper (`apps/worker/src/git-credentials.ts`: `band-worker git-credential`, wired through `GIT_CONFIG_*` in the worker's own environment, which every git command, agent and terminal inherits. The helper command is self-contained: under Electron (the desktop bundle) it sets `ELECTRON_RUN_AS_NODE=1` itself, because the Band binary without it boots the desktop app and a hub, and the desktop app refuses to start when a packaged launch gets a script path as its first argument, so a helper run with a scrubbed environment can never fork-bomb) that asks the worker over a Unix socket, and the worker calls `git.credential` on its link (`services/git-credential-service.ts`). On a static worker the helper comes after the machine's own helpers (keychain and so on), so the machine answers first and the hub is the fallback. An ephemeral worker, or one started with `--hub-git-credentials-only` (`BAND_WORKER_HUB_GIT_CREDENTIALS_ONLY=1`), resets the list with an empty `credential.helper` entry first. The hub answers only for a remote of a repository placed on that worker (a repo with a checkout or worktree there, matched against the URL the hub stored in `repos.remote_url` and the remotes of the hub's own checkout, never the worker's, because agents can edit that, or a clone it is about to make) and refuses the rest with an RPC error. `RepoService.backfillRemotesFromWorker` runs on every worker connect and fills an empty `remote_url` from the origin of the repo's folder on that worker, once, never overwriting a URL. A remote with no matching item answers `found: false`. The token goes only in that reply: nothing on the worker's disk or environment, no log line (the log has worker, worker and path). The source is behind `GitTokenSource` (`services/_utils/git-token-source.ts`), so a GitHub App can replace the vault lookup. A runner whose repository has a vault git credential gets `BAND_CLONE_BY_HUB=1`, skips its own clone, and the hub clones through the worker after hello (`RunnerService.cloneOnHost`). The `local`, `ssh`, `docker` and `k8s` hooks honor it, the VM hooks do not. Tests: `apps/hub/tests/git-credentials-no-checkout.test.ts` (a hub with no checkout, repo added from the worker, restart), `apps/hub/tests/git-credentials.test.ts` (real hub, real `local` hook and worker, `fixtures/git-http-auth-stub.ts` for a basic-auth git server), the private clone in `runner-docker.test.ts`, `vault_put_git_credential` in `apps/cli/tests/integration.rs`. Not done yet: a GitHub App token source, and the VM hooks' clone.
- `gh` auth (`services/_utils/hub-gh-auth.ts`, `apps/worker/src/gh-token.ts`, link method `gh.token`). Both images ship `gh`. The hub's own `gh` calls (GitHub poll and webhook services) run with `GH_TOKEN` from the broadest `git` vault item for github.com when the machine has no `gh` login, and a failure with no credential names the missing one. A worker asks `gh.token` at each `acp.spawn` and `pty.spawn` and puts `GH_TOKEN` in that child's environment only (never disk or logs). The hub answers workers a runner started (a `runner_machines` row) and workers with `BAND_WORKER_GH_TOKEN=hub`. Guide: `docs/runner-hooks.md#git-and-github-auth`. Tests: `apps/hub/tests/gh-token-worker.test.ts` (real hub and worker) and the `gh credentials` cases in `subscriptions-github-poll.test.ts`. Not done yet: a dedicated `github` vault kind.
- The MCP proxy that uses these credentials is below (Architecture: MCP proxy). Not done yet: injecting `env` items into environments.
