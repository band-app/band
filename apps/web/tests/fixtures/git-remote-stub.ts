// Express stub for a git remote over dumb HTTP. It serves a bare repo's files
// as static files, which is all `git ls-remote` / `git remote set-head --auto`
// need once `git update-server-info` has written `info/refs`. Point a repo's
// `origin` at `url`.
//
// Every request waits until `release()`, so a test can park a server-side git
// call that talks to the remote at a known point.

import type { Server } from "node:http";
import { basename, dirname } from "node:path";
import express from "express";

export interface GitRemoteStub {
  /** Remote URL for the bare repo, e.g. `http://127.0.0.1:1234/origin.git`. */
  url: string;
  /** Resolves when the first request arrives. */
  firstRequest: Promise<void>;
  /** Answer every held request, and every later one at once. */
  release: () => void;
  stop: () => Promise<void>;
}

export async function startGitRemoteStub(bareRepoPath: string): Promise<GitRemoteStub> {
  let released = false;
  const waiting: Array<() => void> = [];
  let markFirstRequest!: () => void;
  const firstRequest = new Promise<void>((resolve) => {
    markFirstRequest = resolve;
  });

  const app = express();
  app.use((_req, _res, next) => {
    markFirstRequest();
    if (released) next();
    else waiting.push(next);
  });
  app.use(express.static(dirname(bareRepoPath), { dotfiles: "allow" }));

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("stub has no port");

  return {
    url: `http://127.0.0.1:${address.port}/${basename(bareRepoPath)}`,
    firstRequest,
    release: () => {
      released = true;
      for (const next of waiting.splice(0)) next();
    },
    stop: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
