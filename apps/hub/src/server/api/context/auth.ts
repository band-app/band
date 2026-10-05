/**
 * Who is calling the git and media endpoints. Both are answered before the
 * hub's device-token check, because a worker holds a session token (which
 * fails that check on purpose) and `git` can only send Basic credentials.
 */

import type { IncomingMessage } from "node:http";
import { parseCookies } from "../../../../auth";
import { tokenService } from "../../services/token-service";

export type Principal =
  | { kind: "admin" }
  | { kind: "device" }
  | { kind: "worker"; hostId: string; labels: string[] };

function candidates(req: IncomingMessage, allowCookie: boolean, allowQuery: boolean): string[] {
  const out: string[] = [];
  const header = req.headers.authorization ?? "";
  if (header.startsWith("Bearer ")) out.push(header.slice(7).trim());
  if (header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
    const at = decoded.indexOf(":");
    // `git` sends user:password. The token may be either part.
    if (at === -1) out.push(decoded);
    else out.push(decoded.slice(at + 1), decoded.slice(0, at));
  }
  if (allowCookie) {
    const cookie = parseCookies(req).band_token;
    if (cookie) out.push(cookie);
  }
  if (allowQuery) {
    const q = new URL(req.url ?? "/", "http://hub.local").searchParams.get("token");
    if (q) out.push(q);
  }
  return out.filter(Boolean);
}

/**
 * The caller behind a request, or null for none. With auth off (dev) every
 * caller is an admin. A device token is an admin when it carries the admin flag.
 */
export function authenticate(
  req: IncomingMessage,
  opts: { authRequired: boolean; allowCookie: boolean; allowQuery?: boolean },
): Principal | null {
  if (!opts.authRequired) return { kind: "admin" };
  for (const candidate of candidates(req, opts.allowCookie, opts.allowQuery === true)) {
    const device = tokenService.resolveDevice(candidate);
    if (device) return device.admin ? { kind: "admin" } : { kind: "device" };
    const worker = tokenService.resolveWorkerSession(candidate);
    if (worker) {
      return {
        kind: "worker",
        hostId: worker.hostId,
        labels: tokenService.hostLabels(worker.hostId) ?? [],
      };
    }
  }
  return null;
}
