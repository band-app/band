import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ExtensionInstallError,
  extensionService,
  MAX_INSTALL_BYTES,
} from "../../services/extension-service";
import { CHAT_ID_HEADER, TERMINAL_ID_HEADER, WORKTREE_ID_HEADER } from "../context";

export const EXT_INSTALL_PATH = "/api/extensions/install";

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

/**
 * `POST /api/extensions/install[?sha256=<hex>]`: the raw `.tar.gz` as the body, for the CLI to
 * install a local file on a remote hub. Runs after the device-token check and needs an admin
 * token. An agent's request (chat, worktree or terminal header) is refused, and the relay lists no
 * such route.
 */
export async function handleExtensionInstall(
  req: IncomingMessage,
  res: ServerResponse,
  admin: boolean,
): Promise<void> {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    send(res, 405, { error: "Use POST." });
    return;
  }
  if (
    !admin ||
    req.headers[CHAT_ID_HEADER] ||
    req.headers[WORKTREE_ID_HEADER] ||
    req.headers[TERMINAL_ID_HEADER]
  ) {
    req.resume();
    send(res, 403, { error: "Installing an extension needs an admin token." });
    return;
  }
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_INSTALL_BYTES) {
    req.resume();
    send(res, 413, { error: "The archive is over the 200 MB limit" });
    return;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  let tooLarge = false;
  await new Promise<void>((done, fail) => {
    req.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > MAX_INSTALL_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on("end", done);
    req.on("error", fail);
  });
  if (tooLarge) {
    send(res, 413, { error: "The archive is over the 200 MB limit" });
    return;
  }
  const sha256 =
    new URL(req.url ?? "", "http://hub.invalid").searchParams.get("sha256") ?? undefined;
  try {
    const extension = await extensionService.installArchive(Buffer.concat(chunks), sha256);
    send(res, 200, { extension });
  } catch (err) {
    if (err instanceof ExtensionInstallError) {
      send(res, 400, { error: err.message });
      return;
    }
    throw err;
  }
}
