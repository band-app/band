import { join } from "node:path";
import type { Host, ScriptPlan } from "@band-app/host-api";
import { createLogger } from "@band-app/logger";

const log = createLogger("script-run");

/** How often {@link prepareScriptRun} checks for the exit-code file, in case `fs.watch` misses it. */
const POLL_MS = 1_000;

const decoder = new TextDecoder();

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
export type ScriptRun = ScriptPlan;

/** POSIX single-quote a string (`'` becomes `'\''`). */
function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Wrap `script` so it runs with bash semantics (as the old hidden runner's
 * `bash -c <script>` did) regardless of the user's login shell, prints what
 * it is running and how it ended, and reports its exit code. POSIX only;
 * see `HostScripts.runHidden` for Windows.
 */
export async function prepareScriptRun(
  host: Host,
  script: string,
  label: "setup" | "teardown",
): Promise<ScriptPlan> {
  // mkdtemp creates the dir with mode 0700, so no other user can plant or
  // read the script or the exit-code file.
  const dir = await host.fs.mkdtemp("band-script-");
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
  await host.fs.writeFile(scriptFile, body, { mode: 0o600 });
  const command = `bash ${quote(scriptFile)}`;

  let watcher: AbortController | null = null;
  let poll: NodeJS.Timeout | null = null;
  let disposed = false;
  let resolveExited!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExited = resolve;
  });

  const check = () => {
    if (disposed) return;
    host.fs.readFile(exitFile).then(
      (bytes) => {
        const text = decoder.decode(bytes);
        if (disposed) return;
        const code = Number.parseInt(text.trim(), 10);
        resolveExited(Number.isNaN(code) ? 1 : code);
        dispose();
      },
      // Not written yet.
      () => {},
    );
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    watcher?.abort();
    watcher = null;
    if (poll) clearInterval(poll);
    poll = null;
    void host.fs
      .rm(dir, { recursive: true, force: true })
      .catch((err) => log.warn({ err }, "could not remove the script's temp dir"));
  };

  // `fs.watch` reports the file promptly; the poll covers a watcher that
  // fails to start or errors later, so `exited` still resolves.
  const controller = new AbortController();
  watcher = controller;
  void (async () => {
    for await (const _change of host.fs.watch(dir, { signal: controller.signal, recursive: false }))
      check();
  })().catch((err) => log.warn({ err }, "exit-code watcher failed; polling instead"));
  poll = setInterval(check, POLL_MS);
  poll.unref();

  return { command, exited, dispose };
}
