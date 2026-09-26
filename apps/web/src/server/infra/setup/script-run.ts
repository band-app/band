import { spawn } from "node:child_process";
import {
  existsSync,
  type FSWatcher,
  mkdtempSync,
  readFileSync,
  rmSync,
  watch,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@band-app/logger";
import { prependBinDirs } from "../process/path";

const log = createLogger("script-run");

/** How often {@link prepareScriptRun} checks for the exit-code file, in case `fs.watch` misses it. */
const POLL_MS = 1_000;

/**
 * A `.band/config.json` `setup` / `teardown` command prepared to run inside
 * a workspace terminal.
 *
 * The terminal types {@link command} into the user's interactive shell, so
 * the PTY's own exit code says nothing about the script (the shell stays
 * open afterwards, keeping the output on screen). Instead the script runs
 * under bash with an EXIT trap that writes its exit code to a private temp
 * file, and {@link exited} resolves when that file appears. The trap fires
 * on a normal end, an explicit `exit N`, and a `set -e` abort alike.
 *
 * The script itself lives in the same temp dir, so {@link command} is just
 * `bash '<path>'`: no user text passes through the interactive shell's
 * quoting (which differs in fish). The dir is removed once the script
 * ends, so if the terminal is later respawned from its saved layout with
 * the same command, bash finds no file rather than running the script a
 * second time.
 */
export interface ScriptRun {
  /** Shell line for `SpawnOptions.command`. */
  command: string;
  /** Resolves with the script's exit code. Never rejects. */
  exited: Promise<number>;
  /** Stop watching and remove the temp dir. Idempotent. */
  dispose(): void;
}

/** POSIX single-quote a string (`'` becomes `'\''`). */
function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Wrap `script` so it runs with bash semantics (as the old hidden runner's
 * `bash -c <script>` did) regardless of the user's login shell, prints what
 * it is running and how it ended, and reports its exit code. POSIX only;
 * see {@link runScriptHidden} for Windows.
 */
export function prepareScriptRun(script: string, label: "setup" | "teardown"): ScriptRun {
  // mkdtemp creates the dir with mode 0700, so no other user can plant or
  // read the script or the exit-code file.
  const dir = mkdtempSync(join(tmpdir(), "band-script-"));
  const scriptFile = join(dir, `${label}.sh`);
  const exitFile = join(dir, "exit-code");
  const partialFile = `${exitFile}.partial`;

  // Written then renamed, so the watcher never reads a half-written file.
  const onExit = [
    "rc=$?",
    `printf '\\n[band] ${label} finished with exit code %s\\n' "$rc"`,
    `printf %s "$rc" > ${quote(partialFile)}`,
    `mv ${quote(partialFile)} ${quote(exitFile)}`,
  ].join("; ");
  const body = [
    `trap ${quote(onExit)} EXIT`,
    `printf '[band] running ${label}: %s\\n\\n' ${quote(script)}`,
    script,
    "",
  ].join("\n");
  writeFileSync(scriptFile, body, { mode: 0o600 });
  const command = `bash ${quote(scriptFile)}`;

  let watcher: FSWatcher | null = null;
  let poll: NodeJS.Timeout | null = null;
  let disposed = false;
  let resolveExited!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExited = resolve;
  });

  const check = () => {
    if (disposed || !existsSync(exitFile)) return;
    const code = Number.parseInt(readFileSync(exitFile, "utf-8").trim(), 10);
    resolveExited(Number.isNaN(code) ? 1 : code);
    dispose();
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    watcher?.close();
    watcher = null;
    if (poll) clearInterval(poll);
    poll = null;
    rmSync(dir, { recursive: true, force: true });
  };

  // `fs.watch` reports the file promptly; the poll covers a watcher that
  // fails to start or errors later, so `exited` still resolves.
  try {
    watcher = watch(dir, check);
    watcher.on("error", (err) => log.warn({ err }, "exit-code watcher failed; polling instead"));
  } catch (err) {
    log.warn({ err }, "could not watch for the script's exit code; polling instead");
  }
  poll = setInterval(check, POLL_MS);
  poll.unref();

  return { command, exited, dispose };
}

/**
 * Run `script` through `cmd.exe /d /s /c` in `cwd`, without a terminal,
 * and resolve with its exit code (or `null` on `timeoutMs`). The Windows
 * path: terminals there cannot run {@link prepareScriptRun}'s bash wrapper.
 */
export function runScriptHidden(
  script: string,
  cwd: string,
  timeoutMs?: number,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const { PORT: _port, ...parentEnv } = process.env;
    const child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", script], {
      cwd,
      env: { ...parentEnv, PATH: prependBinDirs(process.env.PATH) },
      stdio: "ignore",
      windowsHide: true,
    });
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            child.kill();
            resolve(null);
          }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
}
