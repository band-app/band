// Integration test for the signed worktree file route behind the file viewer's
// HTML Preview button: `worktree.previewUrl` hands out
// `/api/worktree-preview/<worktreeId>/<grant>/<path>`, which a browser tab
// loads without the hub's auth header. Relative URLs in the page resolve under
// the grant, and the grant covers one worktree. Run with
// `BAND_TEST_HOST=remote-loopback` it reads the files from a real worker.

import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

const TOKEN = "worktree-preview-test-token";
const SITE_ID = testWorktreeId("site", "main");
const OTHER_ID = testWorktreeId("other", "main");

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe]);
const SECRET = "top-secret-from-another-worktree";
const INDEX_HTML =
  '<!doctype html><link rel="stylesheet" href="style.css"><img src="img/logo.png"><p>héllo</p>';

describe("GET /api/worktree-preview/<worktreeId>/<grant>/<path>", () => {
  let server: ServerHandle;
  let tmpHome: string;

  async function previewUrl(worktreeId: string, path: string): Promise<string> {
    const res = await trpcQuery(server.url, "worktree.previewUrl", { worktreeId, path }, TOKEN);
    expect(res.status).toBe(200);
    return `${server.url}${(await trpcData<{ url: string }>(res)).url}`;
  }

  /** The URL a relative reference in the page at `pageUrl` resolves to. */
  const resolveRelative = (pageUrl: string, ref: string) => new URL(ref, pageUrl).toString();

  beforeAll(async () => {
    tmpHome = createTmpHome("band-worktree-preview-test-");
    const site = join(tmpHome, "site");
    const other = join(tmpHome, "other");
    mkdirSync(join(site, "site", "img"), { recursive: true });
    mkdirSync(other, { recursive: true });
    writeFileSync(join(site, "site", "index.html"), INDEX_HTML);
    writeFileSync(join(site, "site", "style.css"), "p { color: rgb(1, 2, 3); }");
    writeFileSync(join(site, "site", "img", "logo.png"), PNG_BYTES);
    writeFileSync(join(site, "root.txt"), "root file");
    writeFileSync(join(other, "secret.txt"), SECRET);
    symlinkSync(join(other, "secret.txt"), join(site, "site", "leak.txt"));

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

  it("serves the page and its relative assets with no auth header", async () => {
    const page = await previewUrl(SITE_ID, "site/index.html");

    const html = await fetch(page);
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await html.text()).toBe(INDEX_HTML);

    const css = await fetch(resolveRelative(page, "style.css"));
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(await css.text()).toContain("rgb(1, 2, 3)");

    const logo = await fetch(resolveRelative(page, "img/logo.png"));
    expect(logo.status).toBe(200);
    expect(Buffer.from(await logo.arrayBuffer()).equals(PNG_BYTES)).toBe(true);
  });

  it("serves the new content after the file changes on disk", async () => {
    const page = await previewUrl(SITE_ID, "site/index.html");
    writeFileSync(join(tmpHome, "site", "site", "index.html"), "<p>edited</p>");

    expect(await (await fetch(page)).text()).toBe("<p>edited</p>");
  });

  it("refuses a tampered or expired grant", async () => {
    const page = await previewUrl(SITE_ID, "site/index.html");
    const tampered = page.replace(/\.[0-9a-f]{64}\//, `.${"0".repeat(64)}/`);
    expect((await fetch(tampered)).status).toBe(403);

    const expired = page.replace(/\/\d{10,}\./, "/1000.");
    expect((await fetch(expired)).status).toBe(403);
  });

  it("refuses a grant for another worktree", async () => {
    const page = await previewUrl(OTHER_ID, "index.html");
    const crossed = page.replace(encodeURIComponent(OTHER_ID), encodeURIComponent(SITE_ID));

    expect((await fetch(crossed)).status).toBe(403);
  });

  it("does not open the authenticated route to a bare request", async () => {
    const res = await fetch(`${server.url}/api/worktree-file/${SITE_ID}/site/style.css`);

    expect(res.status).toBe(401);
  });

  it("refuses a path that leaves the grant's directory or the worktree", async () => {
    const page = await previewUrl(SITE_ID, "site/index.html");
    const grantEnd = page.indexOf("/site/index.html");
    const base = page.slice(0, grantEnd);

    const sibling = await fetch(`${base}/${encodeURIComponent("../root.txt")}`);
    expect(sibling.status).toBe(403);
    expect(await sibling.text()).not.toContain("root file");

    const outside = await fetch(`${base}/${encodeURIComponent("../../other/secret.txt")}`);
    expect(outside.status).toBe(403);
    expect(await outside.text()).not.toContain(SECRET);

    // Another directory of the same worktree is outside the grant too.
    expect((await fetch(`${base}/root.txt`)).status).toBe(403);
  });

  it("does not follow a symlink out of the worktree", async () => {
    const page = await previewUrl(SITE_ID, "site/index.html");
    const res = await fetch(resolveRelative(page, "leak.txt"));

    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain(SECRET);
  });

  it("refuses a missing or malformed grant", async () => {
    const base = `${server.url}/api/worktree-preview/${encodeURIComponent(SITE_ID)}`;

    expect((await fetch(`${base}/abc/site/index.html`)).status).toBe(403);
    expect((await fetch(`${base}/1.2.3.4/site/index.html`)).status).toBe(403);
    expect((await fetch(`${base}/site/index.html`)).status).toBe(403);
    expect((await fetch(`${base}/`)).status).toBe(400);
  });

  it("answers previewUrl only to an authenticated caller for a known worktree", async () => {
    const input = encodeURIComponent(
      JSON.stringify({ worktreeId: SITE_ID, path: "site/index.html" }),
    );
    const noToken = await fetch(`${server.url}/trpc/worktree.previewUrl?input=${input}`);
    expect(noToken.status).toBe(401);

    const unknown = await trpcQuery(
      server.url,
      "worktree.previewUrl",
      { worktreeId: "nope-main", path: "index.html" },
      TOKEN,
    );
    expect(unknown.status).toBe(404);
  });

  it("serves the page sandboxed away from the hub's origin", async () => {
    const page = await previewUrl(SITE_ID, "site/index.html");
    const res = await fetch(page);

    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(res.headers.get("content-security-policy")).not.toContain("allow-same-origin");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("sandboxes HTML served by the authenticated worktree-file route too", async () => {
    const res = await fetch(
      `${server.url}/api/worktree-file/${encodeURIComponent(SITE_ID)}/site/index.html`,
      {
        headers: { Authorization: `Bearer ${TOKEN}` },
      },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
  });
});
