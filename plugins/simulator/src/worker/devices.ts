import { rm } from "node:fs/promises";
import { run } from "./tools.ts";

export interface Device {
  udid: string;
  name: string;
  state: string;
}

interface SimctlDevices {
  devices: Record<
    string,
    Array<{ udid: string; name: string; state: string; isAvailable?: boolean }>
  >;
}

interface SimctlRuntimes {
  runtimes: Array<{
    identifier: string;
    version: string;
    platform?: string;
    isAvailable: boolean;
    supportedDeviceTypes?: Array<{ identifier: string; name: string; productFamily?: string }>;
  }>;
}

/** The prefix of every device name Band creates. Tests set their own, so they never match a person's devices. */
export function namePrefix(): string {
  return process.env.BAND_SIMULATOR_NAME_PREFIX?.trim() || "Band";
}

function baseName(): string {
  return `${namePrefix()} \u2013 base`;
}

/** The most devices that may be booted at once. Read on every call. */
export function maxBooted(): number {
  const n = Number(process.env.BAND_SIMULATOR_MAX_BOOTED);
  return Number.isInteger(n) && n >= 1 ? n : 2;
}

/** The device name of a worktree: "Band \u2013 <worktree id>", the way Simulator.app lists it. */
export function deviceName(worktreeKey: string): string {
  return `${namePrefix()} \u2013 ${worktreeKey}`;
}

function versionParts(v: string): number[] {
  return v.split(".").map((p) => Number.parseInt(p, 10) || 0);
}

function compareVersions(a: string, b: string): number {
  const x = versionParts(a);
  const y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * The worktrees' devices, in the machine's default device set because serve-sim sees only that
 * set. Band owns the devices whose name starts with "Band \u2013 " (`namePrefix()`) and never
 * lists, shuts down or deletes any other. One device per worktree is cloned from a base device,
 * and at most `maxBooted()` are booted at once; the least recently used one is shut down, never
 * deleted.
 */
export class DeviceSet {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly lastUsed = new Map<string, number>();
  /** Called after a device shuts down, so its serve-sim helper goes too. */
  onShutdown: (udid: string) => void = () => {};

  /** @param legacyDir the device set the first version kept its devices in, deleted on first use */
  constructor(private readonly legacyDir?: string) {}

  private legacyDone = false;

  /**
   * The first version kept its devices in a private device set, which serve-sim cannot see. They
   * are deleted, so the next use of a worktree clones a new one into the default set.
   */
  private async dropLegacy(): Promise<void> {
    if (this.legacyDone || !this.legacyDir) return;
    this.legacyDone = true;
    const set = this.legacyDir;
    try {
      const { stdout } = await run("xcrun", ["simctl", "--set", set, "list", "devices", "-j"]);
      const parsed = JSON.parse(stdout) as SimctlDevices;
      for (const d of Object.values(parsed.devices).flat()) {
        await run("xcrun", ["simctl", "--set", set, "shutdown", d.udid]).catch(() => undefined);
        await run("xcrun", ["simctl", "--set", set, "delete", d.udid]).catch(() => undefined);
      }
    } catch {
      // No such set: nothing to drop.
    }
    await rm(set, { recursive: true, force: true });
  }

  /** Runs `fn` after every earlier lifecycle operation, so creates, boots and shutdowns never overlap. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private simctl(args: string[], timeoutMs?: number) {
    return run("xcrun", ["simctl", ...args], { timeoutMs });
  }

  async list(): Promise<Device[]> {
    const { stdout } = await this.simctl(["list", "devices", "-j"]);
    const parsed = JSON.parse(stdout) as SimctlDevices;
    const owned = `${namePrefix()} \u2013 `;
    return Object.values(parsed.devices)
      .flat()
      .filter((d) => d.isAvailable !== false && d.name.startsWith(owned))
      .map(({ udid, name, state }) => ({ udid, name, state }));
  }

  /** The newest available iOS runtime and the newest iPhone Pro it supports, unless the env names them. */
  private async pickBase(): Promise<{ type: string; runtime: string }> {
    const envType = process.env.BAND_SIMULATOR_DEVICE_TYPE;
    const envRuntime = process.env.BAND_SIMULATOR_RUNTIME;
    const { stdout } = await run("xcrun", ["simctl", "list", "runtimes", "-j"]);
    const runtimes = (JSON.parse(stdout) as SimctlRuntimes).runtimes
      .filter((r) => r.isAvailable && (r.platform ?? "iOS") === "iOS")
      .sort((a, b) => compareVersions(b.version, a.version));
    const runtime = envRuntime
      ? runtimes.find((r) => r.identifier === envRuntime || r.version === envRuntime)
      : runtimes[0];
    if (!runtime) throw new Error("No iOS simulator runtime is installed on this worker");
    if (envType) return { type: envType, runtime: runtime.identifier };
    const iphones = (runtime.supportedDeviceTypes ?? []).filter((t) => /^iPhone /.test(t.name));
    const pros = iphones
      .map((t) => ({ t, m: /^iPhone (\d+) Pro$/.exec(t.name) }))
      .filter((x): x is { t: (typeof iphones)[number]; m: RegExpExecArray } => x.m !== null)
      .sort((a, b) => Number(b.m[1]) - Number(a.m[1]));
    const chosen = pros[0]?.t ?? iphones[0];
    if (!chosen) throw new Error(`Runtime ${runtime.identifier} supports no iPhone`);
    return { type: chosen.identifier, runtime: runtime.identifier };
  }

  private async baseDevice(): Promise<Device> {
    const existing = (await this.list()).find((d) => d.name === baseName());
    if (existing) return existing;
    const { type, runtime } = await this.pickBase();
    const { stdout } = await this.simctl(["create", baseName(), type, runtime]);
    return { udid: stdout.trim(), name: baseName(), state: "Shutdown" };
  }

  /** The worktree's device, cloned from the base device on first use. */
  async ensureDevice(worktreeKey: string): Promise<Device> {
    await this.dropLegacy();
    const name = deviceName(worktreeKey);
    const found = (await this.list()).find((d) => d.name === name);
    if (found) return found;
    const base = await this.baseDevice();
    if (base.state !== "Shutdown") await this.simctl(["shutdown", base.udid]);
    const { stdout } = await this.simctl(["clone", base.udid, name], 5 * 60_000);
    return { udid: stdout.trim(), name, state: "Shutdown" };
  }

  /**
   * Boots the worktree's device, first shutting down the least recently used booted devices until
   * there is room under the cap.
   */
  async ensureBooted(worktreeKey: string): Promise<Device> {
    const device = await this.ensureDevice(worktreeKey);
    this.lastUsed.set(device.udid, Date.now());
    if (device.state === "Booted") return device;
    const booted = (await this.list()).filter(
      (d) => d.state === "Booted" && d.udid !== device.udid && d.name !== baseName(),
    );
    booted.sort((a, b) => (this.lastUsed.get(a.udid) ?? 0) - (this.lastUsed.get(b.udid) ?? 0));
    const room = maxBooted() - 1;
    for (const victim of booted.slice(0, Math.max(0, booted.length - room))) {
      await this.shutdown(victim.udid);
    }
    if (device.state !== "Shutting Down") await this.simctl(["boot", device.udid]);
    await this.simctl(["bootstatus", device.udid, "-b"], 5 * 60_000);
    return { ...device, state: "Booted" };
  }

  async shutdown(udid: string): Promise<void> {
    this.onShutdown(udid);
    await this.simctl(["shutdown", udid]).catch((err: Error) => {
      // Shutting down a device that is already off is not a failure.
      if (
        !/current state: Shutdown|Unable to shutdown device in current state/i.test(err.message)
      ) {
        throw err;
      }
    });
  }

  /** Shuts down the worktree's device if it is booted. */
  async shutdownWorktree(worktreeKey: string): Promise<void> {
    const name = deviceName(worktreeKey);
    const device = (await this.list()).find((d) => d.name === name);
    if (device && device.state !== "Shutdown") await this.shutdown(device.udid);
  }

  /** Shuts down and deletes the worktree's device. */
  async deleteWorktree(worktreeKey: string): Promise<void> {
    const name = deviceName(worktreeKey);
    const device = (await this.list()).find((d) => d.name === name);
    if (!device) return;
    await this.shutdown(device.udid);
    await this.simctl(["delete", device.udid]);
    this.lastUsed.delete(device.udid);
  }

  /** Shuts down every booted device in the set. */
  async shutdownAll(): Promise<void> {
    for (const d of await this.list().catch(() => [])) {
      if (d.state === "Booted") await this.shutdown(d.udid).catch(() => undefined);
    }
  }
}
