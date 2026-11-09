import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, join, resolve, sep } from "node:path";
import { pipeline, Readable } from "node:stream";
import type { DirectScopeParams } from "@band-app/link";
import { DIRECT_FILE_ROUTES } from "@band-app/shared/direct-access";
import {
  attachmentDisposition,
  hostedFileHeaders,
  mimeTypeFromFilename,
  parseByteRange,
  parseSharedPath,
} from "@band-app/worktree-ops/http-files";
import { hostDirs, type WorkerContext } from "./context.ts";

/** Whether `pathname` is one of the file routes this listener serves with `GET`. */
export function isFileRoute(pathname: string): boolean {
  return Object.values(DIRECT_FILE_ROUTES).some((prefix) => pathname.startsWith(prefix));
}

/** Decodes one URL segment, or null for a malformed one. */
function decode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** The largest body `PUT /api/worktree-file/...` accepts, as on the hub. */
export const MAX_PUT_BYTES = 50 * 1024 * 1024;

/**
 * `PUT /api/worktree-file/<worktreeId>/<path>`: replaces one existing file of the token's worktree
 * with the raw body, with the hub route's rules (`worktree-file-put.ts`): 403 for an agent's
 * headers, 413 over 50 MB, 400 for `..`, a symlink out or `.git`, 404 for a missing file. The
 * worker never creates a file. Any failure other than those answers 500, so the client asks the
 * hub, which writes the same bytes.
 */
async function putDirectFile(
  ctx: WorkerContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  scope: DirectScopeParams,
  cors: Record<string, string>,
): Promise<void> {
  const end = (status: number, text: string) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (!req.complete) req.resume();
    res.writeHead(status, { "Content-Type": "text/plain", "Cache-Control": "no-store", ...cors });
    res.end(text);
  };
  if (!url.pathname.startsWith(DIRECT_FILE_ROUTES.worktreeFile)) return end(405, "Use GET");
  if (
    req.headers["x-band-chat-id"] ||
    req.headers["x-band-worktree-id"] ||
    req.headers["x-band-terminal-id"]
  ) {
    return end(403, "Agents cannot save through this route");
  }
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_PUT_BYTES)
    return end(413, "The file is over 50 MB");
  const rest = url.pathname.slice(DIRECT_FILE_ROUTES.worktreeFile.length);
  const slash = rest.indexOf("/");
  if (slash === -1) return end(400, "Bad request");
  const worktreeId = decode(rest.slice(0, slash));
  const rawPath = decode(rest.slice(slash + 1));
  if (!worktreeId || !rawPath) return end(400, "Bad request");
  if (worktreeId !== scope.worktreeId) return end(403, "The token is for another worktree");
  const root = scope.path;
  const target = resolve(join(root, rawPath));
  if (!target.startsWith(root + sep)) return end(400, "Bad request");
  if (target.slice(root.length + 1).split(sep)[0] === ".git") {
    return end(400, "Cannot write into .git");
  }

  const chunks: Buffer[] = [];
  let total = 0;
  let tooLarge = false;
  try {
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
      req.on("aborted", () => fail(new Error("aborted")));
    });
  } catch {
    return end(500, "Could not read the body");
  }
  if (tooLarge) return end(413, "The file is over 50 MB");

  const { fs } = ctx.host;
  res.once("close", ctx.activity.hold());
  try {
    const [realRoot, realTarget] = await Promise.all([fs.realpath(root), fs.realpath(target)]);
    if (!realTarget.startsWith(realRoot + sep)) return end(400, "Bad request");
    if (
      realTarget
        .slice(realRoot.length + 1)
        .split(sep)[0]
        ?.toLowerCase() === ".git"
    ) {
      return end(400, "Cannot write into .git");
    }
    await ctx.policy.resolve(realTarget);
    const info = await fs.stat(realTarget, { followSymlinks: true });
    if (info.kind !== "file") return end(400, "Not a file");
    await fs.writeFile(realTarget, new Uint8Array(Buffer.concat(chunks)));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return end(404, "Not found");
    return end(500, "Could not write the file");
  }
  res.writeHead(204, { "Cache-Control": "no-store", ...cors });
  res.end();
}

/**
 * Serves `GET /api/worktree-file`, `/api/uploads` and `/api/shared` for the
 * token's worktree from this worker's disk, with the hub routes' path rules
 * (`..` and a symlink out answer 400, a missing file 404), single `Range`
 * requests and `?download=1`. The caller has checked the token. The path
 * policy applies to every file read, as it does to a call from the hub.
 */
export async function serveDirectFile(
  ctx: WorkerContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  scope: DirectScopeParams,
  cors: Record<string, string>,
): Promise<void> {
  const end = (status: number, text: string) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(status, { "Content-Type": "text/plain", "Cache-Control": "no-store", ...cors });
    res.end(text);
  };
  if (req.method === "PUT") return putDirectFile(ctx, req, res, url, scope, cors);
  if (req.method !== "GET" && req.method !== "HEAD") return end(405, "Use GET");

  const { pathname } = url;
  let target: string;
  let cacheControl = "private, no-cache";
  let containedIn: string;
  let download = false;
  const isWorktreeFile = pathname.startsWith(DIRECT_FILE_ROUTES.worktreeFile);
  if (isWorktreeFile) {
    const rest = pathname.slice(DIRECT_FILE_ROUTES.worktreeFile.length);
    const slash = rest.indexOf("/");
    if (slash === -1) return end(400, "Bad request");
    const worktreeId = decode(rest.slice(0, slash));
    const rawPath = decode(rest.slice(slash + 1));
    if (!worktreeId || !rawPath) return end(400, "Bad request");
    if (worktreeId !== scope.worktreeId) return end(403, "The token is for another worktree");
    containedIn = scope.path;
    target = resolve(join(scope.path, rawPath));
    // Path traversal: the target must be within the worktree root.
    if (target !== scope.path && !target.startsWith(scope.path + sep)) {
      return end(400, "Bad request");
    }
    download = url.searchParams.get("download") === "1";
  } else {
    const dirs = hostDirs(ctx.policy.rootPaths);
    const isUploads = pathname.startsWith(DIRECT_FILE_ROUTES.uploads);
    const parsed = parseSharedPath(
      pathname.slice((isUploads ? DIRECT_FILE_ROUTES.uploads : DIRECT_FILE_ROUTES.shared).length),
    );
    // An upload is `<worktree>/<name>`; only a shared file has a chat in its path.
    if (!parsed || (isUploads && parsed.chatId !== undefined)) return end(400, "Bad request");
    if (parsed.worktreeId !== scope.worktreeId)
      return end(403, "The token is for another worktree");
    if (!dirs) return end(404, "Not found");
    const name = basename(parsed.name);
    if (!name || name === "." || name === "..") return end(404, "Not found");
    const base = isUploads ? dirs.uploads : dirs.shared;
    containedIn = parsed.chatId
      ? join(base, parsed.worktreeId, parsed.chatId)
      : join(base, parsed.worktreeId);
    target = join(containedIn, name);
    cacheControl = "private, max-age=86400";
  }

  const { fs } = ctx.host;
  res.once("close", ctx.activity.hold());
  try {
    // A symlink must not lead out of the worktree or the card's folder.
    const [realRoot, realTarget] = await Promise.all([
      fs.realpath(containedIn),
      fs.realpath(target),
    ]);
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
      return end(400, "Bad request");
    }
    // The path policy decides, as for a call from the hub.
    await ctx.policy.resolve(realTarget);
    const stat = await fs.stat(realTarget, { followSymlinks: true });
    // A folder has no bytes to stream.
    if (stat.kind !== "file") return download ? end(400, "Bad request") : end(404, "Not found");
    const contentType = mimeTypeFromFilename(basename(target));
    const range = parseByteRange(req.headers.range, stat.size);
    if (range === "unsatisfiable") {
      res.writeHead(416, { "Content-Range": `bytes */${stat.size}`, ...cors });
      res.end();
      return;
    }
    const partial = range !== null;
    res.writeHead(partial ? 206 : 200, {
      "Content-Type": contentType,
      "Content-Length": (partial ? range.end - range.start + 1 : stat.size).toString(),
      ...(partial ? { "Content-Range": `bytes ${range.start}-${range.end}/${stat.size}` } : {}),
      "Accept-Ranges": "bytes",
      "Cache-Control": cacheControl,
      ...hostedFileHeaders(contentType),
      ...(download ? { "Content-Disposition": attachmentDisposition(basename(target)) } : {}),
      ...cors,
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    const stream = Readable.from(fs.readStream(realTarget, range ?? undefined), {
      objectMode: false,
      highWaterMark: 64 * 1024,
    });
    // The client leaving must release the stream behind it.
    res.once("close", () => stream.destroy());
    pipeline(stream, res, () => {});
  } catch (err) {
    // A missing file is final. Any other failure (a path the worker's policy refuses, an IO
    // error) answers 500 so the client asks the hub, which may be able to read the file.
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") end(404, "Not found");
    else end(500, "Could not read the file");
  }
}
