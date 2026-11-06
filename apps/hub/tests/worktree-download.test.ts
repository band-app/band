// Integration test for the signed one-file download behind a drag out of the
// Explorer: `worktree.downloadUrl` hands out
// `/api/worktree-download/<worktreeId>/<grant>/<path>`, which another app
// fetches without the hub's auth header. The grant covers one file. Run with
// `BAND_TEST_HOST=remote-loopback` it reads the bytes from a real worker.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcQuery,
} from "./helpers/server";
import { testWorktreeId } from "./helpers/test-host";

const TOKEN = "worktree-download-test-token";
const SITE_ID = testWorktreeId("site", "main");
const OTHER_ID = testWorktreeId("other", "main");
const BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x10]);

describe("GET /api/worktree-download/<worktreeId>/<grant>/<path>", () => {
  let server: ServerHandle;
  let tmpHome: string;

  async function downloadUrl(worktreeId: string, path: string): Promise<string> {
    const res = await trpcQuery(server.url, "worktree.downloadUrl", { worktreeId, path }, TOKEN);
    expect(res.status).toBe(200);
    return `${server.url}${(await trpcData<{ url: string }>(res)).url}`;
  }

  beforeAll(async () => {
    tmpHome = createTmpHome("band-worktree-download-test-");
    const site = join(tmpHome, "site");
    const other = join(tmpHome, "other");
    mkdirSync(join(site, "dir"), { recursive: true });
    mkdirSync(other, { recursive: true });
    writeFileSync(join(site, "dir", "logo.png"), BYTES);
    writeFileSync(join(site, "dir", "other.txt"), "sibling");
    writeFileSync(join(other, "logo.png"), "other worktree");
    seedState(tmpHome, {
      repos: [
        {
          name: "site",
          path: site,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: site }],
        },
        {
          name: "other",
          path: other,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: other }],
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

  it("returns the file as an attachment with no auth header", async () => {
    const res = await fetch(await downloadUrl(SITE_ID, "dir/logo.png"));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("content-disposition")).toContain("logo.png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await res.arrayBuffer()).equals(BYTES)).toBe(true);
  });

  it("refuses another path in the same worktree", async () => {
    const url = await downloadUrl(SITE_ID, "dir/logo.png");
    const other = url.replace("logo.png", "other.txt");

    const res = await fetch(other);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("sibling");
  });

  it("refuses the same path in another worktree", async () => {
    const url = await downloadUrl(OTHER_ID, "logo.png");
    const crossed = url.replace(encodeURIComponent(OTHER_ID), encodeURIComponent(SITE_ID));

    expect((await fetch(crossed)).status).toBe(403);
  });

  it("refuses an expired or tampered grant", async () => {
    const url = await downloadUrl(SITE_ID, "dir/logo.png");

    expect((await fetch(url.replace(/\/\d{10,}\./, "/1000."))).status).toBe(403);
    expect((await fetch(url.replace(/\.[0-9a-f]{64}\//, `.${"0".repeat(64)}/`))).status).toBe(403);
  });

  it("refuses a preview grant and a bare request", async () => {
    const preview = await trpcQuery(
      server.url,
      "worktree.previewUrl",
      { worktreeId: SITE_ID, path: "dir/logo.png" },
      TOKEN,
    );
    const { url } = await trpcData<{ url: string }>(preview);
    const asDownload = `${server.url}${url.replace("/api/worktree-preview/", "/api/worktree-download/")}`;
    expect((await fetch(asDownload)).status).toBe(403);

    const bare = await fetch(`${server.url}/api/worktree-file/${SITE_ID}/dir/logo.png?download=1`);
    expect(bare.status).toBe(401);
  });

  it("refuses to mint without a device token and for a folder", async () => {
    const noAuth = await trpcQuery(
      server.url,
      "worktree.downloadUrl",
      { worktreeId: SITE_ID, path: "dir/logo.png" },
      "wrong-token",
    );
    expect(noAuth.status).toBe(401);

    const folder = await fetch(await downloadUrl(SITE_ID, "dir"));
    expect(folder.status).toBe(400);
  });
});
