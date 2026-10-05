/**
 * The credential vault (plan step 4.1).
 *
 * Items (API keys, environment values, OAuth connections) are stored
 * AES-256-GCM encrypted (`_utils/vault-crypto.ts`). The API returns metadata
 * only. Plaintext leaves this class through `getSecret` and `getAccessToken`,
 * which are for hub services (the MCP proxy and environment injection come
 * later). A secret is never logged, and error messages never hold one.
 *
 * OAuth: `startOAuth` discovers the server, registers a client where the
 * server allows it and returns the consent URL. The hub's callback route
 * hands the code to `completeOAuth`. A sweep refreshes tokens before they
 * expire, and `remove` revokes the token at the server.
 */

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createLogger } from "@band-app/logger";
import { VaultInputError, VaultNotFoundError } from "../errors";
import { type VaultKind, VaultQueries, type VaultRow } from "../infra/db/queries/vault";
import {
  type AuthServerMetadata,
  accountFromIdToken,
  buildAuthorizationUrl,
  type ClientCredentials,
  discover,
  exchangeCode,
  newPkce,
  newState,
  refreshTokens,
  registerClient,
  revokeToken,
  type TokenSet,
} from "./_utils/oauth-client";
import {
  decrypt,
  encrypt,
  generateKey,
  keySource,
  loadKey,
  stageKeyFile,
} from "./_utils/vault-crypto";
import { publicHubUrl } from "./github-webhook-service";

const log = createLogger("vault-service");

const NAME = /^[A-Za-z0-9][A-Za-z0-9 _.@:/-]{0,99}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SCOPE = /^(global|repo:[^\s:]{1,100})$/;
const FLOW_TTL_MS = 10 * 60 * 1000;
const MAX_FLOWS = 50;
const DEFAULT_REFRESH_POLL_MS = 30_000;
const DEFAULT_REFRESH_SKEW_MS = 120_000;
export const MAX_SECRET_LENGTH = 16 * 1024;
const GIT_HOST = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:\d{1,5})?$/;
const GIT_PATH_PATTERN = /^[A-Za-z0-9._~/*-]{1,200}$/;
const GIT_USERNAME = /^[^\s:]{1,100}$/;
export const DEFAULT_GIT_USERNAME = "x-access-token";

/** Where a `git` item applies: a host and a pattern over the repository path (`owner/*`). */
export interface GitCredentialMatch {
  host: string;
  /** Repository path without a leading slash or a `.git` suffix, such as `owner/repo`. */
  path: string;
  /** The repo the repository belongs to. An item scoped to another repo does not apply. */
  repo: string | null;
  /** Looks without recording a use. */
  peek?: boolean;
}

/** `*` matches within one path segment, `**` across segments. The whole path must match. */
export function pathPatternMatches(pattern: string, path: string): boolean {
  const source = pattern
    .replace(/\*{2,}/g, "**")
    .split(/(\*\*|\*)/)
    .map((part) => {
      if (part === "**") return ".*";
      if (part === "*") return "[^/]*";
      return part.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${source}$`, "i").test(path);
}

/** An item as the API shows it: never the secret. */
export interface VaultItemView {
  id: string;
  name: string;
  kind: VaultKind;
  scope: string;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
}

interface OAuthSecret {
  accessToken: string;
  refreshToken?: string;
  clientSecret?: string;
}

interface Flow {
  id: string;
  stateHash: Buffer;
  name: string;
  scope: string;
  verifier: string;
  redirectUri: string;
  serverUrl: string;
  server: AuthServerMetadata;
  resource: string;
  client: ClientCredentials;
  scopes?: string;
  createdAt: number;
  status: "pending" | "exchanging" | "connected" | "error";
  error?: string;
  itemId?: string;
}

export interface OAuthFlowStatus {
  status: Flow["status"];
  error?: string;
  item?: VaultItemView;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest();

function envMs(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function view(row: VaultRow): VaultItemView {
  const { encrypted: _encrypted, ...rest } = row;
  return rest;
}

export function validateScope(scope: string): string {
  if (!SCOPE.test(scope)) {
    throw new VaultInputError('The scope must be "global" or "repo:<name>".');
  }
  return scope;
}

export class VaultService {
  private key: Buffer | null = null;
  private readonly flows = new Map<string, Flow>();
  private readonly refreshing = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly queries: VaultQueries = new VaultQueries()) {}

  private getKey(): Buffer {
    this.key ??= loadKey();
    return this.key;
  }

  // ---- reads (metadata only) ---------------------------------------------------

  list(): VaultItemView[] {
    return this.queries.list().map(view);
  }

  keySource(): "env" | "file" {
    return keySource();
  }

  // ---- writes ------------------------------------------------------------------

  /** Stores an API key or environment value, replacing the one with the same name and scope. */
  put(input: {
    name: string;
    kind: "api_key" | "env" | "git";
    scope: string;
    value: string;
    description?: string;
    /** For a `git` item: the remote's host, a pattern over its repository path and the username. */
    host?: string;
    pathPattern?: string;
    username?: string;
  }): VaultItemView {
    const name = input.name.trim();
    // A git secret goes out on git's line-based credential protocol, so a trailing newline from
    // `echo $TOKEN | band vault put` is dropped and any other control character is refused.
    if (input.kind === "git") input = { ...input, value: input.value.replace(/\r?\n$/, "") };
    if (!NAME.test(name)) throw new VaultInputError("The name has characters the vault refuses.");
    if (input.kind === "git" && /[\0\r\n]/.test(input.value)) {
      throw new VaultInputError("A git credential's value must be a single line.");
    }
    if (input.kind === "env" && !ENV_NAME.test(name)) {
      throw new VaultInputError("An env item's name must be a valid environment variable name.");
    }
    if (!input.value || input.value.length > MAX_SECRET_LENGTH) {
      throw new VaultInputError("The value must be 1 to 16384 characters.");
    }
    const scope = validateScope(input.scope);
    const metadata: Record<string, unknown> = input.description
      ? { description: input.description.slice(0, 200) }
      : {};
    if (input.kind === "git") {
      const host = (input.host ?? "").trim().toLowerCase();
      const pathPattern = (input.pathPattern ?? "").trim().replace(/^\/+/, "");
      const username = (input.username ?? DEFAULT_GIT_USERNAME).trim();
      if (!GIT_HOST.test(host)) {
        throw new VaultInputError("A git credential needs a host such as github.com.");
      }
      if (!GIT_PATH_PATTERN.test(pathPattern)) {
        throw new VaultInputError(
          'A git credential needs a path pattern such as "owner/*" ("**" matches every repository).',
        );
      }
      if ((pathPattern.match(/\*+/g) ?? []).length > 6) {
        throw new VaultInputError("The path pattern has too many wildcards.");
      }
      if (!GIT_USERNAME.test(username)) {
        throw new VaultInputError("The username has characters the vault refuses.");
      }
      Object.assign(metadata, { host, pathPattern, username });
    }
    const now = Date.now();
    const existing = this.queries.findByName(scope, name);
    if (existing) {
      if (existing.kind === "oauth") {
        throw new VaultInputError("That name belongs to an OAuth connection. Delete it first.");
      }
      this.queries.update(existing.id, {
        kind: input.kind,
        encrypted: encrypt(this.getKey(), existing.id, input.value),
        metadata,
        updatedAt: now,
      });
      log.info({ id: existing.id, name, scope }, "vault item updated");
      return view(this.queries.find(existing.id) as VaultRow);
    }
    const id = `v-${randomUUID().slice(0, 12)}`;
    const row: VaultRow = {
      id,
      name,
      kind: input.kind,
      scope,
      encrypted: encrypt(this.getKey(), id, input.value),
      metadata,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
    };
    this.queries.insert(row);
    log.info({ id, name, scope }, "vault item created");
    return view(row);
  }

  /** Deletes an item. An OAuth connection is revoked at its server first (best effort). */
  async remove(id: string): Promise<{ removed: true; revoked: boolean | null }> {
    const row = this.queries.find(id);
    if (!row) throw new VaultNotFoundError();
    let revoked: boolean | null = null;
    if (row.kind === "oauth") revoked = await this.revoke(row);
    this.queries.remove(id);
    log.info({ id, name: row.name, scope: row.scope, revoked }, "vault item deleted");
    return { removed: true, revoked };
  }

  private async revoke(row: VaultRow): Promise<boolean | null> {
    const endpoint = row.metadata.revocationEndpoint;
    if (typeof endpoint !== "string") return null;
    try {
      const secret = JSON.parse(decrypt(this.getKey(), row.id, row.encrypted)) as OAuthSecret;
      const client = this.clientOf(row, secret);
      if (secret.refreshToken) {
        return await revokeToken(endpoint, client, secret.refreshToken, "refresh_token");
      }
      return await revokeToken(endpoint, client, secret.accessToken, "access_token");
    } catch {
      return false;
    }
  }

  // ---- secret access (server side only) ----------------------------------------

  /** The plaintext of an `api_key` or `env` item. For hub services, never an API. */
  getSecret(scope: string, name: string): string | undefined {
    const row = this.queries.findByName(scope, name);
    if (!row || row.kind === "oauth") return undefined;
    this.queries.update(row.id, { lastUsedAt: Date.now() });
    return decrypt(this.getKey(), row.id, row.encrypted);
  }

  /** A live access token for an OAuth item, refreshed first when it is about to expire. */
  async getAccessToken(id: string): Promise<string> {
    let row = this.queries.find(id);
    if (!row || row.kind !== "oauth") throw new VaultNotFoundError();
    if (this.expiresSoon(row) && row.metadata.canRefresh) {
      await this.refresh(id);
      row = this.queries.find(id) ?? row;
    }
    this.queries.update(id, { lastUsedAt: Date.now() });
    return (JSON.parse(decrypt(this.getKey(), id, row.encrypted)) as OAuthSecret).accessToken;
  }

  /**
   * The `git` item that applies to a remote, or undefined. An item matches when its host is the
   * remote's, its path pattern matches the repository path and its scope is `global` or the
   * remote's repo. A repo-scoped item beats a global one, then the pattern with the most
   * literal characters wins. For hub services, never an API.
   */
  findGitCredential(match: GitCredentialMatch): { username: string; password: string } | undefined {
    const host = match.host.toLowerCase();
    const candidates = this.queries
      .list()
      .filter((row) => row.kind === "git")
      .filter((row) => row.metadata.host === host)
      .filter(
        (row) =>
          row.scope === "global" || (match.repo !== null && row.scope === `repo:${match.repo}`),
      )
      .filter(
        (row) =>
          typeof row.metadata.pathPattern === "string" &&
          pathPatternMatches(row.metadata.pathPattern, match.path),
      );
    const specificity = (row: VaultRow) =>
      (row.scope === "global" ? 0 : 1_000_000) +
      String(row.metadata.pathPattern).replace(/\*/g, "").length;
    const best = candidates.sort((a, b) => specificity(b) - specificity(a))[0];
    if (!best) return undefined;
    if (!match.peek) this.queries.update(best.id, { lastUsedAt: Date.now() });
    const username =
      typeof best.metadata.username === "string" ? best.metadata.username : DEFAULT_GIT_USERNAME;
    return { username, password: decrypt(this.getKey(), best.id, best.encrypted) };
  }

  /** The kind of an item, or undefined when it doesn't exist. Metadata only. */
  kindOf(id: string): VaultKind | undefined {
    return this.queries.find(id)?.kind;
  }

  /**
   * The plaintext credential of any item, for the MCP proxy. An OAuth item
   * yields its access token, refreshed first when `forceRefresh` is set (the
   * upstream just answered 401) or when it is about to expire.
   */
  async getCredential(
    id: string,
    forceRefresh = false,
  ): Promise<{ kind: VaultKind; value: string }> {
    const row = this.queries.find(id);
    if (!row) throw new VaultNotFoundError();
    if (row.kind === "oauth") {
      if (forceRefresh && row.metadata.canRefresh) await this.refresh(id);
      return { kind: row.kind, value: await this.getAccessToken(id) };
    }
    this.queries.update(id, { lastUsedAt: Date.now() });
    return { kind: row.kind, value: decrypt(this.getKey(), id, row.encrypted) };
  }

  // ---- key rotation --------------------------------------------------------------

  /** Re-encrypts every item under a new key file key. Only for a key file, not `BAND_VAULT_KEY`. */
  rotateKey(): { rotated: number } {
    if (keySource() === "env") {
      throw new VaultInputError(
        "The vault key comes from BAND_VAULT_KEY. Change it in the environment instead.",
      );
    }
    const oldKey = this.getKey();
    const newKey = generateKey();
    // The new key goes to a temp file first and replaces the key file only after the
    // re-encrypted rows commit, so a failed commit never leaves rows the key file cannot read.
    const staged = stageKeyFile(newKey);
    let rotated: number;
    try {
      rotated = this.queries.transaction(() => {
        const rows = this.queries.list();
        for (const row of rows) {
          const plaintext = decrypt(oldKey, row.id, row.encrypted);
          this.queries.update(row.id, { encrypted: encrypt(newKey, row.id, plaintext) });
        }
        return rows.length;
      });
    } catch (err) {
      staged.discard();
      throw err;
    }
    staged.commit();
    this.key = newKey;
    log.info({ rotated }, "vault key rotated");
    return { rotated };
  }

  // ---- OAuth ---------------------------------------------------------------------

  async startOAuth(input: {
    name: string;
    serverUrl: string;
    scope: string;
    scopes?: string;
    clientId?: string;
    clientSecret?: string;
    redirectBase?: string;
  }): Promise<{ flowId: string; authorizationUrl: string }> {
    const name = input.name.trim();
    if (!NAME.test(name)) throw new VaultInputError("The name has characters the vault refuses.");
    const scope = validateScope(input.scope);
    this.sweepFlows();
    if (this.flows.size >= MAX_FLOWS)
      throw new VaultInputError("Too many connections in progress.");

    const redirectUri = `${this.redirectBase(input.redirectBase)}/api/oauth/callback`;
    const discovery = await discover(input.serverUrl);
    const client: ClientCredentials = input.clientId
      ? { clientId: input.clientId, clientSecret: input.clientSecret }
      : await registerClient(discovery.server, redirectUri);

    const { verifier, challenge } = newPkce();
    const state = newState();
    const flow: Flow = {
      id: randomUUID(),
      stateHash: sha256(state),
      name,
      scope,
      verifier,
      redirectUri,
      serverUrl: input.serverUrl,
      server: discovery.server,
      resource: discovery.resource,
      client,
      scopes: input.scopes?.trim() || undefined,
      createdAt: Date.now(),
      status: "pending",
    };
    this.flows.set(flow.id, flow);
    return {
      flowId: flow.id,
      authorizationUrl: buildAuthorizationUrl({
        server: discovery.server,
        clientId: client.clientId,
        redirectUri,
        state,
        challenge,
        resource: discovery.resource,
        scope: flow.scopes,
      }),
    };
  }

  private redirectBase(requested?: string): string {
    const raw =
      requested || publicHubUrl() || `http://127.0.0.1:${process.env.BAND_PORT ?? "3456"}`;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new VaultInputError("The redirect base is not a valid URL.");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new VaultInputError("The redirect base must be an http or https URL.");
    }
    return url.origin;
  }

  oauthStatus(flowId: string): OAuthFlowStatus {
    this.sweepFlows();
    const flow = this.flows.get(flowId);
    if (!flow) throw new VaultNotFoundError("Connection");
    const item = flow.itemId ? this.queries.find(flow.itemId) : undefined;
    return { status: flow.status, error: flow.error, item: item ? view(item) : undefined };
  }

  /**
   * Finishes a flow from the authorization server's redirect. The state is
   * compared in constant time against every pending flow and each flow is
   * single use, so a replayed or guessed state matches nothing.
   */
  async completeOAuth(params: {
    state?: string;
    code?: string;
    error?: string;
    iss?: string;
  }): Promise<{ ok: boolean; message: string }> {
    this.sweepFlows();
    const supplied = params.state ? sha256(params.state) : null;
    let flow: Flow | undefined;
    for (const candidate of this.flows.values()) {
      const equal = supplied !== null && timingSafeEqual(candidate.stateHash, supplied);
      if (equal && candidate.status === "pending") flow = candidate;
    }
    if (!flow) return { ok: false, message: "This sign-in link is invalid or has expired." };

    // Single use: the flow leaves "pending" before anything else runs.
    const fail = (message: string) => {
      flow.status = "error";
      flow.error = message;
      return { ok: false, message };
    };
    if (params.error) return fail("The server refused the connection.");
    if (params.iss && params.iss !== flow.server.issuer) {
      return fail("The response came from a different server than the one asked.");
    }
    if (!params.code) return fail("The server sent no authorization code.");
    flow.status = "exchanging";

    try {
      const tokens = await exchangeCode({
        server: flow.server,
        client: flow.client,
        code: params.code,
        verifier: flow.verifier,
        redirectUri: flow.redirectUri,
        resource: flow.resource,
      });
      const item = this.storeOAuth(flow, tokens);
      flow.status = "connected";
      flow.error = undefined;
      flow.itemId = item.id;
      return { ok: true, message: "Connected. You can close this window." };
    } catch (err) {
      return fail(err instanceof VaultInputError ? err.message : "The connection failed.");
    }
  }

  private storeOAuth(flow: Flow, tokens: TokenSet): VaultRow {
    const now = Date.now();
    const secret: OAuthSecret = {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      clientSecret: flow.client.clientSecret,
    };
    const metadata: Record<string, unknown> = {
      serverUrl: flow.serverUrl,
      issuer: flow.server.issuer,
      tokenEndpoint: flow.server.tokenEndpoint,
      revocationEndpoint: flow.server.revocationEndpoint ?? null,
      clientId: flow.client.clientId,
      resource: flow.resource,
      scopes: tokens.scope ?? flow.scopes ?? null,
      expiresAt: tokens.expiresAt ?? null,
      account: accountFromIdToken(tokens.idToken) ?? null,
      canRefresh: Boolean(tokens.refreshToken),
      connectedAt: now,
    };
    const existing = this.queries.findByName(flow.scope, flow.name);
    if (existing) {
      this.queries.update(existing.id, {
        kind: "oauth",
        encrypted: encrypt(this.getKey(), existing.id, JSON.stringify(secret)),
        metadata,
        updatedAt: now,
      });
      return this.queries.find(existing.id) as VaultRow;
    }
    const id = `v-${randomUUID().slice(0, 12)}`;
    const row: VaultRow = {
      id,
      name: flow.name,
      kind: "oauth",
      scope: flow.scope,
      encrypted: encrypt(this.getKey(), id, JSON.stringify(secret)),
      metadata,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
    };
    this.queries.insert(row);
    log.info({ id, name: flow.name, scope: flow.scope }, "oauth connection stored");
    return row;
  }

  private sweepFlows(): void {
    const cutoff = Date.now() - FLOW_TTL_MS;
    for (const [id, flow] of this.flows) if (flow.createdAt < cutoff) this.flows.delete(id);
  }

  // ---- refresh --------------------------------------------------------------------

  private clientOf(row: VaultRow, secret: OAuthSecret): ClientCredentials {
    return { clientId: String(row.metadata.clientId ?? ""), clientSecret: secret.clientSecret };
  }

  private expiresSoon(row: VaultRow): boolean {
    const expiresAt = row.metadata.expiresAt;
    if (row.kind !== "oauth" || typeof expiresAt !== "number") return false;
    return expiresAt - Date.now() < envMs("BAND_VAULT_REFRESH_SKEW_MS", DEFAULT_REFRESH_SKEW_MS);
  }

  /** Refreshes one OAuth item. Concurrent callers share one request. */
  refresh(id: string): Promise<void> {
    const running = this.refreshing.get(id);
    if (running) return running;
    const task = this.doRefresh(id).finally(() => this.refreshing.delete(id));
    this.refreshing.set(id, task);
    return task;
  }

  private async doRefresh(id: string): Promise<void> {
    const row = this.queries.find(id);
    if (!row || row.kind !== "oauth") throw new VaultNotFoundError();
    const secret = JSON.parse(decrypt(this.getKey(), id, row.encrypted)) as OAuthSecret;
    if (!secret.refreshToken) throw new VaultInputError("This connection has no refresh token.");
    try {
      const tokens = await refreshTokens({
        server: {
          issuer: String(row.metadata.issuer),
          authorizationEndpoint: "",
          tokenEndpoint: String(row.metadata.tokenEndpoint),
        },
        client: this.clientOf(row, secret),
        refreshToken: secret.refreshToken,
        resource: String(row.metadata.resource ?? ""),
      });
      const next: OAuthSecret = {
        ...secret,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? secret.refreshToken,
      };
      const { refreshError: _drop, ...metadata } = row.metadata;
      this.queries.update(id, {
        encrypted: encrypt(this.getKey(), id, JSON.stringify(next)),
        metadata: { ...metadata, expiresAt: tokens.expiresAt ?? null, refreshedAt: Date.now() },
        updatedAt: Date.now(),
      });
      log.info({ id }, "oauth token refreshed");
    } catch (err) {
      const message = err instanceof VaultInputError ? err.message : "Token refresh failed.";
      this.queries.update(id, { metadata: { ...row.metadata, refreshError: message } });
      log.warn({ id, message }, "oauth token refresh failed");
      throw err;
    }
  }

  async sweepRefresh(): Promise<void> {
    for (const row of this.queries.list()) {
      if (row.kind !== "oauth" || !this.expiresSoon(row) || !row.metadata.canRefresh) continue;
      await this.refresh(row.id).catch(() => {});
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(
      () => void this.sweepRefresh(),
      envMs("BAND_VAULT_REFRESH_POLL_MS", DEFAULT_REFRESH_POLL_MS),
    );
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export const vaultService = new VaultService();
