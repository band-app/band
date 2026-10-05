/**
 * Headless hub settings (plan step 2.7): `BAND_SERVE_UI`, `BAND_ALLOWED_ORIGINS`
 * and the admin token on first run. Real production server on random ports,
 * each test on its own temporary BAND_HOME.
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { seedSettings } from "./helpers/seed-state";
import {
  createTmpHome,
  getRandomPort,
  type ServerHandle,
  startServer,
  waitForProcessGroupExit,
} from "./helpers/server";
import { SERVER_RUNTIME, SERVER_SCRIPT } from "./helpers/server-runtime";
import { stopTerminalDaemon } from "./helpers/terminal-daemon";
import { removeTmpHome } from "./helpers/tmp-home";

const TOKEN = "headless-test-token";
// The tests run without a built UI, so every server gets a stub one.
let stubUi: string | undefined;
function uiDir(): string {
  stubUi ??= writeUi();
  return stubUi;
}
const bearer = { Authorization: `Bearer ${TOKEN}` };

const homes: string[] = [];
const servers: ServerHandle[] = [];

async function boot(opts: {
  settings?: object;
  env?: Record<string, string>;
  home?: string;
}): Promise<ServerHandle> {
  const home = opts.home ?? createTmpHome("band-headless-");
  if (!opts.home) homes.push(home);
  if (opts.settings) seedSettings(home, opts.settings);
  const server = await startServer({
    tmpHome: home,
    env: { BAND_UI_DIR: uiDir(), ...opts.env },
  });
  servers.push(server);
  return server;
}

afterAll(() => {
  if (stubUi) rmSync(stubUi, { recursive: true, force: true });
});

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const h of homes.splice(0)) {
    removeTmpHome(h);
  }
});

function writeUi(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "band-headless-ui-")));
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "_shell.html"), "<!doctype html><title>headless-ui</title>");
  return dir;
}

function openSocket(url: string, origin: string): Promise<"open" | "refused"> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${url.replace("http", "ws")}/trpc`, ["band", `band-token.${TOKEN}`], {
      headers: { Origin: origin },
    });
    ws.on("open", () => {
      ws.close();
      resolve("open");
    });
    ws.on("error", () => resolve("refused"));
    ws.on("unexpected-response", () => resolve("refused"));
  });
}

describe("BAND_SERVE_UI", () => {
  it("serves the UI by default", async () => {
    const server = await boot({
      settings: { tokenSecret: TOKEN },
      env: { BAND_UI_DIR: uiDir() },
    });
    const res = await fetch(`${server.url}/`, { headers: bearer });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("headless-ui");
  });

  it("answers 404 for the UI and keeps the API when false", async () => {
    const server = await boot({
      settings: { tokenSecret: TOKEN },
      env: { BAND_UI_DIR: uiDir(), BAND_SERVE_UI: "false" },
    });
    expect((await fetch(`${server.url}/`, { headers: bearer })).status).toBe(404);
    expect((await fetch(`${server.url}/some/route`, { headers: bearer })).status).toBe(404);
    expect((await fetch(`${server.url}/api/health`, { headers: bearer })).status).toBe(200);
    expect((await fetch(`${server.url}/trpc/projects.list`, { headers: bearer })).status).toBe(200);
    expect((await fetch(`${server.url}/trpc/projects.list`)).status).toBe(401);
  });

  it("boots without a UI build when false", async () => {
    const server = await boot({
      settings: { tokenSecret: TOKEN },
      env: { BAND_UI_DIR: join(tmpdir(), "band-no-such-ui-dir"), BAND_SERVE_UI: "false" },
    });
    expect((await fetch(`${server.url}/api/health`, { headers: bearer })).status).toBe(200);
  });
});

describe("BAND_ALLOWED_ORIGINS", () => {
  const LISTED = "https://ui.listed.test";
  const UNLISTED = "https://ui.unlisted.test";

  it("lets a listed origin call the API and open a WebSocket, and refuses others", async () => {
    const server = await boot({
      settings: { tokenSecret: TOKEN },
      env: { BAND_ALLOWED_ORIGINS: `${LISTED}, https://other.test` },
    });

    const listed = await fetch(`${server.url}/trpc/projects.list`, {
      headers: { ...bearer, Origin: LISTED },
    });
    expect(listed.status).toBe(200);
    expect(listed.headers.get("access-control-allow-origin")).toBe(LISTED);

    const preflight = await fetch(`${server.url}/trpc/projects.list`, {
      method: "OPTIONS",
      headers: { Origin: LISTED, "Access-Control-Request-Method": "GET" },
    });
    expect(preflight.headers.get("access-control-allow-origin")).toBe(LISTED);

    const unlisted = await fetch(`${server.url}/trpc/projects.list`, {
      headers: { ...bearer, Origin: UNLISTED },
    });
    expect(unlisted.status).toBe(403);
    expect(unlisted.headers.get("access-control-allow-origin")).toBeNull();

    expect(await openSocket(server.url, LISTED)).toBe("open");
    expect(await openSocket(server.url, UNLISTED)).toBe("refused");
  });
});

describe("admin token", () => {
  function logsOf(
    home: string,
    env: Record<string, string>,
  ): Promise<{ out: string; stop: () => Promise<void> }> {
    return getRandomPort().then(
      (port) =>
        new Promise((resolve, reject) => {
          const child = spawn(SERVER_RUNTIME, [SERVER_SCRIPT], {
            cwd: join(import.meta.dirname, ".."),
            env: {
              ...process.env,
              HOME: home,
              PORT: String(port),
              NODE_ENV: "production",
              BAND_UI_DIR: uiDir(),
              ...env,
            },
            stdio: ["ignore", "pipe", "pipe"],
            detached: true,
          });
          let out = "";
          const onData = (c: Buffer) => {
            out += c.toString();
            if (/Web server listening/.test(out)) {
              resolve({
                out,
                stop: async () => {
                  const pgid = child.pid as number;
                  await new Promise<void>((r) => {
                    child.on("exit", () => r());
                    try {
                      process.kill(-pgid, "SIGTERM");
                    } catch {
                      child.kill("SIGTERM");
                    }
                  });
                  await waitForProcessGroupExit(pgid);
                  await stopTerminalDaemon(home);
                },
              });
            }
          };
          child.stdout!.on("data", onData);
          child.stderr!.on("data", onData);
          child.on("error", reject);
          child.on("exit", () => reject(new Error(`exited early\n${out}`)));
        }),
    );
  }

  it("prints a generated token once, it works, and a restart prints nothing", async () => {
    const home = createTmpHome("band-first-run-");
    homes.push(home);

    const first = await logsOf(home, { BAND_PRINT_ADMIN_TOKEN: "true" });
    const stored = JSON.parse(readFileSync(join(home, ".band", "settings.json"), "utf8"))
      .tokenSecret as string;
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(first.out.split(stored).length - 1).toBe(1);
    await first.stop();

    const second = await logsOf(home, { BAND_PRINT_ADMIN_TOKEN: "true" });
    expect(second.out).not.toContain(stored);
    await second.stop();

    // Prove the printed token authenticates.
    const server = await boot({ home });
    expect(
      (await fetch(`${server.url}/api/health`, { headers: { Authorization: `Bearer ${stored}` } }))
        .status,
    ).toBe(200);
    expect((await fetch(`${server.url}/api/health`)).status).toBe(401);
  });

  it("prints nothing without BAND_PRINT_ADMIN_TOKEN", async () => {
    const home = createTmpHome("band-no-print-");
    homes.push(home);
    const run = await logsOf(home, {});
    const stored = JSON.parse(readFileSync(join(home, ".band", "settings.json"), "utf8"))
      .tokenSecret as string;
    expect(run.out).not.toContain(stored);
    await run.stop();
  });

  it("honours BAND_ADMIN_TOKEN, never prints it, and replaces a stored secret", async () => {
    const home = createTmpHome("band-env-token-");
    homes.push(home);
    seedSettings(home, { tokenSecret: "old-secret" });

    const run = await logsOf(home, {
      BAND_ADMIN_TOKEN: "env-admin-token",
      BAND_PRINT_ADMIN_TOKEN: "true",
    });
    expect(run.out).not.toContain("env-admin-token");
    await run.stop();

    const server = await boot({ home, env: { BAND_ADMIN_TOKEN: "env-admin-token" } });
    const ok = await fetch(`${server.url}/trpc/projects.list`, {
      headers: { Authorization: "Bearer env-admin-token" },
    });
    expect(ok.status).toBe(200);
    const old = await fetch(`${server.url}/trpc/projects.list`, {
      headers: { Authorization: "Bearer old-secret" },
    });
    expect(old.status).toBe(401);
  });
});
