import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve, sep } from "node:path";
import { worktreeService } from "../services/worktree-service";
import { CHAT_ID_HEADER, TERMINAL_ID_HEADER, WORKTREE_ID_HEADER } from "./context";

/** The largest body `PUT /api/worktree-file/...` accepts. */
export const MAX_PUT_BYTES = 50 * 1024 * 1024;

function send(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
  res.end(message);
}

/**
 * `PUT /api/worktree-file/<worktreeId>/<path>`: replaces one file of a worktree with the raw body
 * (an extension editor saves bytes). Runs after the device-token check, so any device token may
 * save, like `worktree.saveFile`. The path rules are the GET route's, and the bytes go through
 * `host.fs.writeFile`, so a worktree on a worker is written on that worker. An agent's request is
 * refused: the relay lists no such route, and a local agent's chat, worktree or terminal header
 * gets 403 here.
 */
export async function handleWorktreeFilePut(
  req: IncomingMessage,
  res: ServerResponse,
  prefix: string,
): Promise<void> {
  if (
    req.headers[CHAT_ID_HEADER] ||
    req.headers[WORKTREE_ID_HEADER] ||
    req.headers[TERMINAL_ID_HEADER]
  ) {
    req.resume();
    send(res, 403, "Agents cannot save through this route");
    return;
  }
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_PUT_BYTES) {
    req.resume();
    send(res, 413, "The file is over 50 MB");
    return;
  }
  const queryIdx = req.url?.indexOf("?") ?? -1;
  const rest = (req.url ?? "").slice(prefix.length, queryIdx === -1 ? undefined : queryIdx);
  const slash = rest.indexOf("/");
  let worktreeId: string;
  let filePath: string;
  try {
    worktreeId = decodeURIComponent(rest.slice(0, slash));
    filePath = decodeURIComponent(rest.slice(slash + 1));
  } catch {
    req.resume();
    send(res, 400, "Bad request");
    return;
  }
  if (slash === -1 || !worktreeId || !filePath) {
    req.resume();
    send(res, 400, "Bad request");
    return;
  }
  const worktree = worktreeService.resolve(worktreeId);
  if (!worktree) {
    req.resume();
    send(res, 404, "Worktree not found");
    return;
  }
  const root = worktree.worktree.path;
  const target = resolve(root, filePath);
  if (!target.startsWith(root + sep)) {
    req.resume();
    send(res, 400, "Bad request");
    return;
  }
  const relative = target.slice(root.length + 1).split(sep);
  if (relative[0] === ".git") {
    req.resume();
    send(res, 400, "Cannot write into .git");
    return;
  }

  const chunks: Buffer[] = [];
  let total = 0;
  let tooLarge = false;
  await new Promise<void>((done, fail) => {
    req.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > MAX_PUT_BYTES) {
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
    send(res, 413, "The file is over 50 MB");
    return;
  }

  try {
    const { fs } = worktree.host;
    const [realRoot, realTarget] = await Promise.all([fs.realpath(root), fs.realpath(target)]);
    if (!realTarget.startsWith(realRoot + sep)) {
      send(res, 400, "Bad request");
      return;
    }
    if (
      realTarget
        .slice(realRoot.length + 1)
        .split(sep)[0]
        ?.toLowerCase() === ".git"
    ) {
      send(res, 400, "Cannot write into .git");
      return;
    }
    const info = await fs.stat(target, { followSymlinks: true });
    if (info.kind !== "file") {
      send(res, 400, "Not a file");
      return;
    }
    await fs.writeFile(realTarget, new Uint8Array(Buffer.concat(chunks)));
  } catch {
    send(res, 404, "Not found");
    return;
  }
  res.writeHead(204, { "Cache-Control": "no-store" });
  res.end();
}
