/**
 * `GET /api/oauth/callback`: where the authorization server sends the browser
 * back after consent. Answered before the device-token check, because the
 * browser that returns may not hold the hub's session. The single-use `state`
 * from `vault.startOAuth` is the credential, and the page it returns holds
 * no secret.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { vaultService } from "../../services/vault-service";

export const OAUTH_CALLBACK_PATH = "/api/oauth/callback";

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export async function handleOAuthCallback(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "", "http://hub.invalid");
  const q = url.searchParams;
  const result = await vaultService.completeOAuth({
    state: q.get("state") ?? undefined,
    code: q.get("code") ?? undefined,
    error: q.get("error") ?? undefined,
    iss: q.get("iss") ?? undefined,
  });
  res.writeHead(result.ok ? 200 : 400, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
  });
  res.end(
    `<!doctype html><meta charset="utf-8"><title>Band</title>` +
      `<body style="font-family:system-ui;margin:3rem"><h1>${result.ok ? "Connected" : "Not connected"}</h1>` +
      `<p data-testid="oauth-callback__message" data-status="${result.ok ? "connected" : "failed"}">${escapeHtml(result.message)}</p></body>`,
  );
}
