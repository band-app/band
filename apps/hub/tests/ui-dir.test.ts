/**
 * Where the hub serves the UI from. `--ui-dir <path>` and `BAND_UI_DIR` name a
 * directory holding a built UI (`_shell.html` plus `assets/`); the hub serves
 * its files and answers every app route with that shell. With neither set it
 * serves the web workspace's own build (`apps/web/dist/client`), which
 * `web-app-manifest.test.ts` and `cold-start.test.ts` already exercise.
 *
 * Real production server, plain HTTP, a throwaway UI directory.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedSettings } from "./helpers/seed-state";
import { createTmpHome, type ServerHandle, startServer } from "./helpers/server";

const TOKEN = "ui-dir-test-token";

let home: string;
let uiDir: string;
let server: ServerHandle | undefined;

function writeUi(marker: string): void {
  mkdirSync(join(uiDir, "assets"), { recursive: true });
  writeFileSync(join(uiDir, "_shell.html"), `<!doctype html><title>${marker}</title>`);
  writeFileSync(join(uiDir, "assets", "app.js"), `// ${marker}`);
}

beforeEach(() => {
  home = createTmpHome("band-ui-dir-");
  seedSettings(home, { tokenSecret: TOKEN });
  uiDir = realpathSync(mkdtempSync(join(tmpdir(), "band-ui-dir-files-")));
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(uiDir, { recursive: true, force: true });
});

async function expectUiServed(marker: string): Promise<void> {
  const root = await fetch(`${server!.url}/?token=${TOKEN}`);
  expect(root.status).toBe(200);
  expect(await root.text()).toContain(`<title>${marker}</title>`);

  // Any app route gets the shell; hashed assets come from the directory.
  const route = await fetch(`${server!.url}/some/app/route?token=${TOKEN}`);
  expect(await route.text()).toContain(`<title>${marker}</title>`);
  const asset = await fetch(`${server!.url}/assets/app.js?token=${TOKEN}`);
  expect(asset.status).toBe(200);
  expect(await asset.text()).toContain(marker);

  // The API stays on the same port, and stays behind the token.
  const api = await fetch(`${server!.url}/trpc/projects.list?token=${TOKEN}`);
  expect(api.status).toBe(200);
  const anonymous = await fetch(`${server!.url}/trpc/projects.list`);
  expect(anonymous.status).toBe(401);
}

describe("UI directory", () => {
  it("serves the directory named by --ui-dir", async () => {
    writeUi("from-flag");
    server = await startServer({ tmpHome: home, args: ["--ui-dir", uiDir] });
    await expectUiServed("from-flag");
  });

  it("serves the directory named by BAND_UI_DIR", async () => {
    writeUi("from-env");
    server = await startServer({ tmpHome: home, env: { BAND_UI_DIR: uiDir } });
    await expectUiServed("from-env");
  });

  it("prefers --ui-dir over BAND_UI_DIR", async () => {
    writeUi("from-flag");
    server = await startServer({
      tmpHome: home,
      env: { BAND_UI_DIR: join(uiDir, "missing") },
      args: ["--ui-dir", uiDir],
    });
    await expectUiServed("from-flag");
  });
});
