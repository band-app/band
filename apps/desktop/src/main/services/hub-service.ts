/**
 * Runs the desktop app's own hub as the launchd user agent `app.band.hub`.
 *
 * Before this, the app spawned the hub as its child, so quitting the app stopped the hub for
 * every device. As a launchd agent the hub keeps running when the app quits, the same way the
 * bundled worker runs as `app.band.worker` (`this-computer-worker.ts`). The agent runs the app's
 * own executable with `ELECTRON_RUN_AS_NODE=1` on the bundled hub entry, so no Node install is
 * needed and an app update replaces what it runs.
 *
 * The plist holds no secret. The hub reads its port and admin token from `~/.band/settings.json`
 * itself, which is also where the app reads them.
 *
 * `AbandonProcessGroup` keeps launchd from killing the terminal daemon, which the hub starts as a
 * detached process, when it stops or restarts the hub. Terminals therefore survive a hub restart.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { bandHome, createLogger } from "./log.js";
import { killPort } from "./port.js";
import { tryGetToken } from "./settings.js";
import { shellPath } from "./shell-path.js";
import { checkLocalHealth } from "./web-server.js";

const log = createLogger("hub-service");

export const HUB_LAUNCHD_LABEL = "app.band.hub";

const MAX_LOG_BYTES = 5 * 1024 * 1024;

export function hubPlistPath(home: string): string {
  return join(home, "Library", "LaunchAgents", `${HUB_LAUNCHD_LABEL}.plist`);
}

function xml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface HubPlistOptions {
  /** The executable that runs the hub: the app binary. */
  node: string;
  /** The hub entry, `dist/start-server.mjs` in the bundle or the repo build. */
  script: string;
  /** The hub's working directory. */
  cwd: string;
  /** Where launchd writes the hub's output. */
  logFile: string;
  env: Record<string, string>;
}

/** The plist the hub agent runs from. Kept deterministic so a change can be detected by comparing text. */
export function renderHubPlist(opts: HubPlistOptions): string {
  const env = Object.entries(opts.env)
    .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${HUB_LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(opts.node)}</string>
    <string>${xml(opts.script)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(opts.cwd)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>AbandonProcessGroup</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(opts.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(opts.logFile)}</string>
</dict>
</plist>
`;
}

export interface HubServiceDeps {
  home?: string;
  uid?: number;
  platform?: NodeJS.Platform;
  /** The executable that runs the hub (the app binary). */
  node?: string;
  appVersion: string;
  isPackaged: boolean;
  /** The `launchctl` binary. `BAND_LAUNCHCTL_BIN` in the environment overrides it. */
  launchctl?: string;
  /** Milliseconds to wait for the hub to answer health, and the poll gap. */
  healthTimeoutMs?: number;
  pollMs?: number;
  /** Replaces the health request, for tests with no hub behind them. */
  checkHealth?: (port: number, token: string) => Promise<boolean>;
  /** Frees the port before the first install, for a hub an older app spawned as its child. */
  freePort?: (port: number) => Promise<void>;
}

export interface HubServiceStart {
  port: number;
  token: string;
  /** The service was running an older app version and was restarted. */
  restarted: boolean;
}

export class HubService {
  private readonly home: string;
  private readonly uid: number;
  private readonly platform: NodeJS.Platform;
  private readonly node: string;
  private readonly deps: HubServiceDeps;

  constructor(deps: HubServiceDeps) {
    this.deps = deps;
    this.home = deps.home ?? homedir();
    this.uid = deps.uid ?? process.getuid?.() ?? 0;
    this.platform = deps.platform ?? process.platform;
    this.node = deps.node ?? process.execPath;
  }

  /** Whether this platform can run the hub as a service. */
  get supported(): boolean {
    return this.platform === "darwin";
  }

  private get stateFile(): string {
    return join(bandHome(), "desktop-hub-service.json");
  }

  private loadVersion(): string | undefined {
    try {
      const raw = JSON.parse(readFileSync(this.stateFile, "utf8")) as { serviceVersion?: unknown };
      return typeof raw.serviceVersion === "string" ? raw.serviceVersion : undefined;
    } catch {
      return undefined;
    }
  }

  private recordVersion(): void {
    mkdirSync(bandHome(), { recursive: true, mode: 0o700 });
    const tmp = `${this.stateFile}.tmp`;
    writeFileSync(tmp, JSON.stringify({ serviceVersion: this.deps.appVersion }), { mode: 0o600 });
    renameSync(tmp, this.stateFile);
  }

  private launchctl(args: string[]): string {
    const bin = process.env.BAND_LAUNCHCTL_BIN ?? this.deps.launchctl ?? "launchctl";
    return execFileSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  }

  private get target(): string {
    return `gui/${this.uid}/${HUB_LAUNCHD_LABEL}`;
  }

  isInstalled(): boolean {
    return existsSync(hubPlistPath(this.home));
  }

  isRunning(): boolean {
    try {
      this.launchctl(["print", this.target]);
      return true;
    } catch {
      return false;
    }
  }

  /** The plist text for a hub in `webDir` on `port`. */
  desiredPlist(webDir: string, port: number): string {
    const env: Record<string, string> = {
      // The app binary is Electron. Without this launchd would boot a second desktop app (#1118).
      ELECTRON_RUN_AS_NODE: "1",
      BAND_HOME: bandHome(),
      PORT: String(port),
      // Repopulate PATH from the login shell: launchd gives agents only /usr/bin:/bin:/usr/sbin:/sbin,
      // and the hub's children (claude, band, git) live elsewhere.
      PATH: shellPath(),
      NODE_OPTIONS: "--no-warnings=ExperimentalWarning",
    };
    if (this.deps.isPackaged) env.BAND_PACKAGED = "1";
    return renderHubPlist({
      node: this.node,
      script: join(webDir, "dist/start-server.mjs"),
      cwd: webDir,
      logFile: join(bandHome(), "server.log"),
      env,
    });
  }

  /** Only a packaged app owns its port. In dev, killing it could stop another Band instance. */
  private async freePort(port: number): Promise<void> {
    if (this.deps.freePort) return this.deps.freePort(port);
    if (this.deps.isPackaged) await killPort(port);
  }

  private rotateLog(): void {
    const file = join(bandHome(), "server.log");
    try {
      if (statSync(file).size > MAX_LOG_BYTES) renameSync(file, `${file}.old`);
    } catch {
      // No log yet.
    }
  }

  private async waitHealthy(port: number): Promise<string> {
    const check = this.deps.checkHealth ?? checkLocalHealth;
    const deadline = Date.now() + (this.deps.healthTimeoutMs ?? 30_000);
    while (Date.now() < deadline) {
      await delay(this.deps.pollMs ?? 200);
      const token = tryGetToken();
      if (token && (await check(port, token))) return token;
    }
    throw new Error("The hub service did not become healthy within 30 seconds");
  }

  private bootstrap(plistFile: string): void {
    try {
      this.launchctl(["bootstrap", `gui/${this.uid}`, plistFile]);
    } catch (err) {
      // Already loaded: restart it so it picks up the plist on disk.
      if (!this.isRunning()) throw err;
      this.launchctl(["kickstart", "-k", this.target]);
    }
  }

  /**
   * Makes sure the hub service is installed, current and answering, and returns its port and
   * token. A first start installs it. A change to the plist (a moved app, a new port) reloads it.
   * The first start after an app update restarts it, which is what loads the new bundle.
   */
  async ensureRunning(opts: { webDir: string; port: number }): Promise<HubServiceStart> {
    const plistFile = hubPlistPath(this.home);
    const desired = this.desiredPlist(opts.webDir, opts.port);
    const current = existsSync(plistFile) ? readFileSync(plistFile, "utf8") : null;
    const running = current !== null && this.isRunning();
    let restarted = false;

    // PATH comes from the login shell and can differ between launches (Finder or a terminal), so a
    // change in it alone does not reload a running hub.
    const stripPath = (text: string) => text.replace(/(<key>PATH<\/key>\s*<string>)[^<]*/, "$1");
    const changed = current === null || stripPath(current) !== stripPath(desired);
    const updated = running && this.loadVersion() !== this.deps.appVersion;

    if (changed || (updated && current !== desired)) {
      mkdirSync(dirname(plistFile), { recursive: true });
      writeFileSync(plistFile, desired);
      this.rotateLog();
      if (running) {
        try {
          this.launchctl(["bootout", this.target]);
        } catch {
          // Gone between the check and now.
        }
        restarted = updated;
      } else {
        // A hub an older app spawned as its child still holds the port.
        await this.freePort(opts.port);
      }
      this.bootstrap(plistFile);
      this.recordVersion();
      log.info({ port: opts.port }, "installed the hub service");
    } else if (!running) {
      this.rotateLog();
      await this.freePort(opts.port);
      this.bootstrap(plistFile);
      this.recordVersion();
      log.info({ port: opts.port }, "started the hub service");
    } else if (updated) {
      this.launchctl(["kickstart", "-k", this.target]);
      this.recordVersion();
      restarted = true;
      log.info("restarted the hub service after an update");
    }

    const token = await this.waitHealthy(opts.port);
    return { port: opts.port, token, restarted };
  }

  /** Stops the service and removes its plist, so it does not start again at the next login. */
  stop(): void {
    try {
      this.launchctl(["bootout", this.target]);
    } catch {
      // Not loaded.
    }
    rmSync(hubPlistPath(this.home), { force: true });
    rmSync(this.stateFile, { force: true });
    log.info("stopped the hub service");
  }
}
