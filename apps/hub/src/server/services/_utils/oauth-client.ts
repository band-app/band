/**
 * OAuth 2.1 client pieces for the vault (plan step 4.1): discovery (RFC 9728
 * protected resource metadata, RFC 8414 authorization server metadata),
 * dynamic client registration (RFC 7591), authorization code with PKCE, token
 * refresh and revocation (RFC 7009). It makes plain `fetch` calls and holds
 * no state. Errors name the step and the HTTP status, never a token or a
 * response body.
 */

import { createHash, randomBytes } from "node:crypto";
import { VaultInputError } from "../../errors";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 1024 * 1024;

export interface AuthServerMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  revocationEndpoint?: string;
  scopesSupported?: string[];
}

export interface Discovery {
  /** The resource the token is for (RFC 8707), from the protected resource metadata or the server URL. */
  resource: string;
  server: AuthServerMetadata;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms, when the server said how long the token lives. */
  expiresAt?: number;
  scope?: string;
  idToken?: string;
}

export interface ClientCredentials {
  clientId: string;
  clientSecret?: string;
}

/** https, or http on a loopback host (a local authorization server). */
export function assertAllowedUrl(raw: string, what: string, allowLoopback = true): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new VaultInputError(`${what} is not a valid URL.`);
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback && allowLoopback)) {
    throw new VaultInputError(`${what} must use https (http is allowed only on loopback).`);
  }
  return url;
}

async function readLimited(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_BODY_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel().catch(() => {});
  return Buffer.concat(chunks).subarray(0, MAX_BODY_BYTES).toString("utf8");
}

async function fetchJson(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; body: Record<string, unknown> | null; headers: Headers }> {
  const res = await fetch(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(await readLimited(res));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    // Not JSON: the caller treats a null body as "no usable answer".
  }
  return { status: res.status, body, headers: res.headers };
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

async function tryJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetchJson(url, { headers: { Accept: "application/json" } });
    return res.status === 200 ? res.body : null;
  } catch {
    return null;
  }
}

function parseServerMetadata(
  raw: Record<string, unknown>,
  expectedIssuer: string,
): AuthServerMetadata | null {
  const authorizationEndpoint = str(raw.authorization_endpoint);
  const tokenEndpoint = str(raw.token_endpoint);
  const issuer = str(raw.issuer);
  if (!authorizationEndpoint || !tokenEndpoint || !issuer) return null;
  // RFC 8414 section 3.3: the issuer in the metadata must be the one it was fetched for.
  if (issuer.replace(/\/$/, "") !== expectedIssuer.replace(/\/$/, "")) return null;
  const methods = raw.code_challenge_methods_supported;
  if (Array.isArray(methods) && !methods.includes("S256")) return null;
  return {
    issuer,
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint: str(raw.registration_endpoint),
    revocationEndpoint: str(raw.revocation_endpoint),
    scopesSupported: Array.isArray(raw.scopes_supported)
      ? raw.scopes_supported.filter((s): s is string => typeof s === "string")
      : undefined,
  };
}

/** Finds the authorization server for `serverUrl` (an MCP server or any OAuth-protected resource). */
export async function discover(serverUrl: string): Promise<Discovery> {
  const target = assertAllowedUrl(serverUrl, "The server URL");
  // Only a loopback server may send the hub to other loopback URLs. A remote server's metadata
  // cannot point the hub at local services.
  const loopbackOk = ["127.0.0.1", "localhost", "[::1]"].includes(target.hostname);
  const path = target.pathname === "/" ? "" : target.pathname.replace(/\/$/, "");

  let issuer = target.origin;
  let resource = `${target.origin}${path}`;
  const prmUrls = [
    `${target.origin}/.well-known/oauth-protected-resource${path}`,
    `${target.origin}/.well-known/oauth-protected-resource`,
  ];
  // A 401 can point at the metadata: `WWW-Authenticate: Bearer resource_metadata="<url>"`.
  try {
    const probe = await fetchJson(serverUrl, { headers: { Accept: "application/json" } });
    const match = probe.headers.get("www-authenticate")?.match(/resource_metadata="([^"]+)"/);
    if (match) prmUrls.unshift(match[1]);
  } catch {
    // The well-known paths below still apply.
  }
  for (const url of prmUrls) {
    try {
      assertAllowedUrl(url, "The protected resource metadata URL", loopbackOk);
    } catch {
      continue;
    }
    const prm = await tryJson(url);
    const first = Array.isArray(prm?.authorization_servers)
      ? str(prm.authorization_servers[0])
      : undefined;
    if (prm && first) {
      issuer = first;
      resource = str(prm.resource) ?? resource;
      break;
    }
  }

  const issuerUrl = assertAllowedUrl(issuer, "The authorization server URL", loopbackOk);
  const issuerPath = issuerUrl.pathname === "/" ? "" : issuerUrl.pathname.replace(/\/$/, "");
  const metadataUrls = [
    `${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerPath}`,
    `${issuerUrl.origin}/.well-known/openid-configuration${issuerPath}`,
    `${issuerUrl.origin}${issuerPath}/.well-known/openid-configuration`,
  ];
  for (const url of metadataUrls) {
    const raw = await tryJson(url);
    const server = raw ? parseServerMetadata(raw, issuer) : null;
    if (!server) continue;
    for (const [what, endpoint] of [
      ["authorization endpoint", server.authorizationEndpoint],
      ["token endpoint", server.tokenEndpoint],
      ["registration endpoint", server.registrationEndpoint],
      ["revocation endpoint", server.revocationEndpoint],
    ] as const) {
      if (endpoint) assertAllowedUrl(endpoint, `The ${what}`, loopbackOk);
    }
    return { resource, server };
  }
  throw new VaultInputError("No OAuth authorization server metadata found for that URL.");
}

/** Registers Band as a public client (RFC 7591). */
export async function registerClient(
  server: AuthServerMetadata,
  redirectUri: string,
): Promise<ClientCredentials> {
  if (!server.registrationEndpoint) {
    throw new VaultInputError(
      "This server has no dynamic client registration. Provide a client id.",
    );
  }
  const res = await fetchJson(server.registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: "Band",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const clientId = str(res.body?.client_id);
  if (res.status >= 300 || !clientId) {
    throw new VaultInputError(`Client registration failed (HTTP ${res.status}).`);
  }
  return { clientId, clientSecret: str(res.body?.client_secret) };
}

export function newPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function newState(): string {
  return randomBytes(32).toString("base64url");
}

export function buildAuthorizationUrl(opts: {
  server: AuthServerMetadata;
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
  resource: string;
  scope?: string;
}): string {
  const url = new URL(opts.server.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("state", opts.state);
  url.searchParams.set("code_challenge", opts.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", opts.resource);
  if (opts.scope) url.searchParams.set("scope", opts.scope);
  return url.toString();
}

async function tokenRequest(
  server: AuthServerMetadata,
  client: ClientCredentials,
  params: Record<string, string>,
  step: string,
): Promise<TokenSet> {
  const body = new URLSearchParams({ ...params, client_id: client.clientId });
  if (client.clientSecret) body.set("client_secret", client.clientSecret);
  const res = await fetchJson(server.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
  const accessToken = str(res.body?.access_token);
  if (res.status >= 300 || !accessToken) {
    const code = str(res.body?.error);
    throw new VaultInputError(
      `${step} failed (HTTP ${res.status}${code && /^[a-z_]{1,40}$/.test(code) ? `, ${code}` : ""}).`,
    );
  }
  const expiresIn = typeof res.body?.expires_in === "number" ? res.body.expires_in : undefined;
  return {
    accessToken,
    refreshToken: str(res.body?.refresh_token),
    expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined,
    scope: str(res.body?.scope),
    idToken: str(res.body?.id_token),
  };
}

export function exchangeCode(opts: {
  server: AuthServerMetadata;
  client: ClientCredentials;
  code: string;
  verifier: string;
  redirectUri: string;
  resource: string;
}): Promise<TokenSet> {
  return tokenRequest(
    opts.server,
    opts.client,
    {
      grant_type: "authorization_code",
      code: opts.code,
      code_verifier: opts.verifier,
      redirect_uri: opts.redirectUri,
      resource: opts.resource,
    },
    "Token exchange",
  );
}

export function refreshTokens(opts: {
  server: AuthServerMetadata;
  client: ClientCredentials;
  refreshToken: string;
  resource: string;
}): Promise<TokenSet> {
  return tokenRequest(
    opts.server,
    opts.client,
    { grant_type: "refresh_token", refresh_token: opts.refreshToken, resource: opts.resource },
    "Token refresh",
  );
}

/** Asks the server to revoke a token (RFC 7009). Returns whether it said yes; never throws. */
export async function revokeToken(
  endpoint: string,
  client: ClientCredentials,
  token: string,
  hint: "refresh_token" | "access_token",
): Promise<boolean> {
  try {
    const body = new URLSearchParams({ token, token_type_hint: hint, client_id: client.clientId });
    if (client.clientSecret) body.set("client_secret", client.clientSecret);
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    return res.status < 300;
  } catch {
    return false;
  }
}

/** The account shown next to a connection: `email`, else `sub` from an id token. The token is not verified, so this is a label only. */
export function accountFromIdToken(idToken: string | undefined): string | undefined {
  if (!idToken) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString());
    return str(payload.email) ?? str(payload.preferred_username) ?? str(payload.sub);
  } catch {
    return undefined;
  }
}
