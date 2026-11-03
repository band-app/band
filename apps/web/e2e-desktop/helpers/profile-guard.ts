import { existsSync, lstatSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

/** The real Band.app profile. Electron resolves it from the account home, never `$HOME`. */
export function realProfileDir(): string {
  return join(homedir(), "Library", "Application Support", "Band");
}

// The running Band.app rewrites these on its own (measured with no test running), so a change
// there says nothing about this run. The guard looks for the damage a stray test did before:
// deleted or emptied cookie and storage files of the browser-pane partitions.
const VOLATILE = [
  /(^|\/)(Cache|Code Cache|GPUCache|DawnCache|DawnGraphiteCache|DawnWebGPUCache|Crashpad|logs|blob_storage|Shared Dictionary|component_crx_cache|ShaderCache|GrShaderCache|GraphiteDawnCache)(\/|$)/,
  /(^|\/)(SingletonLock|SingletonCookie|SingletonSocket|DevToolsActivePort|Network Persistent State|TransportSecurity|Cookies-journal|[^/]*-journal|[^/]*\.log|LOCK|LOG|LOG\.old\.[^/]*)$/,
  /(^|\/)(Local State|Preferences|Session Storage|Local Storage|IndexedDB|Shared Dictionary|SharedStorage|DIPS|Service Worker|Sessions)(\/|$)/,
  /[^/]*-(wal|shm)$/,
  /\.(ldb|log|tmp)$/,
  /(^|\/)MANIFEST-\d+$/,
];

export type ProfileListing = Map<string, string>;

/** Path to `size:mtimeMs` for every file under the real profile. Read-only. */
export function listRealProfile(dir = realProfileDir()): ProfileListing {
  const out: ProfileListing = new Map();
  if (!existsSync(dir)) return out;
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      const rel = relative(dir, full).split(sep).join("/");
      if (VOLATILE.some((re) => re.test(rel))) continue;
      if (entry.isDirectory()) {
        walk(full);
      } else {
        try {
          const stat = lstatSync(full);
          out.set(rel, `${stat.size}:${Math.floor(stat.mtimeMs)}`);
        } catch {
          // removed while listing
        }
      }
    }
  };
  walk(dir);
  return out;
}

/**
 * The paths a run could have damaged: files removed, or shrunk to under half their size.
 * Additions and growth are the live app's own writes and are not reported.
 */
export function diffListings(before: ProfileListing, after: ProfileListing): string[] {
  const damaged: string[] = [];
  for (const [path, sig] of before) {
    const now = after.get(path);
    if (now === undefined) {
      damaged.push(`removed ${path}`);
      continue;
    }
    const was = Number(sig.split(":")[0]);
    const is = Number(now.split(":")[0]);
    if (was > 0 && is < was / 2) damaged.push(`shrunk ${path} (${was} to ${is} bytes)`);
  }
  return damaged.sort();
}

/** Whether `dir` is inside the OS temp dir (resolving the macOS `/var` to `/private/var` link). */
export function isUnderOsTmp(dir: string, tmp = tmpdir()): boolean {
  const norm = (p: string) => p.replace(/^\/private(?=\/)/, "").replace(/\/+$/, "");
  const root = norm(tmp);
  const candidate = norm(dir);
  return candidate === root || candidate.startsWith(`${root}/`);
}

/** Whether `path` is `dir` or inside it. */
export function isInside(path: string, dir: string): boolean {
  const norm = (p: string) => p.replace(/^\/private(?=\/)/, "").replace(/\/+$/, "");
  return norm(path) === norm(dir) || norm(path).startsWith(`${norm(dir)}/`);
}

/**
 * Throws, naming the resolved path, when `userData`, `sessionData` or the partitions dir is not
 * inside the test home. The launch helper calls it before the window talks to any hub.
 */
export function assertProfileIsolated(
  paths: { userData: string; sessionData: string; partitions: string },
  home: string,
): void {
  const offending = Object.entries(paths).filter(([, p]) => !isInside(p, home));
  if (offending.length === 0) return;
  throw new Error(
    `Desktop e2e isolation failed, so the run was aborted: ${offending
      .map(([name, p]) => `${name}=${p}`)
      .join(", ")} is outside the test home ${home} (the real profile is ${realProfileDir()})`,
  );
}
