// Integration test for `GET /api/worktree-file/<worktreeId>/<path>`, which the
// file viewer uses to preview images and PDFs. The real server reads the file
// through the worktree's host, so this covers the status, headers and bytes
// the browser receives, and the refusals for a missing file and a path that
// leaves the worktree.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings, seedState } from "./helpers/seed-state";
import { createTmpHome, type ServerHandle, startServer } from "./helpers/server";

const TOKEN = "worktree-file-serve-test-token";
const WORKTREE_ID = "files-main";

// NUL and high bytes, so a text decoding anywhere on the path corrupts them.
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe]);

describe("GET /api/worktree-file/<worktreeId>/<path>", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let worktree: string;

  const get = (path: string, init: { auth?: boolean } = {}) =>
    fetch(`${server.url}/api/worktree-file/${path}`, {
      headers: init.auth === false ? {} : { Cookie: `band_token=${TOKEN}` },
    });

  beforeAll(async () => {
    tmpHome = createTmpHome("band-worktree-file-test-");
    worktree = join(tmpHome, "files");
    mkdirSync(join(worktree, "assets"), { recursive: true });
    writeFileSync(join(worktree, "assets", "pixel.png"), PNG_BYTES);
    // A file next to the worktree, which a path escape would reach.
    writeFileSync(join(tmpHome, "secret.txt"), "outside the worktree");

    seedState(tmpHome, {
      repos: [
        {
          name: "files",
          path: worktree,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: worktree }],
        },
      ],
    });
    seedSettings(tmpHome, { tokenSecret: TOKEN });
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("serves a worktree file with its type, length and exact bytes", async () => {
    const res = await get(`${WORKTREE_ID}/assets/pixel.png`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-length")).toBe(String(PNG_BYTES.length));
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG_BYTES)).toBe(true);
  });

  it("returns 404 for a file that does not exist", async () => {
    const res = await get(`${WORKTREE_ID}/assets/missing.png`);

    expect(res.status).toBe(404);
  });

  it("returns 404 for an unknown worktree", async () => {
    const res = await get("nonexistent-main/assets/pixel.png");

    expect(res.status).toBe(404);
  });

  it("rejects a path that escapes the worktree", async () => {
    const res = await get(`${WORKTREE_ID}/${encodeURIComponent("../secret.txt")}`);

    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("outside the worktree");
  });

  it("rejects a request without a token", async () => {
    const res = await get(`${WORKTREE_ID}/assets/pixel.png`, { auth: false });

    expect(res.status).toBe(401);
  });
});
