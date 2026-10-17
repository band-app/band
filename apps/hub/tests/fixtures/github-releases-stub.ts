// Express stub for GitHub's "latest release" endpoint. The hub's release check reads
// `BAND_GITHUB_API_URL` on every call and asks `GET /repos/band-app/band/releases/latest`.

import type { Server } from "node:http";
import express from "express";

export interface ReleasesStub {
  url: string;
  /** Number of release lookups so far. */
  requests: () => number;
  /** The tag the stub answers with, such as `v0.9.0`. */
  setLatest: (tag: string) => void;
  /** Answer with this HTTP status instead of a release, or null to answer normally again. */
  failWith: (status: number | null) => void;
  close: () => Promise<void>;
}

export async function startReleasesStub(tag: string): Promise<ReleasesStub> {
  let latest = tag;
  let failing: number | null = null;
  let count = 0;
  const app = express();
  app.get("/repos/band-app/band/releases/latest", (_req, res) => {
    count++;
    if (failing !== null) {
      res.status(failing).json({ message: "stub failure" });
      return;
    }
    res.json({ tag_name: latest, draft: false, prerelease: false });
  });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    requests: () => count,
    setLatest: (t) => {
      latest = t;
    },
    failWith: (status) => {
      failing = status;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
