/**
 * `/media/<id>`: the media blob store over HTTP (plan step 5.1).
 *
 * `PUT /media/<id>` stores the body when `<id>` is its SHA-256. `POST /media`
 * stores it and answers with the id and its `band://media/<id>` link. `GET` and
 * `HEAD /media/<id>` read it back, with byte ranges so video can seek. Any
 * device token or worker session token may call it; the browser's cookie works
 * too, so `<img src>` loads. Served bytes carry their stored type, `nosniff` and
 * a sandboxing CSP.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { bandMediaUrl } from "@band-app/shared/band-media";
import {
  MEDIA_ID,
  MediaRefusedError,
  maxMediaBytes,
  mediaService,
} from "../../services/media-service";
import { authenticate } from "../context/auth";

export const MEDIA_PREFIX = "/media";

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function parseRange(header: string, size: number): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m || (!m[1] && !m[2])) return null;
  let start: number;
  let end: number;
  if (!m[1]) {
    start = Math.max(size - Number(m[2]), 0);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  return start <= end && start < size ? { start, end } : null;
}

export async function handleMedia(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { authRequired: boolean },
): Promise<void> {
  const readOnly = req.method === "GET" || req.method === "HEAD";
  const principal = authenticate(req, {
    authRequired: opts.authRequired,
    allowCookie: true,
    allowQuery: readOnly,
  });
  if (!principal) {
    res.writeHead(401, { "Content-Type": "text/plain", "WWW-Authenticate": "Bearer" });
    res.end("Authentication required\n");
    return;
  }
  const path = (req.url ?? "").split("?")[0];
  const method = req.method ?? "GET";
  const match = /^\/media(?:\/([^/]*))?$/.exec(path);
  if (!match) return send(res, 404, { error: "Not found" });
  const id = match[1];

  if (method === "POST" && id === undefined) return store(req, res);
  if (id === undefined || !MEDIA_ID.test(id)) return send(res, 404, { error: "Not found" });
  if (method === "PUT") return store(req, res, id);
  if (method !== "GET" && method !== "HEAD") return send(res, 405, { error: "Method not allowed" });

  const meta = mediaService.meta(id);
  if (!meta) return send(res, 404, { error: "Not found" });
  const headers: Record<string, string | number> = {
    "Content-Type": meta.contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Content-Disposition": "inline",
    ETag: `"${id}"`,
  };
  const rangeHeader = req.headers.range;
  const range = rangeHeader ? parseRange(rangeHeader, meta.size) : null;
  if (rangeHeader && !range) {
    res.writeHead(416, { "Content-Range": `bytes */${meta.size}` });
    res.end();
    return;
  }
  if (range) {
    headers["Content-Range"] = `bytes ${range.start}-${range.end}/${meta.size}`;
    headers["Content-Length"] = range.end - range.start + 1;
    res.writeHead(206, headers);
  } else {
    headers["Content-Length"] = meta.size;
    res.writeHead(200, headers);
  }
  if (method === "HEAD") {
    res.end();
    return;
  }
  const stream = mediaService.read(id, range ?? undefined);
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

async function store(req: IncomingMessage, res: ServerResponse, id?: string): Promise<void> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxMediaBytes()) {
    req.resume();
    return send(res, 413, { error: `Larger than ${maxMediaBytes()} bytes` });
  }
  try {
    const stored = await mediaService.put(req, req.headers["content-type"], id);
    send(res, stored.created ? 201 : 200, {
      id: stored.id,
      url: bandMediaUrl(stored.id),
      size: stored.size,
      contentType: stored.contentType,
    });
  } catch (err) {
    if (err instanceof MediaRefusedError) return send(res, err.status, { error: err.message });
    throw err;
  }
}
