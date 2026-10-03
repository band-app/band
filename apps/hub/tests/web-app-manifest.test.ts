/**
 * The web app manifest that keeps every Band URL inside the iOS home-screen
 * app (`scope: "/"`), and its icons. iOS fetches both without the session
 * cookie when the app is added, so they load without the token, and they must
 * not carry the token or any workspace data.
 *
 * Real production server, plain HTTP.
 */

import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings } from "./helpers/seed-state";
import { createTmpHome, type ServerHandle, startServer } from "./helpers/server";

const TOKEN = "web-app-manifest-test-token";

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
}

let server: ServerHandle;
let home: string;

beforeAll(async () => {
  home = createTmpHome("band-web-app-manifest-");
  seedSettings(home, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome: home });
});

afterAll(async () => {
  await server?.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** The manifest URL from the `<link rel="manifest">` in the page head. */
async function manifestHref(): Promise<string> {
  const res = await fetch(`${server.url}/?token=${TOKEN}`);
  expect(res.status).toBe(200);
  const html = await res.text();
  const href = /<link[^>]*rel="manifest"[^>]*href="([^"]+)"/.exec(html)?.[1];
  expect(href, "the page head links a manifest").toBeTruthy();
  return href!;
}

describe("web app manifest", () => {
  it("the page head links a manifest that keeps every Band URL in the app", async () => {
    const href = await manifestHref();
    const res = await fetch(new URL(href, server.url));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/manifest+json");
    const manifest = (await res.json()) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      name: "Band",
      start_url: "/",
      scope: "/",
      display: "standalone",
      theme_color: "#1e1e1e",
      background_color: "#1e1e1e",
    });
    const icons = manifest.icons as ManifestIcon[];
    expect(icons.map((i) => i.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]));
  });

  it("serves the manifest and every icon it lists without the token", async () => {
    const href = await manifestHref();
    const res = await fetch(new URL(href, server.url));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain(TOKEN);
    const { icons } = JSON.parse(body) as { icons: ManifestIcon[] };
    expect(icons.length).toBeGreaterThan(0);
    for (const icon of icons) {
      const iconRes = await fetch(new URL(icon.src, server.url));
      expect(iconRes.status, icon.src).toBe(200);
      expect(iconRes.headers.get("content-type")).toBe("image/png");
      const bytes = new Uint8Array(await iconRes.arrayBuffer());
      // PNG signature, then the IHDR width and height in big-endian.
      expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const view = new DataView(bytes.buffer);
      const [w, h] = icon.sizes.split("x").map(Number);
      expect(view.getUint32(16)).toBe(w);
      expect(view.getUint32(20)).toBe(h);
    }
  });

  it("serves the apple-touch-icon linked from the page head without the token", async () => {
    const html = await (await fetch(`${server.url}/?token=${TOKEN}`)).text();
    const href = /<link[^>]*rel="apple-touch-icon"[^>]*href="([^"]+)"/.exec(html)?.[1];
    expect(href).toBeTruthy();
    const res = await fetch(new URL(href!, server.url));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  it("answers HEAD for the manifest and keeps other methods behind the token", async () => {
    const head = await fetch(`${server.url}/manifest.webmanifest`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toContain("application/manifest+json");
    const post = await fetch(`${server.url}/manifest.webmanifest`, { method: "POST" });
    expect(post.status).toBe(401);
  });

  it("keeps every other route behind the token", async () => {
    expect((await fetch(`${server.url}/`)).status).toBe(401);
    expect((await fetch(`${server.url}/icons/other.png`)).status).toBe(401);
    expect((await fetch(`${server.url}/api/health`)).status).toBe(401);
  });
});
