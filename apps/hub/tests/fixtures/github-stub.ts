// Express stub for github.com, the host Band fetches project owner avatars
// from (`GET /<owner>.png?size=64`). The server reads its base URL from
// `BAND_GITHUB_URL` at request time. Shared by backend tests and e2e specs.

import type { Server } from "node:http";
import express, { type Request, type Response } from "express";

export interface CapturedAvatarRequest {
  method: string;
  path: string;
  query: Record<string, unknown>;
}

export interface GitHubStub {
  baseUrl: string;
  /** Serve `body` as `/<owner>.png`. */
  setAvatar: (
    owner: string,
    body: Buffer,
    opts?: { contentType?: string; onRequest?: (r: CapturedAvatarRequest) => void },
  ) => void;
  /** Answer `/<owner>.png` with a bare status, e.g. 404 for an unknown login. */
  setAvatarStatus: (
    owner: string,
    status: number,
    opts?: { onRequest?: (r: CapturedAvatarRequest) => void },
  ) => void;
  /** Answer `/<owner>.png` with a 302 to `location`, the way github.com
   *  redirects to its avatar CDN. */
  setAvatarRedirect: (
    owner: string,
    location: string,
    opts?: { onRequest?: (r: CapturedAvatarRequest) => void },
  ) => void;
  stop: () => Promise<void>;
}

function capture(req: Request): CapturedAvatarRequest {
  return { method: req.method, path: req.path, query: { ...req.query } };
}

export const githubStub = {
  async start(): Promise<GitHubStub> {
    const app = express();
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const port = (server.address() as { port: number }).port;

    return {
      baseUrl: `http://127.0.0.1:${port}`,
      setAvatar(owner, body, opts) {
        app.get(`/${owner}.png`, (req: Request, res: Response) => {
          opts?.onRequest?.(capture(req));
          res
            .status(200)
            .type(opts?.contentType ?? "image/png")
            .send(body);
        });
      },
      setAvatarStatus(owner, status, opts) {
        app.get(`/${owner}.png`, (req: Request, res: Response) => {
          opts?.onRequest?.(capture(req));
          res.sendStatus(status);
        });
      },
      setAvatarRedirect(owner, location, opts) {
        app.get(`/${owner}.png`, (req: Request, res: Response) => {
          opts?.onRequest?.(capture(req));
          res.redirect(302, location);
        });
      },
      stop: () =>
        new Promise<void>((r) => {
          server.closeAllConnections();
          server.close(() => r());
        }),
    };
  },
};
