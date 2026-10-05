// Express stub for an OAuth-protected MCP-style server and its authorization server, on one loopback origin.
// It serves RFC 9728 protected resource metadata, RFC 8414 server metadata, RFC 7591 dynamic client
// registration, an authorization endpoint that consents at once (a 302 back to the registered redirect URI),
// a token endpoint with PKCE and refresh-token rotation, and RFC 7009 revocation. It records what it saw.

import { createHash, randomBytes } from "node:crypto";
import type { Server } from "node:http";
import express from "express";

export interface OAuthStub {
  /** The protected resource: `<origin>/mcp`. */
  resourceUrl: string;
  origin: string;
  /** Lifetime of the next access tokens, in seconds. */
  setExpiresIn: (seconds: number) => void;
  registrations: Array<Record<string, unknown>>;
  authorizeQueries: Array<Record<string, string>>;
  tokenRequests: Array<Record<string, string>>;
  revocations: Array<Record<string, string>>;
  /** Access tokens the stub has issued and not seen revoked or replaced. */
  liveAccessTokens: () => string[];
  /** Refuses the next token request with `invalid_grant`. */
  failNextToken: () => void;
  close: () => Promise<void>;
}

export interface OAuthStubOptions {
  /** Omit the registration endpoint, so a client id must be supplied. */
  dcr?: boolean;
  expiresIn?: number;
}

export async function startOAuthStub(opts: OAuthStubOptions = {}): Promise<OAuthStub> {
  const dcr = opts.dcr ?? true;
  let expiresIn = opts.expiresIn ?? 3600;
  let failNext = false;
  const clients = new Map<string, { redirectUris: string[] }>();
  const codes = new Map<string, { clientId: string; challenge: string; redirectUri: string }>();
  const refreshTokens = new Map<string, string>();
  const accessTokens = new Set<string>();
  const registrations: OAuthStub["registrations"] = [];
  const authorizeQueries: OAuthStub["authorizeQueries"] = [];
  const tokenRequests: OAuthStub["tokenRequests"] = [];
  const revocations: OAuthStub["revocations"] = [];
  let origin = "";

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  app.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => {
    res.json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
  });
  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json({
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      revocation_endpoint: `${origin}/revoke`,
      ...(dcr ? { registration_endpoint: `${origin}/register` } : {}),
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["read", "write"],
    });
  });
  app.post("/mcp", (req, res) => {
    const bearer = req.headers.authorization?.replace(/^Bearer /, "");
    if (!bearer || !accessTokens.has(bearer)) {
      res
        .status(401)
        .set(
          "WWW-Authenticate",
          `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
        )
        .json({ error: "unauthorized" });
      return;
    }
    res.json({ ok: true });
  });
  app.post("/register", (req, res) => {
    registrations.push(req.body as Record<string, unknown>);
    const clientId = `client-${randomBytes(6).toString("hex")}`;
    clients.set(clientId, { redirectUris: (req.body.redirect_uris as string[]) ?? [] });
    res.status(201).json({ client_id: clientId, token_endpoint_auth_method: "none" });
  });
  app.get("/authorize", (req, res) => {
    const q = req.query as Record<string, string>;
    authorizeQueries.push(q);
    const client = clients.get(q.client_id);
    // Strict redirect URI matching: an unregistered URI is never redirected to.
    if (!client || !client.redirectUris.includes(q.redirect_uri)) {
      res.status(400).send("invalid redirect_uri");
      return;
    }
    if (q.response_type !== "code" || q.code_challenge_method !== "S256" || !q.code_challenge) {
      res.status(400).send("PKCE required");
      return;
    }
    const code = randomBytes(16).toString("hex");
    codes.set(code, {
      clientId: q.client_id,
      challenge: q.code_challenge,
      redirectUri: q.redirect_uri,
    });
    const back = new URL(q.redirect_uri);
    back.searchParams.set("code", code);
    back.searchParams.set("state", q.state);
    back.searchParams.set("iss", origin);
    res.redirect(302, back.toString());
  });
  app.post("/token", (req, res) => {
    const body = req.body as Record<string, string>;
    tokenRequests.push(body);
    if (failNext) {
      failNext = false;
      res.status(400).json({ error: "invalid_grant" });
      return;
    }
    const issue = (clientId: string) => {
      const accessToken = `at-${randomBytes(12).toString("hex")}`;
      const refreshToken = `rt-${randomBytes(12).toString("hex")}`;
      accessTokens.add(accessToken);
      refreshTokens.set(refreshToken, clientId);
      const idToken = `x.${Buffer.from(JSON.stringify({ email: "tester@example.test" })).toString("base64url")}.y`;
      res.json({
        access_token: accessToken,
        refresh_token: refreshToken,
        token_type: "Bearer",
        expires_in: expiresIn,
        scope: "read write",
        id_token: idToken,
      });
    };
    if (body.grant_type === "authorization_code") {
      const entry = codes.get(body.code);
      codes.delete(body.code);
      const verifierOk =
        entry &&
        createHash("sha256")
          .update(body.code_verifier ?? "")
          .digest("base64url") === entry.challenge;
      if (
        !entry ||
        !verifierOk ||
        entry.redirectUri !== body.redirect_uri ||
        entry.clientId !== body.client_id
      ) {
        res.status(400).json({ error: "invalid_grant" });
        return;
      }
      issue(entry.clientId);
      return;
    }
    if (body.grant_type === "refresh_token") {
      const clientId = refreshTokens.get(body.refresh_token);
      if (!clientId || clientId !== body.client_id) {
        res.status(400).json({ error: "invalid_grant" });
        return;
      }
      refreshTokens.delete(body.refresh_token);
      issue(clientId);
      return;
    }
    res.status(400).json({ error: "unsupported_grant_type" });
  });
  app.post("/revoke", (req, res) => {
    const body = req.body as Record<string, string>;
    revocations.push(body);
    refreshTokens.delete(body.token);
    accessTokens.delete(body.token);
    res.status(200).end();
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = (server.address() as { port: number }).port;
  origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    resourceUrl: `${origin}/mcp`,
    setExpiresIn: (seconds) => {
      expiresIn = seconds;
    },
    registrations,
    authorizeQueries,
    tokenRequests,
    revocations,
    liveAccessTokens: () => [...accessTokens],
    failNextToken: () => {
      failNext = true;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
