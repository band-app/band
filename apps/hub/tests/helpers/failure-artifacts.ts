import {
  closeSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

// When a hub test fails, the temp home it ran in is deleted right after, and with it the logs of
// the hub, the workers and the terminal daemon. With BAND_TEST_ARTIFACTS_DIR set (CI sets it),
// those logs are copied out first. Only files named *.log are taken, so settings.json, tokens
// and the vault never leave the home. Each copy keeps the last 2 MB.

const MAX_BYTES = 2 * 1024 * 1024;
let failed = false;
let counter = 0;
// vitest runs `onTestFailed` after `afterEach`, and many files stop their server and delete the
// home in `afterEach`. Until a failure is known, logs are staged in a scratch dir; a failure moves
// them to the artifacts dir, and the next test or the end of the file drops them.
const staged: string[] = [];

/** Called from the setup file when a test fails: keep what was staged, and keep later logs directly. */
export function markTestFailed(): void {
  failed = true;
  const root = process.env.BAND_TEST_ARTIFACTS_DIR;
  if (!root) return;
  mkdirSync(root, { recursive: true });
  for (const dir of staged.splice(0)) cpSync(dir, join(root, basename(dir)), { recursive: true });
}

/** Called before each test and after each file: staged logs of a test that passed are not needed. */
export function dropStagedLogs(): void {
  for (const dir of staged.splice(0)) rmSync(dir, { recursive: true, force: true });
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
  const root = process.env.BAND_TEST_ARTIFACTS_DIR;
  if (!root) return undefined;
  const name = `${process.env.VITEST_POOL_ID ?? "0"}-${Date.now()}-${counter++}-${label}`;
  if (failed) {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  const dir = mkdtempSync(join(tmpdir(), `${name}-`));
  staged.push(dir);
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
