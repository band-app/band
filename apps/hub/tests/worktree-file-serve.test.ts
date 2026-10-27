// Integration test for `GET /api/worktree-file/<worktreeId>/<path>`, which the
// file viewer uses to preview images and PDFs. The real server reads the file
// through the worktree's host, so this covers the status, headers and bytes
// the browser receives, and the refusals for a missing file and a path that
// leaves the worktree.

import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings, seedState } from "./helpers/seed-state";
import { createTmpHome, type ServerHandle, startServer } from "./helpers/server";
import { testWorktreeId } from "./helpers/test-host";

const TOKEN = "worktree-file-serve-test-token";
const WORKTREE_ID = testWorktreeId("files", "main");

// NUL and high bytes, so a text decoding anywhere on the path corrupts them.
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe]);

const PDF_BYTES = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from([0x00, 0xff, 0xfe, 0x80])]);

const BIG_BYTES = Buffer.alloc(6 * 1024 * 1024 + 7, "band-big-file-");

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
    writeFileSync(join(worktree, "assets", "doc.pdf"), PDF_BYTES);
    writeFileSync(
      join(worktree, "assets", "logo.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
    );
    mkdirSync(join(worktree, ".am", "evidence"), { recursive: true });
    writeFileSync(join(worktree, ".am", "evidence", "shot.png"), PNG_BYTES);
    // Several MB, so the route has to stream it in more than one chunk.
    writeFileSync(join(worktree, "assets", "big.bin"), BIG_BYTES);
    writeFileSync(join(worktree, "assets", "clip.mp4"), BIG_BYTES);
    writeFileSync(join(worktree, "assets", 'we"ird; näme.txt'), "odd name");
    // A symlink that points out of the worktree.
    symlinkSync(join(tmpHome, "secret.txt"), join(worktree, "assets", "escape.txt"));
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

  it("serves a file under a dot folder", async () => {
    const res = await get(`${WORKTREE_ID}/.am/evidence/shot.png`);

    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG_BYTES)).toBe(true);
  });

  it("serves a file when the token is in the query string, as an <img> against a remote hub sends it", async () => {
    const res = await fetch(
      `${server.url}/api/worktree-file/${WORKTREE_ID}/assets/pixel.png?token=${TOKEN}`,
    );

    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG_BYTES)).toBe(true);
  });

  it("refuses a wrong token in the query string", async () => {
    const res = await fetch(
      `${server.url}/api/worktree-file/${WORKTREE_ID}/assets/pixel.png?token=wrong`,
    );

    expect(res.status).toBe(401);
  });

  it("answers 400 for a malformed escape in the path", async () => {
    const res = await get(`${WORKTREE_ID}/assets/%zz`);

    expect(res.status).toBe(400);
  });

  it("sandboxes an SVG and never lets a type be sniffed", async () => {
    const svg = await get(`${WORKTREE_ID}/assets/logo.svg`);
    const png = await get(`${WORKTREE_ID}/assets/pixel.png`);

    expect(svg.headers.get("content-security-policy")).toContain("sandbox");
    expect(svg.headers.get("x-content-type-options")).toBe("nosniff");
    expect(png.headers.get("x-content-type-options")).toBe("nosniff");
    await svg.arrayBuffer();
    await png.arrayBuffer();
  });

  it("serves a PDF with its type and exact bytes", async () => {
    const res = await get(`${WORKTREE_ID}/assets/doc.pdf`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(await res.arrayBuffer()).equals(PDF_BYTES)).toBe(true);
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

  describe("Range requests, which a video player uses to seek", () => {
    const ranged = (path: string, range: string) =>
      fetch(`${server.url}/api/worktree-file/${path}`, {
        headers: { Cookie: `band_token=${TOKEN}`, Range: range },
      });

    it("advertises byte ranges and types a video", async () => {
      const res = await get(`${WORKTREE_ID}/assets/clip.mp4`);

      expect(res.status).toBe(200);
      expect(res.headers.get("accept-ranges")).toBe("bytes");
      expect(res.headers.get("content-type")).toBe("video/mp4");
      expect(Buffer.from(await res.arrayBuffer()).equals(BIG_BYTES)).toBe(true);
    });

    it("answers 206 with the requested bytes from the middle of a file", async () => {
      const res = await ranged(`${WORKTREE_ID}/assets/clip.mp4`, "bytes=1000000-1000099");

      expect(res.status).toBe(206);
      expect(res.headers.get("content-range")).toBe(`bytes 1000000-1000099/${BIG_BYTES.length}`);
      expect(res.headers.get("content-length")).toBe("100");
      expect(
        Buffer.from(await res.arrayBuffer()).equals(BIG_BYTES.subarray(1000000, 1000100)),
      ).toBe(true);
    });

    it("handles an open-ended range and a suffix range", async () => {
      const open = await ranged(`${WORKTREE_ID}/assets/clip.mp4`, `bytes=${BIG_BYTES.length - 5}-`);
      const suffix = await ranged(`${WORKTREE_ID}/assets/clip.mp4`, "bytes=-7");

      expect(open.status).toBe(206);
      expect(Buffer.from(await open.arrayBuffer()).equals(BIG_BYTES.subarray(-5))).toBe(true);
      expect(suffix.status).toBe(206);
      expect(Buffer.from(await suffix.arrayBuffer()).equals(BIG_BYTES.subarray(-7))).toBe(true);
    });

    it("ignores a range whose end precedes its start", async () => {
      const res = await ranged(`${WORKTREE_ID}/assets/clip.mp4`, "bytes=5-2");

      expect(res.status).toBe(200);
      expect(res.headers.get("content-length")).toBe(String(BIG_BYTES.length));
      await res.arrayBuffer();
    });

    it("answers 416 for a range past the end of the file", async () => {
      const res = await ranged(`${WORKTREE_ID}/assets/clip.mp4`, `bytes=${BIG_BYTES.length}-`);

      expect(res.status).toBe(416);
      expect(res.headers.get("content-range")).toBe(`bytes */${BIG_BYTES.length}`);
    });

    it("serves the whole file for a header it does not understand", async () => {
      const res = await ranged(`${WORKTREE_ID}/assets/clip.mp4`, "bytes=0-1,5-9");

      expect(res.status).toBe(200);
      expect(Buffer.from(await res.arrayBuffer()).equals(BIG_BYTES)).toBe(true);
    });

    it("still refuses a ranged request without a token", async () => {
      const res = await fetch(`${server.url}/api/worktree-file/${WORKTREE_ID}/assets/clip.mp4`, {
        headers: { Range: "bytes=0-9" },
      });

      expect(res.status).toBe(401);
    });
  });

  describe("?download=1", () => {
    it("sends the exact bytes as an attachment with the file name", async () => {
      const res = await get(`${WORKTREE_ID}/assets/pixel.png?download=1`);

      expect(res.status).toBe(200);
      expect(res.headers.get("content-disposition")).toBe(
        `attachment; filename="pixel.png"; filename*=UTF-8''pixel.png`,
      );
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(Buffer.from(await res.arrayBuffer()).equals(PNG_BYTES)).toBe(true);
    });

    it("encodes a name with quotes, a semicolon and non-ASCII characters", async () => {
      const name = encodeURIComponent('we"ird; näme.txt');
      const res = await get(`${WORKTREE_ID}/assets/${name}?download=1`);

      expect(res.status).toBe(200);
      const disposition = res.headers.get("content-disposition") ?? "";
      expect(disposition).toContain('filename="we_ird_ n_me.txt"');
      expect(disposition).toContain("filename*=UTF-8''we%22ird%3B%20n%C3%A4me.txt");
      expect(await res.text()).toBe("odd name");
    });

    it("streams a file of several MB with unchanged bytes", async () => {
      const res = await get(`${WORKTREE_ID}/assets/big.bin?download=1`);

      expect(res.status).toBe(200);
      expect(res.headers.get("content-length")).toBe(String(BIG_BYTES.length));
      expect(Buffer.from(await res.arrayBuffer()).equals(BIG_BYTES)).toBe(true);
    });

    it("refuses a folder", async () => {
      const res = await get(`${WORKTREE_ID}/assets?download=1`);

      expect(res.status).toBe(400);
    });

    it("refuses a path that leaves the worktree and a symlink that points out", async () => {
      const escaped = await get(`${WORKTREE_ID}/${encodeURIComponent("../secret.txt")}?download=1`);
      const absolute = await get(
        `${WORKTREE_ID}/${encodeURIComponent(join(tmpHome, "secret.txt"))}?download=1`,
      );
      const symlink = await get(`${WORKTREE_ID}/assets/escape.txt?download=1`);

      // An absolute path is joined under the worktree root, so it finds nothing.
      expect(escaped.status).toBe(400);
      expect(symlink.status).toBe(400);
      expect(absolute.status).toBe(404);
      for (const res of [escaped, absolute, symlink]) {
        expect(await res.text()).not.toContain("outside the worktree");
      }
    });

    it("refuses a request without a token", async () => {
      const res = await get(`${WORKTREE_ID}/assets/pixel.png?download=1`, { auth: false });

      expect(res.status).toBe(401);
    });
  });
});
