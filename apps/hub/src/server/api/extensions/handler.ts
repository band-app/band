import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream";
import { extensionService } from "../../services/extension-service";

export const EXT_PREFIX = "/ext/";

/**
 * `GET /ext/<id>/<path>`: an installed extension's static files. Answered before the device-token
 * check, because the extension's iframe has a `null` origin and carries no Band credentials. The
 * route reads no cookie and sets none, and every answer allows any origin so the frame can fetch
 * its own scripts and `.wasm`.
 */
export async function handleExtensionFile(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const cors = { "Access-Control-Allow-Origin": "*" };
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      ...cors,
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400",
    });
    res.end();
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { ...cors, Allow: "GET, HEAD, OPTIONS" });
    res.end();
    return;
  }
  const notFound = () => {
    res.writeHead(404, { ...cors, "Content-Type": "text/plain" });
    res.end("Not found");
  };
  const rest = (req.url ?? "").slice(EXT_PREFIX.length).split("?")[0];
  const slash = rest.indexOf("/");
  if (slash <= 0) return notFound();
  let id: string;
  let relPath: string;
  try {
    id = decodeURIComponent(rest.slice(0, slash));
    relPath = decodeURIComponent(rest.slice(slash + 1));
  } catch {
    return notFound();
  }
  const file = await extensionService.open(
    id,
    relPath,
    String(req.headers["accept-encoding"] ?? ""),
  );
  if (!file) return notFound();
  res.writeHead(200, {
    ...cors,
    "Content-Type": file.contentType,
    "Content-Length": file.size.toString(),
    ...(file.encoding ? { "Content-Encoding": file.encoding } : {}),
    Vary: "Accept-Encoding",
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    // Forces an opaque origin when the page is opened as a top-level document.
    "Content-Security-Policy": "sandbox allow-scripts",
  });
  if (req.method === "HEAD") {
    file.stream.destroy();
    res.end();
    return;
  }
  pipeline(file.stream, res, () => {});
}
