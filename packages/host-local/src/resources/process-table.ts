import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";

/** One row of the machine's process table. */
export interface ProcRow {
  pid: number;
  ppid: number;
  /** Resident memory in bytes. */
  rssBytes: number;
  /** Cumulative CPU time (user + system) in milliseconds. */
  cpuMs: number;
  command: string;
}

const PS_TIMEOUT_MS = 5_000;
const PS_MAX_BUFFER = 64 * 1024 * 1024;

function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: PS_TIMEOUT_MS, maxBuffer: PS_MAX_BUFFER }, (_err, out) =>
      resolve(out ?? ""),
    );
  });
}

/** `[[dd-]hh:]mm:ss[.ss]` as ps prints cumulative CPU time. */
export function parsePsTime(text: string): number {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text.trim());
  if (!m) return 0;
  const days = Number(m[1] ?? 0);
  const hours = Number(m[2] ?? 0);
  const minutes = Number(m[3]);
  const seconds = Number(m[4]);
  return Math.round((((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000);
}

/** Parses `ps -axo pid=,ppid=,rss=,time=,command=` output (macOS and Linux fallback). */
export function parsePs(output: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of output.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      rssBytes: Number(m[3]) * 1024,
      cpuMs: parsePsTime(m[4]),
      command: m[5].trim(),
    });
  }
  return rows;
}

const CLK_TCK = 100;
const PAGE_SIZE = 4096;

/** Parses `/proc/<pid>/stat`: the command is in parentheses and may hold spaces. */
export function parseProcStat(
  stat: string,
): { ppid: number; cpuMs: number; rssPages: number } | null {
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const fields = stat
    .slice(close + 2)
    .trim()
    .split(/\s+/);
  // fields[0] is state (field 3); ppid is field 4, utime 14, stime 15, rss 24.
  const ppid = Number(fields[1]);
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  const rss = Number(fields[21]);
  if (![ppid, utime, stime, rss].every(Number.isFinite)) return null;
  return { ppid, cpuMs: ((utime + stime) * 1000) / CLK_TCK, rssPages: rss };
}

async function readLinux(): Promise<ProcRow[]> {
  let names: string[];
  try {
    names = await readdir("/proc");
  } catch {
    return [];
  }
  const rows = await Promise.all(
    names
      .filter((n) => /^\d+$/.test(n))
      .map(async (n): Promise<ProcRow | null> => {
        try {
          const [stat, cmd] = await Promise.all([
            readFile(`/proc/${n}/stat`, "utf8"),
            readFile(`/proc/${n}/cmdline`, "utf8").catch(() => ""),
          ]);
          const parsed = parseProcStat(stat);
          if (!parsed) return null;
          const comm = /\((.*)\)/s.exec(stat)?.[1] ?? "";
          return {
            pid: Number(n),
            ppid: parsed.ppid,
            rssBytes: parsed.rssPages * PAGE_SIZE,
            cpuMs: parsed.cpuMs,
            command: cmd.replace(/\0/g, " ").trim() || comm,
          };
        } catch {
          return null; // the process exited while we read it
        }
      }),
  );
  return rows.filter((r): r is ProcRow => r !== null);
}

/** Reads every process on the machine. */
export async function readProcessTable(): Promise<ProcRow[]> {
  if (process.platform === "linux") {
    const rows = await readLinux();
    if (rows.length > 0) return rows;
  }
  if (process.platform === "win32") return [];
  return parsePs(await run("ps", ["-axww", "-o", "pid=,ppid=,rss=,time=,command="]));
}

/** The values of `names` in a process's environment, for processes of the same user. */
export async function readProcessEnv(
  pid: number,
  names: readonly string[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let text = "";
  if (process.platform === "linux") {
    text = (await readFile(`/proc/${pid}/environ`, "utf8").catch(() => "")).replace(/\0/g, " ");
  } else if (process.platform === "darwin") {
    // BSD ps appends the environment to the command line with -E.
    text = await run("ps", ["-E", "-ww", "-o", "command=", "-p", String(pid)]);
  }
  for (const name of names) {
    const m = new RegExp(`(?:^|\\s)${name}=(\\S+)`).exec(text);
    if (m) out[name] = m[1];
  }
  return out;
}

/** Working directories of the given processes. */
export async function readProcessCwds(pids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (pids.length === 0) return out;
  if (process.platform === "linux") {
    const { readlink } = await import("node:fs/promises");
    await Promise.all(
      pids.map(async (pid) => {
        try {
          out.set(pid, await readlink(`/proc/${pid}/cwd`));
        } catch {
          // gone or not ours
        }
      }),
    );
    return out;
  }
  if (process.platform === "darwin") {
    const text = await run("lsof", ["-a", "-d", "cwd", "-Fpn", "-p", pids.join(",")]);
    let current = 0;
    for (const line of text.split("\n")) {
      if (line.startsWith("p")) current = Number(line.slice(1));
      else if (line.startsWith("n") && current) out.set(current, line.slice(1));
    }
  }
  return out;
}
