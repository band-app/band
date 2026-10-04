// Preloaded into the hub process (`node --import`) in remote-loopback mode.
//
// On loopback the worker shares the machine's disk with the hub, so a hub
// service that reads a remote workspace's checkout directly (existsSync,
// readFile, a git subprocess with that cwd) works in the test and fails in
// production, where the worker's disk is another machine. The guard makes the
// hub's view match production: any fs call or child process cwd under a path
// the worker owns throws, and is also recorded in the violations file so a
// service that swallows the error still fails the test at `close()`.
//
// `BAND_TEST_WORKER_PATHS_FILE` is a JSON array of worker-owned directories,
// rewritten by the harness as workspaces move onto the worker.
// `BAND_TEST_WORKER_VIOLATIONS_FILE` collects one JSON line per violation.

import { createRequire } from "node:module";
import { syncBuiltinESMExports } from "node:module";
import { resolve, sep } from "node:path";

const pathsFile = process.env.BAND_TEST_WORKER_PATHS_FILE;
const violationsFile = process.env.BAND_TEST_WORKER_VIOLATIONS_FILE;

if (pathsFile && violationsFile) {
  const require = createRequire(import.meta.url);
  const fs = require("node:fs");
  const childProcess = require("node:child_process");
  const readFileSync = fs.readFileSync;
  const appendFileSync = fs.appendFileSync;

  let cached = [];
  let loadedAt = 0;
  const workerDirs = () => {
    const now = Date.now();
    if (now - loadedAt > 50) {
      loadedAt = now;
      try {
        cached = JSON.parse(readFileSync(pathsFile, "utf8"));
      } catch {
        cached = [];
      }
    }
    return cached;
  };

  const toPath = (value) => {
    if (typeof value === "string") return value;
    if (value instanceof URL) return value.protocol === "file:" ? value.pathname : null;
    if (value && typeof value === "object" && typeof value.toString === "function") {
      return Buffer.isBuffer(value) ? value.toString() : null;
    }
    return null;
  };

  const check = (api, value) => {
    const raw = toPath(value);
    if (!raw || !raw.startsWith("/")) return;
    const target = resolve(raw);
    for (const dir of workerDirs()) {
      if (target === dir || target.startsWith(dir + sep)) {
        const stack = new Error().stack?.split("\n").slice(3, 9).join("\n");
        appendFileSync(violationsFile, `${JSON.stringify({ api, path: target, stack })}\n`);
        throw new Error(`hub touched a worker path through ${api}: ${target}`);
      }
    }
  };

  const wrap = (target, name, indexes) => {
    const original = target[name];
    if (typeof original !== "function") return;
    const wrapped = function (...args) {
      for (const index of indexes) check(`fs.${name}`, args[index]);
      return original.apply(this, args);
    };
    Object.assign(wrapped, original);
    target[name] = wrapped;
  };

  const oneAndTwo = new Set(["copyFile", "cp", "link", "rename", "symlink"]);
  const names = [
    "access",
    "appendFile",
    "chmod",
    "copyFile",
    "cp",
    "createReadStream",
    "createWriteStream",
    "exists",
    "lstat",
    "mkdir",
    "open",
    "opendir",
    "readdir",
    "readFile",
    "readlink",
    "realpath",
    "rename",
    "rm",
    "rmdir",
    "stat",
    "symlink",
    "truncate",
    "unlink",
    "utimes",
    "watch",
    "writeFile",
  ];
  for (const name of names) {
    const indexes = oneAndTwo.has(name) || name === "rename" ? [0, 1] : [0];
    wrap(fs, name, indexes);
    wrap(fs, `${name}Sync`, indexes);
    wrap(fs.promises, name, indexes);
  }

  const wrapSpawn = (name, optionsIndex) => {
    const original = childProcess[name];
    childProcess[name] = function (...args) {
      for (const arg of args.slice(1)) {
        if (arg && typeof arg === "object" && !Array.isArray(arg) && arg.cwd) {
          check(`child_process.${name} cwd`, arg.cwd);
        }
      }
      return original.apply(this, args);
    };
    Object.assign(childProcess[name], original);
  };
  for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]) {
    wrapSpawn(name);
  }

  syncBuiltinESMExports();
}
