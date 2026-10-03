import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { type ElectronApplication, _electron as electron, type Page } from "@playwright/test";

const DESKTOP_DIR = join(import.meta.dirname, "../../../desktop");

/** The Electron binary installed for apps/desktop. */
function electronBinary(): string {
  return createRequire(join(DESKTOP_DIR, "package.json"))("electron") as string;
}

/**
 * The packaged executable to launch instead of the dev tree, from
 * `BAND_DESKTOP_EXECUTABLE` (for example
 * `apps/desktop/dist-builder/mac-arm64/Band.app/Contents/MacOS/Band`).
 * Unset means the unpackaged app.
 */
function packagedExecutable(): string | undefined {
  const path = process.env.BAND_DESKTOP_EXECUTABLE;
  if (!path) return undefined;
  if (!existsSync(path)) throw new Error(`BAND_DESKTOP_EXECUTABLE does not exist: ${path}`);
  return path;
}

/** Whether this run launches the packaged app (`BAND_DESKTOP_EXECUTABLE` is set). */
export function isPackagedRun(): boolean {
  return Boolean(process.env.BAND_DESKTOP_EXECUTABLE);
}

export interface LaunchedDesktop {
  app: ElectronApplication;
  /** The Band window (not the DevTools window an unpackaged run opens). */
  window: Page;
  /** Console messages that report a Content-Security-Policy violation. */
  cspViolations: string[];
  /** Whether the app runs from a packaged build (`app.isPackaged`). */
  isPackaged: () => Promise<boolean>;
  /**
   * Replace the native open-file dialog in the main process, so the next
   * `pick_folder` IPC resolves with `paths` instead of waiting for a person.
   */
  stubOpenDialog: (paths: string[]) => Promise<void>;
  /** How many windows the app has open. */
  windowCount: () => number;
  close: () => Promise<void>;
}

/**
 * Launch the desktop app against a throwaway HOME. Unpackaged, the app spawns
 * the hub bundle from `apps/hub/dist` (local mode) and loads the UI from
 * `apps/web/dist/client` over `app://`. With `BAND_DESKTOP_EXECUTABLE` set it
 * launches that packaged app instead, which reads both from its `Resources/`.
 * `HOME` must be a temp directory: the app reads and writes `~/.band` and
 * kills whatever listens on the port in `settings.json`, so the caller seeds a
 * random `webServerPort` there.
 */
export async function launchDesktop(opts: {
  home: string;
  env?: Record<string, string>;
  /** The local hub's port from `settings.json`, freed on close. */
  hubPort?: number;
}): Promise<LaunchedDesktop> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  // Never inherit a dev-server URL: the app would load that instead of `app://`.
  delete env.BAND_DEV_WEB_URL;
  delete env.BAND_CDP_PORT;
  const packaged = packagedExecutable();
  // The hub starts the scripted ACP agent as `process.execPath <script>`. In a
  // packaged app that is the Band binary, which ignores the script and starts a
  // second Band that frees the hub's port, killing the hub. So a packaged run
  // has no stub agent: specs that need one skip with `isPackagedRun()`.
  const extraEnv = { ...opts.env };
  if (packaged) delete extraEnv.BAND_TEST_ACP_AGENT;
  const app = await electron.launch({
    executablePath: packaged ?? electronBinary(),
    // A packaged app has its own entry point; the dev tree needs the directory.
    args: packaged ? [] : [DESKTOP_DIR],
    env: { ...env, HOME: opts.home, ...extraEnv },
    timeout: 60_000,
  });

  // Attached before any page loads, so a violation during the first paint is seen.
  const cspViolations: string[] = [];
  app.context().on("console", (msg) => {
    if (/content security policy/i.test(msg.text())) cspViolations.push(msg.text());
  });

  // The dashboard window is the one on `app://`; the DevTools window is not.
  const find = () => app.windows().find((page) => page.url().startsWith("app://"));
  const deadline = Date.now() + 60_000;
  let window = find();
  while (!window && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    window = find();
  }
  if (!window) throw new Error("The desktop app never opened a window on app://");

  return {
    app,
    window,
    cspViolations,
    isPackaged: () => app.evaluate(({ app: electronApp }) => electronApp.isPackaged),
    stubOpenDialog: async (paths) => {
      await app.evaluate(({ dialog }, filePaths) => {
        // `macos-shell.ts` calls `dialog.showOpenDialog` on this same object.
        dialog.showOpenDialog = (async () => ({ canceled: false, filePaths })) as never;
      }, paths);
    },
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
