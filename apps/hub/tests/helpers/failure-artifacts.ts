import {
  closeSync,
  copyFileSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

// When a hub test fails, the temp home it ran in is deleted right after, and with it the logs of
// the hub, the workers and the terminal daemon. With BAND_TEST_ARTIFACTS_DIR set (CI sets it),
// those logs are copied out first. Only files named *.log are taken, so settings.json, tokens
// and the vault never leave the home. Each copy keeps the last 2 MB.

const MAX_BYTES = 2 * 1024 * 1024;
let failed = false;
let counter = 0;

/** Called from the setup file when any test in this file fails. */
export function markTestFailed(): void {
  failed = true;
}

function artifactsDir(): string | undefined {
  return failed ? process.env.BAND_TEST_ARTIFACTS_DIR || undefined : undefined;
}

function copyTail(src: string, dest: string): void {
  const size = statSync(src).size;
  if (size <= MAX_BYTES) {
    copyFileSync(src, dest);
    return;
  }
  const fd = openSync(src, "r");
  try {
    const buf = Buffer.alloc(MAX_BYTES);
    readSync(fd, buf, 0, MAX_BYTES, size - MAX_BYTES);
    writeFileSync(dest, buf);
  } finally {
    closeSync(fd);
  }
}

function slot(label: string): string | undefined {
  const root = artifactsDir();
  if (!root) return undefined;
  const dir = join(root, `${basename(process.env.VITEST_POOL_ID ?? "0")}-${Date.now()}-${counter++}-${label}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** What the hub process printed, written by the server's close(). */
export function keepServerOutput(output: string): void {
  const dir = slot("server-output");
  if (dir) writeFileSync(join(dir, "server.log"), output.slice(-MAX_BYTES));
}

/** Copy every *.log under `home` (hub, worker, terminal daemon and ACP stub logs). */
export function keepHomeLogs(home: string): void {
  const dir = slot("home-logs");
  if (!dir) return;
  let n = 0;
  const walk = (d: string, depth: number) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory() && !e.isSymbolicLink() && depth < 8 && e.name !== "node_modules") {
        walk(p, depth + 1);
      } else if (e.isFile() && e.name.endsWith(".log")) {
        try {
          copyTail(p, join(dir, `${n++}-${e.name}`));
        } catch {
          // Gone while copying; keep what was copied.
        }
      }
    }
  };
  walk(home, 0);
}
