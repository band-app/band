/**
 * Ripgrep client — raw `spawn(rgPath, …)` shell-out with `--json`
 * streaming output. Lives in the infra tier so the services layer
 * (`SearchService`) only deals with the parsed match stream and the
 * business decisions on top of it (limit, cancellation policy).
 *
 * Lifted out of `services/search-service.ts` as part of issue #535
 * follow-up — the only remaining services-tier shell-out after
 * follow-up 3 moved every other one behind an infra adapter.
 *
 * Defensive details preserved from the original:
 *   - `stdio: ["ignore", "pipe", "pipe"]` closes stdin so ripgrep can't
 *     fall back to its stdin-reading mode (which would hang under
 *     `spawn` whose default piped stdin is not a TTY).
 *   - The cwd is passed as an explicit search path (`./`). Without it,
 *     ripgrep reads from stdin and hangs for the same reason.
 *   - Non-UTF-8 paths/lines come back as `bytes` (base64) instead of
 *     `text`; we skip those because the UI can't render them.
 */

import { spawn } from "node:child_process";
import { rgPath } from "@vscode/ripgrep";

export interface RipgrepOptions {
  /** Search query — a literal string by default, or a regex when `regex` is true. */
  query: string;
  /** Working directory to search in. */
  cwd: string;
  /**
   * Case-sensitive match. Defaults to false — omitting the field passes
   * `--ignore-case` to ripgrep, matching the editor's "case insensitive
   * by default" search behaviour.
   */
  caseSensitive?: boolean;
  /** Match whole words only (`--word-regexp`). */
  wholeWord?: boolean;
  /** Treat `query` as a regex instead of a literal. */
  regex?: boolean;
}

export interface RipgrepMatch {
  /** Workspace-relative file path (the `./` prefix is stripped). */
  file: string;
  /** 1-based line number. */
  line: number;
  /** The matched line's text (trailing newline stripped). */
  content: string;
}

/**
 * Run ripgrep against `cwd` with the supplied options. Returns an async
 * iterable of parsed `RipgrepMatch` events. The caller may break out of
 * the iteration early to stop the process — when the iterator's `return`
 * is invoked (typical when `for await` is broken out of) the child is
 * killed with `SIGTERM`.
 */
export function streamMatches(options: RipgrepOptions): AsyncIterable<RipgrepMatch> {
  return {
    [Symbol.asyncIterator]: () => createIterator(options),
  };
}

function createIterator(options: RipgrepOptions): AsyncIterator<RipgrepMatch> {
  const args: string[] = [];
  if (!options.caseSensitive) args.push("--ignore-case");
  if (options.wholeWord) args.push("--word-regexp");
  if (!options.regex) args.push("--fixed-strings");
  args.push("--json");
  args.push("--", options.query, "./");

  const child = spawn(rgPath, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });

  const matches: RipgrepMatch[] = [];
  const errChunks: string[] = [];
  let stdoutBuf = "";
  let done = false;
  let error: Error | null = null;
  let notify: (() => void) | null = null;

  function signal() {
    const fn = notify;
    notify = null;
    fn?.();
  }

  child.stdout.setEncoding("utf-8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuf += chunk;
    while (true) {
      const nlIdx = stdoutBuf.indexOf("\n");
      if (nlIdx === -1) break;
      const line = stdoutBuf.slice(0, nlIdx);
      stdoutBuf = stdoutBuf.slice(nlIdx + 1);
      if (!line) continue;

      let event: {
        type?: string;
        data?: {
          path?: { text?: string };
          line_number?: number;
          lines?: { text?: string };
        };
      };
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }

      if (event.type !== "match") continue;
      const data = event.data;
      if (!data) continue;
      const rawFile = data.path?.text;
      const lineNumber = data.line_number;
      const rawContent = data.lines?.text;
      if (!rawFile || typeof lineNumber !== "number" || rawContent === undefined) {
        continue;
      }
      const file = rawFile.startsWith("./") ? rawFile.slice(2) : rawFile;
      const content = rawContent.endsWith("\n") ? rawContent.slice(0, -1) : rawContent;
      matches.push({ file, line: lineNumber, content });
    }
    signal();
  });

  child.stderr.setEncoding("utf-8");
  child.stderr.on("data", (chunk: string) => {
    errChunks.push(chunk);
  });

  child.on("error", (err) => {
    error = err;
    done = true;
    signal();
  });

  child.on("close", (code) => {
    // ripgrep exit codes: 0 = matches, 1 = no matches, 2 = error.
    if (code !== 0 && code !== 1) {
      error = new Error(`ripgrep exited with code ${code}: ${errChunks.join("").trim()}`);
    }
    done = true;
    signal();
  });

  function killChild() {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
  }

  return {
    async next(): Promise<IteratorResult<RipgrepMatch>> {
      while (true) {
        if (matches.length > 0) {
          const value = matches.shift()!;
          return { value, done: false };
        }
        if (error) throw error;
        if (done) return { value: undefined, done: true };
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
    },
    async return(): Promise<IteratorResult<RipgrepMatch>> {
      killChild();
      done = true;
      return { value: undefined, done: true };
    },
    async throw(err): Promise<IteratorResult<RipgrepMatch>> {
      killChild();
      done = true;
      throw err;
    },
  };
}
