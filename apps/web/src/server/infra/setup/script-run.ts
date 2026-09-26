import { existsSync, type FSWatcher, mkdtempSync, readFileSync, rmSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@band-app/logger";

const log = createLogger("script-run");

/**
 * A `.band/config.json` `setup` / `teardown` command prepared to run inside
 * a workspace terminal.
 *
 * The terminal types {@link command} into the user's interactive shell, so
 * the PTY's own exit code says nothing about the script (the shell stays
 * open afterwards, keeping the output on screen). Instead the command runs
 * the script under `bash -c` with an EXIT trap that writes the script's exit
 * code to a private temp file, and {@link exited} resolves when that file
 * appears. The trap fires on a normal end, an explicit `exit N`, and a
 * `set -e` abort alike.
 */
export interface ScriptRun {
  /** Shell line for `SpawnOptions.command`. */
  command: string;
  /** Resolves with the script's exit code. Never rejects. */
  exited: Promise<number>;
  /** Stop watching and remove the temp dir. Idempotent. */
  dispose(): void;
}

/** POSIX single-quote a string (`'` becomes `'\''`). Also valid in zsh and fish. */
function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Wrap `script` so it runs with bash semantics (as the old hidden runner's
 * `bash -c <script>` did) regardless of the user's login shell, prints what
 * it is running and how it ended, and reports its exit code.
 */
export function prepareScriptRun(script: string, label: "setup" | "teardown"): ScriptRun {
  // mkdtemp creates the dir with mode 0700, so no other user can plant or
  // read the exit-code file.
  const dir = mkdtempSync(join(tmpdir(), "band-script-"));
  const exitFile = join(dir, "exit-code");
  const partialFile = `${exitFile}.partial`;

  // Written then renamed, so the watcher never reads a half-written file.
  const onExit = [
    "rc=$?",
    `printf '\\n[band] ${label} finished with exit code %s\\n' "$rc"`,
    `printf %s "$rc" > ${quote(partialFile)}`,
    `mv ${quote(partialFile)} ${quote(exitFile)}`,
  ].join("; ");
  const inner = [
    `trap ${quote(onExit)} EXIT`,
    `printf '[band] running ${label}: %s\\n\\n' ${quote(script)}`,
    script,
  ].join("\n");
  const command = `bash -c ${quote(inner)}`;

  let watcher: FSWatcher | null = null;
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
    rmSync(dir, { recursive: true, force: true });
  };

  try {
    watcher = watch(dir, check);
    watcher.on("error", (err) => log.warn({ err }, "exit-code watcher failed"));
  } catch (err) {
    log.warn({ err }, "could not watch for the script's exit code");
  }

  return { command, exited, dispose };
}
