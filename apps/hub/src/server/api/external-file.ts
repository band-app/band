import type { IncomingMessage, ServerResponse } from "node:http";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Host } from "@band-app/host-api";
import { RPC_METHOD_NOT_FOUND, RpcError } from "@band-app/link";
import { hostedFileHeaders } from "@band-app/worktree-ops/http-files";
import { parseByteRange } from "../services/_utils/byte-range";
import {
  EXTERNAL_PREVIEW_PREFIX,
  isPlainAbsolutePath,
  verifyExternalPreviewGrant,
} from "../services/_utils/external-preview-link";
import { mimeTypeFromFilename } from "../services/_utils/mime-types";
import { worktreeService } from "../services/worktree-service";
import { CHAT_ID_HEADER, TERMINAL_ID_HEADER, WORKTREE_ID_HEADER } from "./context";

/** The route a device token reaches, for the bytes of a file outside the worktree. */
export const EXTERNAL_FILE_PREFIX = "/api/external-file/";

function send(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
  res.end(message);
}

function isAgentRequest(req: IncomingMessage): boolean {
  return !!(
    req.headers[CHAT_ID_HEADER] ||
    req.headers[WORKTREE_ID_HEADER] ||
    req.headers[TERMINAL_ID_HEADER]
  );
}

/**
 * Streams one regular file through `host.external`, so a remote worktree's bytes come from its
 * worker and the worker's user decides what is readable. A link as the final component is
 * refused. With `folder`, the file must also lie in that folder after links are resolved, so a
 * link inside the folder cannot lead out of it.
 */
async function serveExternalFile(
  res: ServerResponse,
  host: Host,
  absolutePath: string,
  opts: { folder?: string; extraHeaders?: Record<string, string>; range?: string },
): Promise<void> {
  const { external } = host;
  try {
    const info = await external.stat(absolutePath);
    if (info.outcome === "missing") return send(res, 404, "Not found");
    if (info.outcome === "denied") return send(res, 403, "Permission denied");
    if (info.symlink || info.kind !== "file") return send(res, 400, "Bad request");
    if (!info.readable) return send(res, 403, "Permission denied");
    if (opts.folder !== undefined) {
      const folder = await external.stat(opts.folder);
      if (folder.outcome !== "ok" || folder.kind !== "directory")
        return send(res, 404, "Not found");
      const root = folder.canonicalPath;
      if (!info.canonicalPath.startsWith(root === "/" ? "/" : `${root}/`)) {
        return send(res, 403, "Forbidden");
      }
    }
    const contentType = mimeTypeFromFilename(basename(absolutePath));
    const range = parseByteRange(opts.range, info.size);
    if (range === "unsatisfiable") {
      res.writeHead(416, { "Content-Range": `bytes */${info.size}` });
      res.end();
      return;
    }
    const partial = range !== null;
    // Open before the headers go out, so an unreadable file is a 404 and not a cut-off 200.
    // Read the path that was checked, so a link swapped in above it cannot redirect the open.
    const iterator = external
      .readStream(info.canonicalPath, range ?? undefined)
      [Symbol.asyncIterator]();
    let first: IteratorResult<Uint8Array>;
    try {
      first = await iterator.next();
    } catch (err) {
      await iterator.return?.();
      throw err;
    }
    res.writeHead(partial ? 206 : 200, {
      "Content-Type": contentType,
      "Content-Length": (partial ? range.end - range.start + 1 : info.size).toString(),
      ...(partial ? { "Content-Range": `bytes ${range.start}-${range.end}/${info.size}` } : {}),
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-cache",
      ...hostedFileHeaders(contentType),
      ...opts.extraHeaders,
    });
    const rest = (async function* () {
      try {
        if (!first.done) yield first.value;
        while (true) {
          const next = await iterator.next();
          if (next.done) return;
          yield next.value;
        }
      } finally {
        // Closing the inner iterator runs the reader's cleanup (file handle, link channel).
        await iterator.return?.();
      }
    })();
    const stream = Readable.from(rest, { objectMode: false, highWaterMark: 64 * 1024 });
    // A client that leaves must release the worker link channel behind the stream.
    res.once("close", () => stream.destroy());
    await pipeline(stream, res).catch(() => {});
  } catch (err) {
    if (res.headersSent) res.destroy();
    else if (err instanceof RpcError && err.code === RPC_METHOD_NOT_FOUND) {
      send(res, 501, "This worker is too old to preview files outside the worktree. Update it.");
    } else send(res, 404, "Not found");
  }
}

/**
 * `GET /api/external-file/<worktreeId>?path=<absolute path>`: the bytes of a file outside the
 * worktree, on the worktree's worker. Runs after the device-token check. An agent's request is
 * refused: the relay lists no such route, and a local agent's chat, worktree or terminal header
 * gets 403 here.
 */
export async function handleExternalFile(req: IncomingMessage, res: ServerResponse) {
  if (isAgentRequest(req)) return send(res, 403, "Agents cannot read files through this route");
  const url = new URL(req.url ?? "", "http://hub");
  let worktreeId: string;
  try {
    worktreeId = decodeURIComponent(url.pathname.slice(EXTERNAL_FILE_PREFIX.length));
  } catch {
    return send(res, 400, "Bad request");
  }
  const path = url.searchParams.get("path") ?? "";
  if (!worktreeId || !isPlainAbsolutePath(path)) return send(res, 400, "Bad request");
  const worktree = worktreeService.resolve(worktreeId);
  if (!worktree) return send(res, 404, "Worktree not found");
  await serveExternalFile(res, worktree.host, path, { range: req.headers.range });
}

/**
 * `GET /api/external-preview/<worktreeId>/<grant>/<path>`: an HTML file outside the worktree, and
 * the files beside it, behind a signed grant for the file's folder. Answered before the
 * device-token check, because a sandboxed iframe cannot send it.
 */
export async function handleExternalPreview(req: IncomingMessage, res: ServerResponse) {
  const [rest = ""] = (req.url ?? "").slice(EXTERNAL_PREVIEW_PREFIX.length).split("?");
  const [rawId, grant, ...pathParts] = rest.split("/");
  let worktreeId: string;
  let decoded: string[];
  try {
    worktreeId = decodeURIComponent(rawId ?? "");
    decoded = pathParts.map(decodeURIComponent);
  } catch {
    return send(res, 400, "Bad request");
  }
  if (!worktreeId || !grant || decoded.length === 0) return send(res, 400, "Bad request");
  // An encoded slash would decode into a segment that hides a separator from the checks.
  if (decoded.some((part) => part.includes("/") || part.includes("\\"))) {
    return send(res, 400, "Bad request");
  }
  const path = `/${decoded.join("/")}`;
  const folder = verifyExternalPreviewGrant(worktreeId, grant, path);
  if (folder === null) return send(res, 403, "Forbidden");
  const worktree = worktreeService.resolve(worktreeId);
  if (!worktree) return send(res, 404, "Worktree not found");
  await serveExternalFile(res, worktree.host, path, {
    folder,
    range: req.headers.range,
    extraHeaders: {
      // Page scripts run with an opaque origin, so they cannot use the hub's cookies or storage.
      "Content-Security-Policy": "sandbox allow-scripts allow-forms allow-popups allow-modals",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "private, no-store",
    },
  });
}
