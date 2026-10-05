// A git smart-HTTP server that requires basic auth, for tests of the worker's
// git credential helper. It runs `git http-backend` (CGI) over a directory of
// bare repositories, so clone, fetch and push work like they do against a real
// host. A request with the wrong or no credentials gets 401 with a challenge.

import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface GitHttpAuthStub {
  /** `127.0.0.1:<port>`, the host git sends to a credential helper. */
  host: string;
  /** Base URL, such as `http://127.0.0.1:1234`. A repo `proj.git` is at `<url>/proj.git`. */
  url: string;
  /** The usernames of requests that passed the auth check, in order. */
  authenticated: string[];
  /** How many requests were turned away with 401. */
  rejected: number;
  stop: () => Promise<void>;
}

export async function startGitHttpAuthStub(
  root: string,
  credentials: { username: string; password: string },
): Promise<GitHttpAuthStub> {
  const stub: GitHttpAuthStub = {
    host: "",
    url: "",
    authenticated: [],
    rejected: 0,
    stop: () => Promise.resolve(),
  };
  const expected = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`;

  const server: Server = createServer((req, res) => {
    if (req.headers.authorization !== expected) {
      stub.rejected++;
      req.resume();
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="git"' });
      res.end("authentication required");
      return;
    }
    stub.authenticated.push(credentials.username);
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url ?? "/", "http://stub");
      const child = spawn("git", ["http-backend"], {
        env: {
          PATH: process.env.PATH ?? "",
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: "1",
          REQUEST_METHOD: req.method ?? "GET",
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          CONTENT_TYPE: req.headers["content-type"] ?? "",
          CONTENT_LENGTH: String(body.length),
          HTTP_CONTENT_ENCODING: String(req.headers["content-encoding"] ?? ""),
          HTTP_GIT_PROTOCOL: String(req.headers["git-protocol"] ?? ""),
          REMOTE_USER: credentials.username,
          REMOTE_ADDR: "127.0.0.1",
        },
        stdio: ["pipe", "pipe", "ignore"],
      });
      const out: Buffer[] = [];
      child.stdout.on("data", (c: Buffer) => out.push(c));
      child.on("close", () => {
        const all = Buffer.concat(out);
        const split = all.indexOf("\r\n\r\n");
        if (split < 0) {
          res.writeHead(500).end();
          return;
        }
        const headers: Record<string, string> = {};
        let status = 200;
        for (const line of all.subarray(0, split).toString("utf8").split("\r\n")) {
          const colon = line.indexOf(":");
          if (colon < 0) continue;
          const name = line.slice(0, colon).trim();
          const value = line.slice(colon + 1).trim();
          if (name.toLowerCase() === "status") status = Number.parseInt(value, 10) || 200;
          else headers[name] = value;
        }
        res.writeHead(status, headers);
        res.end(all.subarray(split + 4));
      });
      child.stdin.end(body);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  stub.host = `127.0.0.1:${port}`;
  stub.url = `http://127.0.0.1:${port}`;
  stub.stop = () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return stub;
}
