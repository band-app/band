/**
 * `/git/context/<name>.git/...`: git smart HTTP for the hub's context repos
 * (plan step 5.1), served by `git http-backend`.
 *
 * Only the three smart-protocol paths are served (`info/refs`,
 * `git-upload-pack`, `git-receive-pack`), and the name must be a known context
 * with a strict name shape, so no path reaches outside `<BAND_HOME>/context`.
 * The dumb protocol is off. An admin device token reads and writes. Another
 * device token reads. A worker session token needs a host that carries every
 * label of the context, and then gets the context's `workerAccess`. Write
 * access is enforced twice: here, and by `http.receivepack` in the CGI's
 * environment.
 */

import { type ChildProcess, spawn } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createLogger } from "@band-app/logger";
import {
  contextGitEnv,
  contextRoot,
  contextService,
  hostLabelsMatch,
} from "../../services/context-service";
import { authenticate } from "./auth";

const log = createLogger("context-git");

export const CONTEXT_GIT_PREFIX = "/git/context/";
const ROUTE =
  /^\/git\/context\/([a-z0-9][a-z0-9_-]{0,62})\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

function deny(res: ServerResponse, status: number, message: string, extra = {}): void {
  res.writeHead(status, { "Content-Type": "text/plain", "Cache-Control": "no-store", ...extra });
  res.end(`${message}\n`);
}

/** Splits CGI output into its header block and the start of the body. */
function parseCgiHead(
  buf: Buffer,
): { status: number; headers: [string, string][]; rest: Buffer } | null {
  let end = buf.indexOf("\r\n\r\n");
  let sep = 4;
  if (end === -1) {
    end = buf.indexOf("\n\n");
    sep = 2;
  }
  if (end === -1) return null;
  const headers: [string, string][] = [];
  let status = 200;
  for (const line of buf.subarray(0, end).toString("utf8").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (name.toLowerCase() === "status") status = Number.parseInt(value, 10) || 200;
    else headers.push([name, value]);
  }
  return { status, headers, rest: buf.subarray(end + sep) };
}

export async function handleContextGit(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { authRequired: boolean },
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://hub.local");
  const principal = authenticate(req, { authRequired: opts.authRequired, allowCookie: false });
  if (!principal) {
    deny(res, 401, "Authentication required", { "WWW-Authenticate": 'Basic realm="band-context"' });
    return;
  }
  const match = ROUTE.exec(url.pathname);
  if (!match) {
    deny(res, 404, "Not found");
    return;
  }
  const [, name, service] = match;
  const row = contextService.find(name);
  if (!row) {
    deny(res, 404, "Not found");
    return;
  }

  let canWrite: boolean;
  if (principal.kind === "admin") canWrite = true;
  else if (principal.kind === "device") canWrite = false;
  else {
    if (!hostLabelsMatch(row.labels, principal.labels)) {
      log.warn(`worker host ${principal.hostId} refused for context ${name}: labels do not match`);
      deny(res, 403, "This host's labels do not allow this context");
      return;
    }
    canWrite = row.workerAccess === "read-write";
  }
  const writes =
    service === "git-receive-pack" ||
    (service === "info/refs" && url.searchParams.get("service") === "git-receive-pack");
  if (writes && !canWrite) {
    deny(res, 403, "This context is read-only for you");
    return;
  }
  if (req.method !== "GET" && req.method !== "POST") {
    deny(res, 405, "Method not allowed");
    return;
  }

  const env = contextGitEnv({
    GIT_PROJECT_ROOT: contextRoot(),
    GIT_HTTP_EXPORT_ALL: "1",
    REQUEST_METHOD: req.method,
    QUERY_STRING: url.search.slice(1),
    PATH_INFO: `/${name}.git/${service}`,
    CONTENT_TYPE: String(req.headers["content-type"] ?? ""),
    REMOTE_USER: principal.kind === "worker" ? principal.hostId : principal.kind,
    REMOTE_ADDR: req.socket.remoteAddress ?? "",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.receivepack",
    GIT_CONFIG_VALUE_0: canWrite ? "true" : "false",
  });
  if (req.headers["content-length"]) env.CONTENT_LENGTH = String(req.headers["content-length"]);
  if (req.headers["content-encoding"])
    env.HTTP_CONTENT_ENCODING = String(req.headers["content-encoding"]);
  if (req.headers["git-protocol"]) env.HTTP_GIT_PROTOCOL = String(req.headers["git-protocol"]);

  const child: ChildProcess = spawn("git", ["http-backend"], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let head = Buffer.alloc(0);
  let headDone = false;
  let status = 200;
  child.stderr?.on("data", (c: Buffer) =>
    log.warn(`http-backend: ${c.toString().trim().slice(0, 300)}`),
  );
  child.stdin?.on("error", () => {});
  req.pipe(child.stdin as NodeJS.WritableStream);
  res.on("close", () => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });

  child.stdout?.on("data", (chunk: Buffer) => {
    if (headDone) {
      if (!res.write(chunk)) {
        child.stdout?.pause();
        res.once("drain", () => child.stdout?.resume());
      }
      return;
    }
    head = Buffer.concat([head, chunk]);
    const parsed = parseCgiHead(head);
    if (!parsed) return;
    headDone = true;
    status = parsed.status;
    const headers: Record<string, string> = { "Cache-Control": "no-store" };
    for (const [k, v] of parsed.headers) headers[k] = v;
    res.writeHead(status, headers);
    if (parsed.rest.length) res.write(parsed.rest);
  });
  child.on("error", (err) => {
    log.error(`git http-backend failed to start: ${err.message}`);
    if (!res.headersSent) deny(res, 500, "Git is unavailable");
    else res.end();
  });
  child.on("close", () => {
    if (!headDone && !res.headersSent) deny(res, 500, "Git backend gave no answer");
    else res.end();
    if (service === "git-receive-pack" && status === 200) contextService.syncSoon(name);
  });
}
