/**
 * The provisioning endpoints, answered before the device-token check because the one-time code
 * and the run token are the credentials (`ProvisioningService`).
 *
 * - `GET  /api/provision/<code>/script` answers the shell script. It holds no secret and spends
 *   nothing, so fetching it twice, or a link preview, is harmless.
 * - `POST /api/provision/exchange {"code"}` spends the code and answers `key=value` lines with
 *   the worker bootstrap token and a run token.
 * - `GET  /api/provision/<code>/bundle` streams the pinned provisioning repo, with the run token
 *   as a Bearer header.
 * - `POST /api/provision/<code>/log[?exit=N]` appends script output (plain text body).
 *
 * A refusal is one generic message whatever the reason, and no code or token reaches a log line.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream";
import { createLogger } from "@band-app/logger";
import {
  ProvisionAuthError,
  ProvisionExchangeError,
  provisioningService,
} from "../../services/provisioning-service";

const log = createLogger("provisioning");

export const PROVISION_PREFIX = "/api/provision/";
const MAX_EXCHANGE_BODY_BYTES = 4096;
const MAX_LOG_BODY_BYTES = 128 * 1024;
export const PROVISION_REFUSED_MESSAGE =
  "This provisioning command was already used or has expired. Create a new one in Settings > Workers.";

export function isProvisionRequest(req: IncomingMessage): boolean {
  return (req.url ?? "").split("?")[0].startsWith(PROVISION_PREFIX);
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).byteLength;
    if (size > limit) {
      req.destroy();
      return null;
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== "string") return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1];
}

export async function handleProvision(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const send = (status: number, body: string, type = "application/json", extra = {}) => {
    res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...extra });
    res.end(body);
  };
  const json = (status: number, body: Record<string, unknown>) =>
    send(status, JSON.stringify(body));
  const refused = () => json(401, { error: PROVISION_REFUSED_MESSAGE });

  const url = new URL(req.url ?? "/", "http://localhost");
  const rest = url.pathname.slice(PROVISION_PREFIX.length);

  if (rest === "exchange") {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      json(405, { error: "Method not allowed" });
      return;
    }
    const body = await readBody(req, MAX_EXCHANGE_BODY_BYTES);
    if (!body) return json(413, { error: "Request body too large" });
    let code: unknown;
    try {
      code = (JSON.parse(body.toString("utf8") || "{}") as { code?: unknown }).code;
    } catch {
      return json(400, { error: "Body must be JSON" });
    }
    if (typeof code !== "string" || code === "") {
      return json(400, { error: "code must be a string" });
    }
    try {
      send(200, provisioningService.exchange(code), "text/plain; charset=utf-8");
    } catch (err) {
      if (!(err instanceof ProvisionExchangeError)) throw err;
      log.debug(`provisioning exchange refused: ${err.reason}`);
      refused();
    }
    return;
  }

  const match = /^([^/]+)\/(script|bundle|log)$/.exec(rest);
  if (!match) return json(404, { error: "Not found" });
  let code: string;
  try {
    code = decodeURIComponent(match[1]);
  } catch {
    return json(400, { error: "Bad code" });
  }
  const action = match[2];

  if (action === "script") {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return json(405, { error: "Method not allowed" });
    }
    const script = provisioningService.script(code);
    if (script === null) return json(404, { error: "Not found" });
    return send(200, script, "text/x-shellscript; charset=utf-8");
  }

  try {
    if (action === "bundle") {
      if (req.method !== "GET") {
        res.setHeader("Allow", "GET");
        return json(405, { error: "Method not allowed" });
      }
      const { stream, size } = provisioningService.bundle(code, bearer(req));
      res.writeHead(200, {
        "Content-Type": "application/gzip",
        "Content-Length": String(size),
        "Cache-Control": "no-store",
      });
      pipeline(stream, res, () => {});
      return;
    }
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return json(405, { error: "Method not allowed" });
    }
    const body = await readBody(req, MAX_LOG_BODY_BYTES);
    if (!body) return json(413, { error: "Request body too large" });
    const exitParam = url.searchParams.get("exit");
    const exit = exitParam !== null && /^\d{1,3}$/.test(exitParam) ? Number(exitParam) : undefined;
    provisioningService.appendLog(code, bearer(req), body.toString("utf8"), exit);
    json(200, { ok: true });
  } catch (err) {
    if (!(err instanceof ProvisionAuthError)) throw err;
    refused();
  }
}
