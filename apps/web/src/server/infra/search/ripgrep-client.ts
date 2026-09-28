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
 *   - `--hidden` is passed so files inside dot-directories like
 *     `.github/`, `.husky/`, `.claude/`, `.vscode/` are searched. By
 *     default ripgrep skips any path whose name starts with `.`, which
 *     caused find-in-files to silently miss content the user could see
 *     in the file picker (`git ls-files` already returns those tracked
 *     dot-paths). `--glob !.git` keeps the repo's internal git database
 *     out of results — `.gitignore` is still honoured for everything
 *     else, so `node_modules/`, build output, etc. stay excluded. See
 *     issue #536.
 *
 * The same binary also drives `listFiles` (below) which powers the
 * Quick Open (Cmd+P) file picker. `git ls-files` was the original
 * implementation but stops at nested git repo boundaries — workspaces
 * that contain independently-cloned subrepos lost every file outside
 * the outer worktree (issue #530). ripgrep's `--files --no-require-git`
 * mode walks the directory tree directly so nested repos / submodules
 * are surfaced too, while still respecting per-directory `.gitignore`
 * via `--no-ignore-parent --no-ignore-global` (we want the local
 * exclude rules but not the user's `~/.gitignore`).
 */

import { execFile, spawn } from "node:child_process";
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
  // Surface tracked content inside dot-directories (.github, .husky,
  // .claude, .vscode, ...) — see file header. .git/ stays excluded so
  // we don't dump the repo's internal git database into results.
  args.push("--hidden", "--glob", "!.git");
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

/**
 * Buffer cap for `listFiles`. A monorepo workspace easily produces a few
 * hundred KB of newline-separated paths; 50 MB keeps the same generous
 * ceiling used elsewhere (see `git-client.ts::MAX_BUFFER`) so a large
 * tree never truncates silently. We never expose the buffer to a
 * client — it's only used as a sanity bound for `execFile`.
 */
const LIST_FILES_MAX_BUFFER = 50 * 1024 * 1024;

/**
 * Enumerate every file under `cwd` using `rg --files`, returning paths
 * relative to `cwd`. This replaces `git ls-files --cached --others
 * --exclude-standard` (issue #530): `git ls-files` refuses to descend
 * into nested git repositories, so workspaces containing
 * independently-cloned subrepos lost every file outside the outer
 * worktree.
 *
 * Flag rationale (in order, all defensible against the issue):
 *   - `--files` — list paths instead of grepping content.
 *   - `--hidden` — surface dotfiles (e.g. `.github/workflows/*`); the
 *     `--glob '!**\/.git'` exclusion below keeps `.git` internals out.
 *   - `--follow` — follow symlinks (matches users' mental model where
 *     a linked directory is "part of the project").
 *   - `--no-require-git` — keep listing files even when `cwd` is not a
 *     git checkout (Band workspaces are sometimes plain directories;
 *     see `search-content.test.ts::"non-git directories"`).
 *   - `--no-ignore-parent` / `--no-ignore-global` / `--no-config` —
 *     respect the workspace's own `.gitignore` / `.rgignore` but ignore
 *     the user's `~/.gitignore` and `~/.config/ripgreprc`. We want the
 *     same exclusions every contributor sees, not whatever the host
 *     happens to have configured.
 *   - `--glob '!**\/.git'` — exclude the `.git` directory itself
 *     (ripgrep already skips it when running inside a checkout, but
 *     `--no-require-git` turns that off, so we re-add it explicitly).
 *   - `--glob '!**\/node_modules'` — these are huge and never useful
 *     in Quick Open; the previous `git ls-files` implementation already
 *     excluded them via `.gitignore` so this preserves behaviour.
 *   - `--glob '!**\/.DS_Store'` — macOS metadata droppings; same
 *     rationale as above.
 *
 * Non-UTF-8 paths are dropped by ripgrep when stdout is set to text
 * encoding; the UI couldn't render them anyway.
 */
export function listFiles(cwd: string): Promise<string[]> {
  const args = [
    "--files",
    "--hidden",
    "--follow",
    "--no-require-git",
    "--no-ignore-parent",
    "--no-ignore-global",
    "--no-config",
    "-g",
    "!**/.git",
    "-g",
    "!**/node_modules",
    "-g",
    "!**/.DS_Store",
  ];
  return new Promise((resolve, reject) => {
    execFile(
      rgPath,
      args,
      { cwd, maxBuffer: LIST_FILES_MAX_BUFFER, encoding: "utf-8" },
      (err, stdout, stderr) => {
        // ripgrep exits non-zero only on true errors here — `--files`
        // returns 0 on success (even with zero matches) and 2 on
        // failure. Surface stderr so the caller gets an actionable
        // message; the WorkspaceNotFoundError path lives upstream.
        if (err) {
          reject(new Error(stderr || err.message));
          return;
        }
        const files = stdout.split("\n").filter(Boolean);
        resolve(files);
      },
    );
  });
}
