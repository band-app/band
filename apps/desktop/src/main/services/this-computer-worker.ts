/**
 * Makes this Mac a worker of the hub the app is connected to.
 *
 * The worker is the one bundled in the app (`Resources/worker`, see
 * `apps/worker/scripts/build-desktop.mjs`), run by the app's own executable
 * with `ELECTRON_RUN_AS_NODE=1` so no Node install is needed. It runs as the
 * launchd agent `app.band.worker`, the same label and plist the npm package's
 * `band-worker install-service` uses, so the two share one slot. The service
 * files are written by the worker's own `install-service` and
 * `uninstall-service`, which this module runs from the bundle: one writer, so
 * the layout cannot drift between the npm path and this one.
 *
 * The bootstrap token goes from the hub into the child's environment and the
 * plist (mode 0600) only. It is never logged and never sent to the renderer.
 */

import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import type { ThisComputerResult, ThisComputerStatus } from "../../shared/types.js";
import { bandHome } from "./log.js";

export const LAUNCHD_LABEL = "app.band.worker";

/** A hub the app is connected to: its origin and an admin token. */
export interface HubAccess {
  url: string;
  token: string;
}

/** What `ProgramArguments` and `EnvironmentVariables` of the installed plist say. */
export interface InstalledPlist {
  program: string[];
  env: Record<string, string>;
}

function unxml(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** Reads the plist the worker's `install-service` writes. It is not a general plist parser. */
export function parseLaunchdPlist(text: string): InstalledPlist {
  const section = (key: string): string => {
    const match = new RegExp(`<key>${key}</key>\\s*<(array|dict)>([\\s\\S]*?)</\\1>`).exec(text);
    return match?.[2] ?? "";
  };
  const program = [...section("ProgramArguments").matchAll(/<string>([\s\S]*?)<\/string>/g)].map(
    (m) => unxml(m[1] ?? ""),
  );
  const env: Record<string, string> = {};
  for (const m of section("EnvironmentVariables").matchAll(
    /<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/g,
  )) {
    env[unxml(m[1] ?? "")] = unxml(m[2] ?? "");
  }
  return { program, env };
}

export function plistPath(home: string): string {
  return join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

export interface WorkerLocation {
  /** The worker's bundle directory, `Resources/worker` when packaged. */
  dir: string;
  /** The entry the service runs. */
  script: string;
}

/** Where the worker lives: `Resources/worker` when packaged, else `apps/worker` in the repo. */
export function resolveWorkerLocation(opts: {
  isPackaged: boolean;
  resourcesPath?: string;
  appPath?: string;
}): WorkerLocation | null {
  if (opts.isPackaged) {
    if (!opts.resourcesPath) return null;
    const dir = join(opts.resourcesPath, "worker");
    const script = join(dir, "band-worker.mjs");
    return existsSync(script) ? { dir, script } : null;
  }
  let current = opts.appPath ?? process.cwd();
  for (let i = 0; i < 8; i++) {
    const dir = join(current, "apps", "worker");
    const script = join(dir, "bin", "band-worker.mjs");
    if (existsSync(script)) return { dir, script };
    const parent = join(current, "..");
    if (parent === current) break;
    current = parent;
  }
  return null;
}

interface Answered {
  /** Hub origins whose "Use this Mac as a worker?" prompt has been answered. */
  answered: Record<string, true>;
  /** The app version that last started the service, to restart it after an update. */
  serviceVersion?: string;
}

export interface ThisComputerDeps {
  home?: string;
  uid?: number;
  platform?: NodeJS.Platform;
  /** The executable that runs the worker (the app binary). */
  node?: string;
  location: WorkerLocation | null;
  appVersion: string;
  fetch?: typeof fetch;
  /** Overrides `scutil --get ComputerName`. */
  computerName?: () => string;
  /** The `launchctl` binary. `BAND_LAUNCHCTL_BIN` in the environment overrides it. */
  launchctl?: string;
  /** Milliseconds to wait for the host to come online, and the poll gap. */
  onlineTimeoutMs?: number;
  pollMs?: number;
}

const NAME_MAX = 100;

export class ThisComputerWorker {
  private readonly home: string;
  private readonly uid: number;
  private readonly platform: NodeJS.Platform;
  private readonly node: string;
  private readonly deps: ThisComputerDeps;
  private busy = false;

  constructor(deps: ThisComputerDeps) {
    this.deps = deps;
    this.home = deps.home ?? homedir();
    this.uid = deps.uid ?? process.getuid?.() ?? 0;
    this.platform = deps.platform ?? process.platform;
    this.node = deps.node ?? process.execPath;
  }

  private get stateFile(): string {
    return join(bandHome(), "desktop-worker.json");
  }

  private loadState(): Answered {
    try {
      const raw = JSON.parse(readFileSync(this.stateFile, "utf8")) as Partial<Answered>;
      return { answered: raw.answered ?? {}, serviceVersion: raw.serviceVersion };
    } catch {
      return { answered: {} };
    }
  }

  private saveState(state: Answered): void {
    mkdirSync(bandHome(), { recursive: true, mode: 0o700 });
    const tmp = `${this.stateFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    renameSync(tmp, this.stateFile);
  }

  /** Records that the prompt was answered for a hub, so it is not shown again. */
  markAnswered(hubUrl: string): void {
    const state = this.loadState();
    state.answered[hubUrl] = true;
    this.saveState(state);
  }

  private launchctl(args: string[]): string {
    const bin = process.env.BAND_LAUNCHCTL_BIN ?? this.deps.launchctl ?? "launchctl";
    return execFileSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  }

  private readInstalled(): InstalledPlist | null {
    try {
      return parseLaunchdPlist(readFileSync(plistPath(this.home), "utf8"));
    } catch {
      return null;
    }
  }

  private isRunning(): boolean {
    try {
      this.launchctl(["print", `gui/${this.uid}/${LAUNCHD_LABEL}`]);
      return true;
    } catch {
      return false;
    }
  }

  private defaultName(): string {
    try {
      if (this.deps.computerName) return this.deps.computerName();
      const name = execFileSync("scutil", ["--get", "ComputerName"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (name) return name;
    } catch {
      // Not macOS, or scutil failed.
    }
    return hostname();
  }

  /** Whether the installed service runs the worker from this app's bundle. */
  private isBundled(installed: InstalledPlist): boolean {
    const dir = this.deps.location?.dir;
    return Boolean(dir && installed.program[1]?.startsWith(`${dir}/`));
  }

  async status(hub: HubAccess | null): Promise<ThisComputerStatus> {
    const supported = this.platform === "darwin" && this.deps.location !== null;
    const installed = this.readInstalled();
    const base: ThisComputerStatus = {
      supported,
      remoteHub: hub !== null,
      installed: installed !== null,
      bundled: installed !== null && this.isBundled(installed),
      running: false,
      forThisHub: false,
      hostId: installed?.env.BAND_WORKER_ID ?? null,
      name: installed?.env.BAND_WORKER_NAME ?? null,
      roots: installed?.env.BAND_WORKER_ROOTS?.split(":").filter(Boolean) ?? [],
      hostStatus: null,
      version: this.deps.appVersion,
      defaultName: this.defaultName(),
      promptPending: false,
    };
    if (installed) {
      base.running = this.isRunning();
      base.forThisHub = hub !== null && installed.env.BAND_HUB_URL === hub.url;
      if (hub && base.forThisHub && base.hostId) {
        base.hostStatus = await this.hostStatus(hub, base.hostId);
      }
    }
    base.promptPending =
      supported && hub !== null && !installed && !this.loadState().answered[hub.url];
    return base;
  }

  private async trpc<T>(
    hub: HubAccess,
    kind: "query" | "mutation",
    path: string,
    input?: unknown,
  ): Promise<T> {
    const doFetch = this.deps.fetch ?? fetch;
    const url = new URL(`/trpc/${path}`, hub.url);
    const init: RequestInit = {
      method: kind === "query" ? "GET" : "POST",
      headers: { Authorization: `Bearer ${hub.token}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15_000),
    };
    if (kind === "mutation") init.body = JSON.stringify(input ?? {});
    const res = await doFetch(url, init);
    const body = (await res.json().catch(() => null)) as {
      result?: { data: T };
      error?: { message?: string };
    } | null;
    if (!res.ok || !body?.result) {
      throw new Error(body?.error?.message ?? `The hub answered ${res.status}`);
    }
    return body.result.data;
  }

  private async hostStatus(hub: HubAccess, hostId: string): Promise<string | null> {
    try {
      const { hosts } = await this.trpc<{ hosts: Array<{ id: string; status: string }> }>(
        hub,
        "query",
        "hosts.list",
      );
      return hosts.find((h) => h.id === hostId)?.status ?? "removed";
    } catch {
      return null;
    }
  }

  /** Runs a command of the bundled worker, with the token (if any) only in the child's environment. */
  private runWorker(args: string[], token?: string, extraEnv: Record<string, string> = {}) {
    const script = this.deps.location?.script;
    if (!script) return Promise.reject(new Error("This build of Band has no bundled worker"));
    const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv, ELECTRON_RUN_AS_NODE: "1" };
    env.HOME = this.home;
    delete env.BAND_WORKER_TOKEN;
    delete env.BAND_BOOTSTRAP_TOKEN;
    if (token) env.BAND_WORKER_TOKEN = token;
    return new Promise<string>((resolve, reject) => {
      execFile(this.node, [script, ...args], { env, timeout: 60_000 }, (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        let text = `${stderr}${stdout}`.trim().split("\n").slice(-3).join(" ") || err.message;
        if (token) text = text.split(token).join("[redacted]");
        reject(new Error(text));
      });
    });
  }

  private async guard<T extends ThisComputerResult>(
    fn: () => Promise<T>,
  ): Promise<T | ThisComputerResult> {
    if (this.busy) return { ok: false, error: "Another change to this computer is in progress." };
    this.busy = true;
    try {
      return await fn();
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      this.busy = false;
    }
  }

  /** Installs the bundled worker for `hub` and waits until the host shows online. */
  add(hub: HubAccess, input: { name?: string; roots?: string[] }): Promise<ThisComputerResult> {
    return this.guard(async () => {
      if (this.platform !== "darwin") return { ok: false, error: "Only macOS is supported." };
      if (!this.deps.location)
        return { ok: false, error: "This build of Band has no bundled worker." };
      if (this.readInstalled()) {
        return { ok: false, error: "A worker service is already installed on this computer." };
      }
      const name = (input.name?.trim() || this.defaultName()).slice(0, NAME_MAX);
      const roots = (input.roots ?? []).filter((r) => typeof r === "string" && r.startsWith("/"));
      const issued = await this.trpc<{ token: string; hostId: string }>(
        hub,
        "mutation",
        "tokens.issueWorkerBootstrap",
        { hostName: name, labels: [] },
      );
      try {
        await this.runWorker(
          [
            "install-service",
            "--hub",
            hub.url,
            "--worker-id",
            issued.hostId,
            "--name",
            name,
            ...roots.flatMap((r) => ["--root", r]),
          ],
          issued.token,
        );
        const online = await this.waitForStatus(hub, issued.hostId, "online");
        if (!online) {
          throw new Error(
            `The worker did not connect to the hub in time. Its log is ~/.band/worker-service/worker.log.`,
          );
        }
      } catch (err) {
        await this.rollback(hub, issued.hostId);
        throw err;
      }
      this.markAnswered(hub.url);
      this.recordServiceVersion();
      return { ok: true };
    });
  }

  private async rollback(hub: HubAccess, hostId: string): Promise<void> {
    await this.runWorker(["uninstall-service"]).catch(() => {});
    await this.trpc(hub, "mutation", "hosts.remove", { hostId }).catch(() => {});
  }

  private async waitForStatus(hub: HubAccess, hostId: string, want: string): Promise<boolean> {
    const deadline = Date.now() + (this.deps.onlineTimeoutMs ?? 60_000);
    while (Date.now() < deadline) {
      if ((await this.hostStatus(hub, hostId)) === want) return true;
      await new Promise((r) => setTimeout(r, this.deps.pollMs ?? 500));
    }
    return false;
  }

  /** Uninstalls the service, then removes the host from the hub once it is offline. */
  remove(hub: HubAccess | null): Promise<ThisComputerResult> {
    return this.guard(async () => {
      const installed = this.readInstalled();
      if (!installed) return { ok: true };
      await this.runWorker(["uninstall-service"]);
      const hostId = installed.env.BAND_WORKER_ID;
      let note: string | undefined;
      if (hub && hostId && installed.env.BAND_HUB_URL === hub.url) {
        if (await this.waitForStatus(hub, hostId, "offline")) {
          try {
            await this.trpc(hub, "mutation", "hosts.remove", { hostId });
          } catch (err) {
            note = `The service is removed. The host stays on the hub: ${err instanceof Error ? err.message : String(err)}`;
          }
        } else {
          note =
            "The service is removed. Remove the host in Settings > Hosts once it shows offline.";
        }
      }
      return note ? { ok: true, note } : { ok: true };
    });
  }

  /** Points a worker service installed from npm at the bundled worker, keeping its id, roots and state. */
  switchToBundled(hub: HubAccess | null): Promise<ThisComputerResult> {
    return this.guard(async () => {
      const installed = this.readInstalled();
      if (!installed) return { ok: false, error: "No worker service is installed." };
      if (this.isBundled(installed)) return { ok: true };
      const env = installed.env;
      const hubUrl = env.BAND_HUB_URL;
      const token = env.BAND_WORKER_TOKEN;
      if (!hubUrl || !token)
        return { ok: false, error: "The installed service has no hub or token." };
      const args = ["install-service", "--hub", hubUrl];
      if (env.BAND_WORKER_ID) args.push("--worker-id", env.BAND_WORKER_ID);
      if (env.BAND_WORKER_NAME) args.push("--name", env.BAND_WORKER_NAME);
      if (env.BAND_WORKER_LABELS) args.push("--labels", env.BAND_WORKER_LABELS);
      if (env.BAND_WORKER_STATE_DIR) args.push("--state-dir", env.BAND_WORKER_STATE_DIR);
      for (const root of env.BAND_WORKER_ROOTS?.split(":").filter(Boolean) ?? []) {
        args.push("--root", root);
      }
      await this.runWorker(args, token);
      this.recordServiceVersion();
      if (hub && env.BAND_WORKER_ID && hubUrl === hub.url) {
        await this.waitForStatus(hub, env.BAND_WORKER_ID, "online");
      }
      return { ok: true };
    });
  }

  private recordServiceVersion(): void {
    const state = this.loadState();
    state.serviceVersion = this.deps.appVersion;
    this.saveState(state);
  }

  /**
   * After an app update the service still runs the old process, from the same
   * path in the bundle. Restart it once per version. Does nothing for a service
   * that runs a worker from somewhere else.
   */
  restartAfterUpdate(): boolean {
    const installed = this.readInstalled();
    if (!installed || !this.isBundled(installed)) return false;
    const state = this.loadState();
    if (state.serviceVersion === this.deps.appVersion) return false;
    try {
      this.launchctl(["kickstart", "-k", `gui/${this.uid}/${LAUNCHD_LABEL}`]);
    } catch {
      return false;
    }
    this.recordServiceVersion();
    return true;
  }
}
