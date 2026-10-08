/**
 * One Chromium per worktree for `LocalHost.browser` (plan step 7.3).
 *
 * The browser listens for DevTools on `127.0.0.1` only, on a port Chromium
 * picks (`--remote-debugging-port=0`) and writes to `DevToolsActivePort` in
 * its profile directory. A worktree's profile directory is kept between
 * runs, so cookies survive a reopen.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BrowserCdp, BrowserInfo, BrowserOpenSpec } from "@band-app/host-api";

// A Chromium that is alive but never writes its port file is stuck, and a fresh launch usually is not.
// The first attempt gets 20 s: the CI failure of #837 showed a cold start on a loaded runner outlasting the
// 7 s #830 allowed, and a healthy start takes well under a second, so 20 s only costs time on a real hang.
// Retries get 60% of that (12 s each, the browser is warm in the page cache by then), so three attempts
// total 44 s. `BAND_CHROMIUM_START_TIMEOUT_MS` replaces the first attempt's budget (tests shorten it).
const FIRST_ATTEMPT_TIMEOUT_MS = 20_000;
const RETRY_TIMEOUT_FRACTION = 0.6;
const START_ATTEMPTS = 3;
const SINGLETON_FILES = ["SingletonLock", "SingletonCookie", "SingletonSocket"];
const PROCESS_GROUP_GONE_TIMEOUT_MS = 5_000;
const CLOSE_GRACE_MS = 4_000;

interface Running {
  proc: ChildProcess;
  info: BrowserInfo;
  wsUrl: string;
  exited: Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function playwrightCandidates(): string[] {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    join(homedir(), "Library/Caches/ms-playwright"),
    join(homedir(), ".cache/ms-playwright"),
  ].filter((root): root is string => !!root && existsSync(root));
  const found: string[] = [];
  for (const root of roots) {
    const dirs = readdirSync(root)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort()
      .reverse();
    for (const dir of dirs) {
      found.push(
        join(root, dir, "chrome-linux/chrome"),
        join(root, dir, "chrome-linux64/chrome"),
        join(
          root,
          dir,
          "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        ),
        join(
          root,
          dir,
          "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        ),
        join(
          root,
          dir,
          "chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        ),
      );
    }
  }
  return found;
}

/** `BAND_CHROMIUM_BIN`, then the usual install paths, then a Playwright download. Read on every open. */
export function findChromium(): string | undefined {
  const fromEnv = process.env.BAND_CHROMIUM_BIN;
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : undefined;
  const candidates = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ...playwrightCandidates(),
  ];
  return candidates.find((c) => existsSync(c));
}

class StartTimeoutError extends Error {}

async function readDevToolsPort(
  profileDir: string,
  proc: ChildProcess,
  logPath: string,
  timeoutMs: number,
): Promise<{ port: number; path: string }> {
  const file = join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error("Chromium exited before it opened a DevTools port");
    }
    // A Chromium that hits a fatal error at startup (no usable sandbox, for one) can linger for
    // many seconds before it exits. Its log already says why, so stop waiting.
    if (/\bFATAL:/.test(await readFile(logPath, "utf8").catch(() => ""))) {
      throw new Error("Chromium hit a fatal error at startup");
    }
    try {
      const [port, path] = (await readFile(file, "utf8")).split("\n");
      if (port && path) return { port: Number(port), path: path.trim() };
    } catch {
      // not written yet
    }
    await sleep(50);
  }
  throw new StartTimeoutError("Chromium did not open a DevTools port in time");
}

/** The leader exiting does not mean its helper processes have: wait until the whole group is gone. */
async function waitForGroupExit(pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  const deadline = Date.now() + PROCESS_GROUP_GONE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      process.kill(-pid, 0);
    } catch {
      return;
    }
    await sleep(25);
  }
}

const MAX_QUEUED_BYTES = 64 * 1024 * 1024;

/** Wraps a WebSocket in the `BrowserCdp` shape. */
function wrapSocket(ws: WebSocket): BrowserCdp {
  const queue: string[] = [];
  let queuedBytes = 0;
  let wake: (() => void) | undefined;
  let done = false;
  const finish = () => {
    done = true;
    wake?.();
  };
  ws.addEventListener("message", (event) => {
    const text = typeof event.data === "string" ? event.data : String(event.data);
    queuedBytes += text.length;
    // The consumer is slower than the browser. Drop the connection instead of growing without limit.
    if (queuedBytes > MAX_QUEUED_BYTES) {
      queue.length = 0;
      ws.close(1009, "Consumer too slow");
      finish();
      return;
    }
    queue.push(text);
    wake?.();
  });
  ws.addEventListener("close", finish);
  ws.addEventListener("error", finish);
  return {
    send: (message) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(message);
    },
    messages: (async function* () {
      for (;;) {
        const next = queue.shift();
        if (next !== undefined) {
          queuedBytes -= next.length;
          yield next;
          continue;
        }
        if (done) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    })(),
    close: () => {
      try {
        ws.close();
      } catch {
        // already closed
      }
    },
  };
}

export class ChromiumManager {
  private readonly running = new Map<string, Running>();
  private readonly starting = new Map<string, Promise<BrowserInfo>>();

  constructor(private readonly defaultProfileRoot: () => string) {}

  open(spec: BrowserOpenSpec): Promise<BrowserInfo> {
    const live = this.running.get(spec.worktreeId);
    if (live) return Promise.resolve(live.info);
    const pending = this.starting.get(spec.worktreeId);
    if (pending) return pending;
    const started = this.start(spec).finally(() => this.starting.delete(spec.worktreeId));
    this.starting.set(spec.worktreeId, started);
    return started;
  }

  private async start(spec: BrowserOpenSpec): Promise<BrowserInfo> {
    const bin = findChromium();
    if (!bin) {
      throw new Error("No Chromium found on this host. Install one or set BAND_CHROMIUM_BIN.");
    }
    const profileDir =
      spec.profileDir ??
      join(
        this.defaultProfileRoot(),
        spec.worktreeId.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_"),
      );
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    const headless = spec.headless ?? !process.env.DISPLAY;
    const args = [
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      // Small /dev/shm (containers, CI runners) makes Chromium's renderers fail or stall.
      "--disable-dev-shm-usage",
      "--disable-gpu",
      // Startup progress in chromium.log, so a launch that hangs says where.
      "--enable-logging=stderr",
      // No Keychain or keyring: with a HOME that has none, the cookie store blocks on the lookup
      // and every navigation hangs. Cookies are stored with a fixed key, which is the automation default.
      "--use-mock-keychain",
      "--password-store=basic",
      // Needed as root and in containers, where the sandbox cannot start.
      // `BAND_CHROMIUM_NO_SANDBOX=1` is for hosts that forbid the sandbox's user namespaces, such as CI runners.
      ...(process.getuid?.() === 0 || process.env.BAND_CHROMIUM_NO_SANDBOX === "1"
        ? ["--no-sandbox"]
        : []),
      ...(headless ? ["--headless=new"] : []),
      "about:blank",
    ];
    // The browser gets its own HOME inside the profile, so nothing it writes lands in the caller's home.
    const home = join(profileDir, ".home");
    await mkdir(home, { recursive: true, mode: 0o700 });
    // Pages the browser loads are untrusted, so the worker's own BAND_* settings stay out of its environment.
    const env = Object.fromEntries(
      // The session bus is the caller's desktop, not this browser's: Chromium blocks on a bus that does not answer.
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith("BAND_") && key !== "DBUS_SESSION_BUS_ADDRESS",
      ),
    );
    const logPath = join(profileDir, "chromium.log");
    const failures: string[] = [];
    const envTimeout = Number(process.env.BAND_CHROMIUM_START_TIMEOUT_MS);
    const firstTimeout =
      Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : FIRST_ATTEMPT_TIMEOUT_MS;
    for (let attempt = 1; attempt <= START_ATTEMPTS; attempt++) {
      const attemptTimeout =
        attempt === 1 ? firstTimeout : Math.round(firstTimeout * RETRY_TIMEOUT_FRACTION);
      // A port file from the attempt before would point at a dead browser. So would its Singleton* files:
      // the previous process is gone by now (waited for below), and a leftover lock makes the new browser
      // hand off to a process that no longer exists and never open a port. The profile's cookies stay.
      await rm(join(profileDir, "DevToolsActivePort"), { force: true });
      if (attempt > 1) {
        await Promise.all(SINGLETON_FILES.map((f) => rm(join(profileDir, f), { force: true })));
      }
      const logFd = openSync(logPath, "w", 0o600);
      const proc = spawn(bin, args, {
        stdio: ["ignore", "ignore", logFd],
        detached: true,
        env: { ...env, HOME: home },
      });
      closeSync(logFd);
      const exited = new Promise<void>((resolve) => {
        proc.once("exit", () => resolve());
        proc.once("error", () => resolve());
      });
      const startedAt = Date.now();
      try {
        const { port, path } = await readDevToolsPort(profileDir, proc, logPath, attemptTimeout);
        const info: BrowserInfo = { pid: proc.pid, profileDir, headless, port };
        const entry: Running = { proc, info, wsUrl: `ws://127.0.0.1:${port}${path}`, exited };
        this.running.set(spec.worktreeId, entry);
        void exited.then(() => {
          if (this.running.get(spec.worktreeId) === entry) this.running.delete(spec.worktreeId);
        });
        return info;
      } catch (err) {
        this.kill(proc, "SIGKILL");
        await exited;
        await waitForGroupExit(proc.pid);
        const tail = (await readFile(logPath, "utf8").catch(() => ""))
          .trim()
          .split("\n")
          .filter(Boolean)
          .slice(-12);
        const files = readdirSync(profileDir).slice(0, 30).join(",");
        const elapsed = `after ${Date.now() - startedAt} ms, pid ${proc.pid ?? "none"}`;
        const message = `${(err as Error).message} (${elapsed}, bin ${bin}, profile has ${files})${tail.length > 0 ? `: ${tail.join(" | ")}` : ""}`;
        // Only a launch that hung is worth another try. An exit or a fatal error will repeat.
        if (!(err instanceof StartTimeoutError)) throw new Error(message);
        failures.push(`attempt ${attempt}: ${message}`);
      }
    }
    throw new Error(failures.join(" ; "));
  }

  async connect(worktreeId: string): Promise<BrowserCdp> {
    const entry = this.running.get(worktreeId);
    if (!entry) throw new Error(`No browser is open for worktree ${worktreeId}`);
    const ws = new WebSocket(entry.wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("Could not reach the browser")), {
        once: true,
      });
    });
    return wrapSocket(ws);
  }

  async close(worktreeId: string): Promise<void> {
    // A close that arrives while the browser is still starting waits for it, so it is not left running.
    const starting = this.starting.get(worktreeId);
    if (starting) await starting.catch(() => undefined);
    const entry = this.running.get(worktreeId);
    if (!entry) return;
    this.running.delete(worktreeId);
    // Browser.close lets Chromium write its cookie store before it exits.
    try {
      const cdp = await this.connectTo(entry);
      cdp.send(JSON.stringify({ id: 1, method: "Browser.close" }));
      await Promise.race([entry.exited, sleep(CLOSE_GRACE_MS)]);
      cdp.close();
    } catch {
      // fall through to the signals
    }
    if (entry.proc.exitCode === null && entry.proc.signalCode === null) {
      this.kill(entry.proc, "SIGTERM");
      await Promise.race([entry.exited, sleep(CLOSE_GRACE_MS)]);
      this.kill(entry.proc, "SIGKILL");
    }
    await entry.exited;
  }

  private async connectTo(entry: Running): Promise<BrowserCdp> {
    const ws = new WebSocket(entry.wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("unreachable")), { once: true });
    });
    return wrapSocket(ws);
  }

  /** Signals the browser's process group, so its helper processes go too. */
  private kill(proc: ChildProcess, signal: NodeJS.Signals): void {
    if (proc.pid === undefined) return;
    try {
      process.kill(-proc.pid, signal);
    } catch {
      try {
        proc.kill(signal);
      } catch {
        // gone already
      }
    }
  }
}
