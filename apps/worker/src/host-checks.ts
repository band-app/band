import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Below this much memory (16 GiB), a host with no swap has the OOM killer end builds two agents run at once. */
const SWAP_MEMORY_THRESHOLD_BYTES = 16 * 1024 ** 3;
/** Each Claude Code session watches its worktree, and Ubuntu's default (about 60,000) runs out. */
const MIN_INOTIFY_WATCHES = 262_144;

export interface LinuxHostSettings {
  memTotalBytes: number | null;
  swapTotalBytes: number | null;
  maxUserWatches: number | null;
}

export interface HostWarning {
  message: string;
  /** Commands that fix it. Band never runs them. */
  fix: string[];
}

function readNumber(path: string): number | null {
  try {
    const value = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/** The `<key>: <n> kB` lines of /proc/meminfo, in bytes. */
function meminfoBytes(meminfo: string, key: string): number | null {
  const match = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, "m").exec(meminfo);
  return match ? Number(match[1]) * 1024 : null;
}

/** Reads memory, swap and the inotify watch limit from `procDir` (/proc). A value it cannot read is null. */
export function readLinuxHostSettings(procDir = "/proc"): LinuxHostSettings {
  let meminfo = "";
  try {
    meminfo = readFileSync(join(procDir, "meminfo"), "utf8");
  } catch {
    // No /proc: every value stays unknown.
  }
  return {
    memTotalBytes: meminfoBytes(meminfo, "MemTotal"),
    swapTotalBytes: meminfoBytes(meminfo, "SwapTotal"),
    maxUserWatches: readNumber(join(procDir, "sys", "fs", "inotify", "max_user_watches")),
  };
}

const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;

/** What `band-worker doctor` warns about on a Linux host. An unknown value gives no warning. */
export function hostWarnings(settings: LinuxHostSettings): HostWarning[] {
  const warnings: HostWarning[] = [];
  const { memTotalBytes, swapTotalBytes, maxUserWatches } = settings;
  if (
    swapTotalBytes === 0 &&
    memTotalBytes !== null &&
    memTotalBytes < SWAP_MEMORY_THRESHOLD_BYTES
  ) {
    warnings.push({
      message: `no swap and ${gib(memTotalBytes)} of memory: builds that agents run at once can be killed for running out of memory`,
      fix: [
        "sudo fallocate -l 8G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile",
        "grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab",
      ],
    });
  }
  if (maxUserWatches !== null && maxUserWatches < MIN_INOTIFY_WATCHES) {
    warnings.push({
      message: `fs.inotify.max_user_watches is ${maxUserWatches}: agents that watch files fail with ENOSPC`,
      fix: [
        "echo 'fs.inotify.max_user_watches=524288' | sudo tee /etc/sysctl.d/60-band-inotify.conf",
        "sudo sysctl --system",
      ],
    });
  }
  return warnings;
}

/** The warnings as lines for `band-worker doctor`, in the same layout as the capability report. */
export function formatHostWarnings(warnings: HostWarning[]): string {
  const lines: string[] = [];
  for (const w of warnings) {
    lines.push(`WARN ${"worker".padEnd(12)} ${w.message}`);
    for (const command of w.fix) lines.push(`       fix: ${command}`);
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}
