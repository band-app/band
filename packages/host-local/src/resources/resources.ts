import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { cpus, freemem, hostname, loadavg, totalmem } from "node:os";
import { join } from "node:path";
import type {
  HostResources,
  ResourceDisk,
  ResourceProcess,
  ResourceSnapshot,
  ResourceStorage,
} from "@band-app/host-api";
import { duBytes } from "../process/du";
import { classify, sumRoots } from "./classify";
import { type ProcRow, readProcessCwds, readProcessEnv, readProcessTable } from "./process-table";

const SAMPLE_WINDOW_MS = 500;
const CACHE_MS = 3_000;
const DU_CONCURRENCY = 3;
const ENV_NAMES = ["BAND_WORKTREE_ID", "BAND_CHAT_ID", "BAND_TERMINAL_ID"] as const;

export interface LocalResourcesOptions {
  selfKind: "hub" | "worker";
  /** The folder the host keeps its state in (`<BAND_HOME>` for the hub). The terminal daemon's run dir is `<stateDir>/run`. */
  stateDir: () => string;
}

function execOut(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 5_000 }, (_e, out) => resolve(out ?? ""));
  });
}

async function memoryUsedBytes(total: number): Promise<number> {
  if (process.platform === "linux") {
    const meminfo = await readFile("/proc/meminfo", "utf8").catch(() => "");
    const m = /MemAvailable:\s+(\d+) kB/.exec(meminfo);
    if (m) return Math.max(0, total - Number(m[1]) * 1024);
  }
  if (process.platform === "darwin") {
    const out = await execOut("vm_stat", []);
    const page = Number(/page size of (\d+) bytes/.exec(out)?.[1] ?? 16384);
    const pages = (label: string) => Number(new RegExp(`${label}:\\s+(\\d+)`).exec(out)?.[1] ?? 0);
    const reclaimable = pages("Pages free") + pages("Pages inactive") + pages("Pages speculative");
    if (reclaimable > 0) return Math.max(0, total - reclaimable * page);
  }
  return Math.max(0, total - freemem());
}

function cpuTimes(): { busy: number; total: number } {
  let busy = 0;
  let total = 0;
  for (const c of cpus()) {
    const t = c.times;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
    busy += t.user + t.nice + t.sys + t.irq;
  }
  return { busy, total };
}

/** Total and free bytes of the disk that holds `path`, from `df -k`. */
export async function diskOf(path: string): Promise<ResourceDisk | null> {
  const out = await execOut("df", ["-k", path]);
  const line = out.trim().split("\n").pop();
  const f = line?.trim().split(/\s+/);
  if (!f || f.length < 4) return null;
  const total = Number(f[1]);
  const free = Number(f[3]);
  if (!Number.isFinite(total) || !Number.isFinite(free)) return null;
  return { path, totalBytes: total * 1024, freeBytes: free * 1024 };
}

async function limited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
}

export class LocalResources implements HostResources {
  private cached: { at: number; value: Promise<ResourceSnapshot> } | null = null;

  constructor(private readonly options: LocalResourcesOptions) {}

  snapshot(): Promise<ResourceSnapshot> {
    const now = Date.now();
    if (this.cached && now - this.cached.at < CACHE_MS) return this.cached.value;
    const value = this.sample();
    this.cached = { at: now, value };
    value.catch(() => {
      if (this.cached?.value === value) this.cached = null;
    });
    return value;
  }

  private async sample(): Promise<ResourceSnapshot> {
    const stateDir = this.options.stateDir();
    const cpu1 = cpuTimes();
    const started = Date.now();
    const firstRows = await readProcessTable();
    await new Promise((r) => setTimeout(r, SAMPLE_WINDOW_MS));
    const secondRows = await readProcessTable();
    const windowMs = Date.now() - started;
    const cpu2 = cpuTimes();

    const first = new Map<number, ProcRow>(firstRows.map((r) => [r.pid, r]));
    const second = new Map<number, ProcRow>(secondRows.map((r) => [r.pid, r]));
    const classified = classify(secondRows, {
      selfPid: process.pid,
      selfKind: this.options.selfKind,
      runDir: join(stateDir, "run"),
    });
    const processes = sumRoots(classified, first, second, windowMs);
    await this.attachIds(processes);

    const total = totalmem();
    const totalDelta = cpu2.total - cpu1.total;
    return {
      hostname: hostname(),
      os: process.platform,
      cores: cpus().length,
      memTotalBytes: total,
      memUsedBytes: await memoryUsedBytes(total),
      machineCpuPercent:
        totalDelta > 0 ? Math.round(((cpu2.busy - cpu1.busy) / totalDelta) * 1000) / 10 : null,
      loadAverage: loadavg()[0],
      windowMs,
      takenAt: Date.now(),
      processes,
    };
  }

  /** Reads the ids a terminal or agent was started with, and its folder. */
  private async attachIds(processes: ResourceProcess[]): Promise<void> {
    const wanted = processes.filter(
      (p) =>
        p.kind === "terminal" || p.kind === "agent" || p.kind === "lsp" || p.kind === "browser",
    );
    const cwds = await readProcessCwds(wanted.map((p) => p.pid));
    await limited(wanted, 6, async (p) => {
      const cwd = cwds.get(p.pid);
      if (cwd) p.cwd = cwd;
      if (p.kind !== "terminal" && p.kind !== "agent") return;
      const env = await readProcessEnv(p.pid, ENV_NAMES);
      if (env.BAND_WORKTREE_ID) p.worktreeId = env.BAND_WORKTREE_ID;
      if (env.BAND_CHAT_ID) p.chatId = env.BAND_CHAT_ID;
      if (env.BAND_TERMINAL_ID) p.terminalId = env.BAND_TERMINAL_ID;
    });
  }

  /** Calls with the same worktrees share one run, so a repeated refresh does not stack `du` passes. */
  private storageRuns = new Map<string, Promise<ResourceStorage>>();

  storage(request: { worktrees: { id: string; path: string }[] }): Promise<ResourceStorage> {
    const key = JSON.stringify(request.worktrees);
    const running = this.storageRuns.get(key);
    if (running) return running;
    const run = this.measureStorage(request);
    this.storageRuns.set(key, run);
    const done = () => this.storageRuns.delete(key);
    run.then(done, done);
    return run;
  }

  private async measureStorage(request: {
    worktrees: { id: string; path: string }[];
  }): Promise<ResourceStorage> {
    const stateDir = this.options.stateDir();
    const worktrees = await limited(request.worktrees, DU_CONCURRENCY, async (wt) => {
      try {
        return { id: wt.id, sizeBytes: await duBytes(wt.path) };
      } catch (err) {
        return {
          id: wt.id,
          sizeBytes: 0,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    });
    const names = await readdir(stateDir).catch(() => [] as string[]);
    const state = await limited(names, DU_CONCURRENCY, async (name) => ({
      name,
      sizeBytes: await duBytes(join(stateDir, name)).catch(() => 0),
    }));
    state.sort((a, b) => b.sizeBytes - a.sizeBytes);
    return { worktrees, state, disk: await diskOf(stateDir) };
  }
}
