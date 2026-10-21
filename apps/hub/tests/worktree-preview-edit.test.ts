// Integration test for the edit mode of the signed worktree preview route:
// `?band-edit=<nonce>` on an HTML file adds `data-band-src="<start>:<end>"` to
// elements whose only text comes straight from the source, and one script.
// The ranges must index the original file. Run with
// `BAND_TEST_HOST=remote-loopback` it reads the files from a real worker.

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

const TOKEN = "worktree-preview-edit-test-token";
const SITE_ID = testWorktreeId("site", "main");
const NONCE = "nonce-abcdef12";

const SLIDES_HTML = [
  "<!doctype html>\r\n",
  "<html>\r\n",
  "<head><title>Deck &amp; co</title><style>h1 { color: red; }</style></head>\r\n",
  "<body>\r\n",
  "  <!-- a comment -->\r\n",
  '  <h1   class="big" id="t">\r\n    Héllo 😀 &amp; wörld\r\n  </h1>\r\n',
  "  <p>Plain <b>mixed</b> content</p>\r\n",
  "  <p>Two<br>lines</p>\r\n",
  '  <div id="runtime"></div>\r\n',
  "  <pre>\npreformatted</pre>\r\n",
  "  <script>document.getElementById('runtime').textContent = 'from script';</script>\r\n",
  "  <ul><li>one</li><li> two </li></ul>\r\n",
  '  <svg><text x="1">svg text</text></svg>\r\n',
  "</body>\r\n",
  "</html>\r\n",
].join("");

describe("worktree preview edit mode", () => {
  let server: ServerHandle;
  let tmpHome: string;

  async function previewUrl(path: string): Promise<string> {
    const res = await trpcQuery(
      server.url,
      "worktree.previewUrl",
      { worktreeId: SITE_ID, path },
      TOKEN,
    );
    expect(res.status).toBe(200);
    return `${server.url}${(await trpcData<{ url: string }>(res)).url}`;
  }

  /** `[start, end, attribute-carrying tag name]` for each annotated element. */
  function annotations(html: string): { start: number; end: number; tag: string }[] {
    return [...html.matchAll(/<([a-z0-9]+)[^>]*? data-band-src="(\d+):(\d+)"/g)].map((m) => ({
      tag: m[1],
      start: Number(m[2]),
      end: Number(m[3]),
    }));
  }

  /** The served page without the inserted attributes and script. */
  function stripEdit(html: string): string {
    return html
      .replace(/ data-band-src="\d+:\d+"/g, "")
      .replace(/\n<script data-band-visual-edit>[\s\S]*<\/script>$/, "");
  }

  beforeAll(async () => {
    tmpHome = createTmpHome("band-worktree-preview-edit-test-");
    const site = join(tmpHome, "site");
    mkdirSync(join(site, "deck"), { recursive: true });
    writeFileSync(join(site, "deck", "slides.html"), SLIDES_HTML);
    writeFileSync(join(site, "deck", "big.html"), `<p>big</p>${"<!-- pad -->".repeat(250_000)}`);
    writeFileSync(join(site, "deck", "style.css"), "h1 { color: rgb(1, 2, 3); }");
    seedState(tmpHome, {
      repos: [
        {
          name: "site",
          path: site,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: site }],
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

  it("annotates only the text of ordinary elements, with ranges into the original file", async () => {
    const page = await previewUrl("deck/slides.html");
    const res = await fetch(`${page}?band-edit=${NONCE}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(res.headers.get("content-security-policy")).not.toContain("allow-same-origin");
    const html = await res.text();

    const found = annotations(html);
    expect(found.map((a) => a.tag)).toEqual(["h1", "b", "li", "li"]);
    expect(found.map((a) => SLIDES_HTML.slice(a.start, a.end))).toEqual([
      "\r\n    Héllo 😀 &amp; wörld\r\n  ",
      "mixed",
      "one",
      " two ",
    ]);

    // Nothing but the attributes and the script differs from the file.
    expect(stripEdit(html)).toBe(SLIDES_HTML);
    expect(html.match(/<script data-band-visual-edit>/g)).toHaveLength(1);
    expect(html).toContain(`var NONCE="${NONCE}"`);
    expect(Number(res.headers.get("content-length"))).toBe(Buffer.byteLength(html));
  });

  it("serves the file unchanged without the flag and ignores a malformed nonce", async () => {
    const page = await previewUrl("deck/slides.html");

    expect(await (await fetch(page)).text()).toBe(SLIDES_HTML);
    expect(await (await fetch(`${page}?band-edit=`)).text()).toBe(SLIDES_HTML);
    expect(await (await fetch(`${page}?band-edit=x%22%3E%3Cscript`)).text()).toBe(SLIDES_HTML);
  });

  it("leaves other served files alone in edit mode", async () => {
    const page = await previewUrl("deck/slides.html");
    const css = new URL("style.css", page);
    css.search = `?band-edit=${NONCE}`;

    expect(await (await fetch(css)).text()).toBe("h1 { color: rgb(1, 2, 3); }");
  });

  it("keeps the grant rules in edit mode", async () => {
    const page = await previewUrl("deck/slides.html");
    const tampered = page.replace(/\.[0-9a-f]{64}\//, `.${"0".repeat(64)}/`);

    expect((await fetch(`${tampered}?band-edit=${NONCE}`)).status).toBe(403);
  });

  it("serves a file above the size cap unannotated with an unavailable script", async () => {
    const page = await previewUrl("deck/big.html");
    const res = await fetch(`${page}?band-edit=${NONCE}`);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).not.toMatch(/data-band-src="\d/);
    expect(html.startsWith("<p>big</p>")).toBe(true);
    expect(html).toContain("var DISABLED=true");
    expect(Number(res.headers.get("content-length"))).toBe(Buffer.byteLength(html));
  });
});
