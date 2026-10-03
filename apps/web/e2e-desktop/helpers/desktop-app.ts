import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { type ElectronApplication, _electron as electron, type Page } from "@playwright/test";

const DESKTOP_DIR = join(import.meta.dirname, "../../../desktop");

/** The Electron binary installed for apps/desktop. */
function electronBinary(): string {
  return createRequire(join(DESKTOP_DIR, "package.json"))("electron") as string;
}

export interface LaunchedDesktop {
  app: ElectronApplication;
  /** The Band window (not the DevTools window an unpackaged run opens). */
  window: Page;
  /** Console messages that report a Content-Security-Policy violation. */
  cspViolations: string[];
  /** How many windows the app has open. */
  windowCount: () => number;
  close: () => Promise<void>;
}

/**
 * Launch the unpackaged desktop app against a throwaway HOME. The app spawns
 * the hub bundle from `apps/hub/dist` (local mode) and loads the UI from
 * `apps/web/dist/client` over `app://`. `HOME` must be a temp directory: the
 * app reads and writes `~/.band` and kills whatever listens on the port in
 * `settings.json`, so the caller seeds a random `webServerPort` there.
 */
export async function launchDesktop(opts: {
  home: string;
  env?: Record<string, string>;
  /** The local hub's port from `settings.json`, freed on close. */
  hubPort?: number;
  /** What the first window shows. `unreachable` is the "hub unreachable" page, a `data:` URL. */
  firstPage?: "app" | "unreachable";
}): Promise<LaunchedDesktop> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  // Never inherit a dev-server URL: the app would load that instead of `app://`.
  delete env.BAND_DEV_WEB_URL;
  delete env.BAND_CDP_PORT;
  const app = await electron.launch({
    executablePath: electronBinary(),
    args: [DESKTOP_DIR],
    env: { ...env, HOME: opts.home, ...opts.env },
    timeout: 60_000,
  });

  // Attached before any page loads, so a violation during the first paint is seen.
  const cspViolations: string[] = [];
  app.context().on("console", (msg) => {
    if (/content security policy/i.test(msg.text())) cspViolations.push(msg.text());
  });

  // The dashboard window is the one on `app://`; the DevTools window is not.
  const prefix = opts.firstPage === "unreachable" ? "data:text/html" : "app://";
  const find = () => app.windows().find((page) => page.url().startsWith(prefix));
  const deadline = Date.now() + 60_000;
  let window = find();
  while (!window && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    window = find();
  }
  if (!window) throw new Error(`The desktop app never opened a window on ${prefix}`);

  return {
    app,
    window,
    cspViolations,
    windowCount: () => app.windows().length,
    close: async () => {
      // Quitting waits out the local hub's 3 s shutdown grace. If it hangs,
      // kill the app: a test must never leave an Electron process behind.
      const quit = app.close().catch(() => {});
      let timer: NodeJS.Timeout | undefined;
      const timedOut = await Promise.race([
        quit.then(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), 20_000);
        }),
      ]);
      clearTimeout(timer);
      if (timedOut) app.process().kill("SIGKILL");
      // The hub is detached and outlives a killed app. Free its (random) port.
      if (opts.hubPort) {
        const pids = spawnSync("lsof", ["-ti", `tcp:${opts.hubPort}`, "-sTCP:LISTEN"], {
          encoding: "utf8",
        }).stdout.split("\n");
        for (const pid of pids.filter(Boolean)) {
          try {
            process.kill(-Number(pid), "SIGKILL");
          } catch {
            // already gone
          }
          try {
            process.kill(Number(pid), "SIGKILL");
          } catch {
            // already gone
          }
        }
      }
    },
  };
}
