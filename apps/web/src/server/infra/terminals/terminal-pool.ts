import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { createLogger } from "@band-app/logger";
import type { SerializeAddon } from "@xterm/addon-serialize";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";
import type { IPty } from "node-pty";
import { defaultShell, shellPath } from "../process/path";

const log = createLogger("terminal-pool");

const MAX_SCROLLBACK_SIZE = 100_000;

/**
 * Lines of scrollback kept by the headless xterm mirror used for
 * replay-on-reconnect (see {@link TerminalPool.serialize}). Matches the
 * client xterm's `scrollback: 10000` (terminal-cache.ts) so a reconnect
 * replays as much history as the client can hold; the raw byte buffer
 * above covers the plain-text read paths. Deliberate memory trade-off: a
 * saturated mirror buffer costs several MB per terminal (~12 bytes/cell ×
 * cols × 10k lines), paid for the lifetime of each PTY.
 */
const HEADLESS_SCROLLBACK_LINES = 10_000;

/**
 * Upper bounds for a terminal's dimensions. The `cols`/`rows` on a
 * `resize` come from the client over the WebSocket, and the headless mirror
 * allocates a buffer proportional to `cols × (rows + scrollback)` — so an
 * authenticated client sending absurd dims (e.g. `1e9`) could force a huge
 * allocation. These caps sit well above any real display (a 4K monitor at a
 * tiny font is ~500 cols) while bounding the worst case; dims are also floored
 * at 1 so a zero/negative never reaches node-pty. Applied at this single
 * resource boundary so every caller (WS `attach`, folded `init` dims, the
 * live `resize` message, the tRPC path) is covered.
 */
const MAX_COLS = 1_000;
const MAX_ROWS = 1_000;

/**
 * The last `max` characters of a terminal's output, for the plain-text read
 * paths. Appending is O(1): chunks are kept as-is and whole chunks drop off
 * the front once the rest still covers `max`. Trimming to exactly `max`
 * happens only on read. (A single string that is appended to and re-sliced
 * copied the whole ~100 KB tail on every PTY chunk, even a one-byte echo.)
 */
class OutputTail {
  private chunks: string[] = [];
  /** Index of the oldest chunk still held; earlier slots are dropped. */
  private head = 0;
  /** Total characters in `chunks[head..]`. */
  private size = 0;

  constructor(private readonly max: number) {}

  get length(): number {
    return Math.min(this.size, this.max);
  }

  append(data: string): void {
    if (data.length === 0) return;
    this.chunks.push(data);
    this.size += data.length;
    while (this.size - this.chunks[this.head].length >= this.max) {
      this.size -= this.chunks[this.head].length;
      this.head += 1;
    }
    // Reclaim dropped slots once they outnumber the live ones.
    if (this.head > 64 && this.head * 2 > this.chunks.length) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
  }

  toString(): string {
    const joined = this.chunks.slice(this.head).join("");
    // Keep the joined form so repeated reads don't join again.
    this.chunks = [joined];
    this.head = 0;
    return joined.length > this.max ? joined.slice(-this.max) : joined;
  }
}

/**
 * Options for spawning a new PTY session.
 *
 * The shape is shared between the tRPC `terminal.create` mutation, the
 * WebSocket handler (`server/api/terminals/ws.ts`), and the service tier —
 * all of them pass user-supplied options straight through to the pool.
 */
export interface SpawnOptions {
  /** Shell command to auto-run after the PTY spawns. */
  command?: string;
  /** Working directory, resolved relative to the workspace root. */
  cwd?: string;
  /** Extra environment variables merged into the base env. */
  env?: Record<string, string>;
}

/**
 * Per-spawn settings that come from the caller rather than the user.
 */
export interface SpawnExtras {
  /**
   * Reported back on the session's {@link TerminalExitEvent} so the caller can
   * prune the tab when the shell exits on its own (issue #581). Stored on the
   * session rather than held in a closure so it survives the caller: the
   * terminal daemon keeps sessions alive across web-server restarts, and the
   * restarted server still has to honour it.
   */
  cleanupOnExit?: boolean;
  /**
   * Environment the shell inherits before the pool's own overrides. Defaults
   * to this process's env. The terminal daemon passes the web server's env
   * here, because the server sets per-instance values (`BAND_SERVER_URL`,
   * `BAND_PORT`) that a long-lived daemon's own env would have frozen at
   * launch.
   */
  baseEnv?: Record<string, string | undefined>;
}

/**
 * Fired once per session when its PTY exits, for natural exits and explicit
 * kills alike.
 */
export interface TerminalExitEvent {
  terminalId: string;
  workspaceId: string;
  exitCode: number;
  /** True when the exit came from {@link TerminalPool.kill} / `killWorkspace` / `killAll`. */
  killed: boolean;
  cleanupOnExit: boolean;
}

/** Live output chunk plus its per-session sequence number (1-based, gap-free). */
export type TerminalOutputListener = (data: string, seq: number) => void;

/**
 * A serialized snapshot and the sequence number of the last output chunk it
 * contains. Chunks with a higher `seq` are not in the snapshot.
 */
export interface TerminalSnapshot {
  data: string;
  seq: number;
}

/**
 * One live PTY session tracked by the pool.
 *
 * The pool owns the `IPty` handle, the buffered scrollback, and the
 * `workspaceId` reverse-lookup so the service tier never has to touch
 * `node-pty` directly. `scrollback` holds the last `MAX_SCROLLBACK_SIZE`
 * (~100 KB) characters of output (see {@link OutputTail}). It serves the
 * plain-text read paths (`terminal.output` / `band terminals output`);
 * replay-into-a-terminal paths use the
 * `headless` mirror via {@link TerminalPool.serialize} instead, because
 * the tail-sliced raw bytes are not sound to replay (they can start
 * mid-escape-sequence).
 */
export interface TerminalSession {
  pty: IPty;
  scrollback: OutputTail;
  /**
   * Headless xterm that parses the same PTY stream the clients see, so
   * the pool can serialize a clean reconstruction of the current terminal
   * state for replay on reconnect. Kept in lock-step with the PTY dims by
   * {@link TerminalPool.resize} and disposed with the PTY on exit.
   */
  headless: HeadlessTerminal;
  serializeAddon: SerializeAddon;
  workspaceId: string;
  /** Number of output chunks emitted so far; the last chunk's `seq`. */
  seq: number;
  /**
   * Outstanding {@link TerminalPool.holdOutput} calls. The PTY is paused
   * while this is above zero, so independent holders (a snapshot drain, a
   * backed-up daemon stream) can't resume it under each other.
   */
  holds: number;
  cleanupOnExit: boolean;
  /**
   * Path of the temp file staging an auto-run command, if any. Removed
   * when the PTY exits (see {@link TerminalPool.autoRunCommand}). Kept on
   * the session so cleanup doesn't depend on the command ever running.
   */
  autoRunFile?: string;
}

/**
 * Metadata returned by `TerminalPool.list` — the subset of `TerminalSession`
 * fields that are safe to surface over tRPC (no live `IPty` reference).
 */
export interface TerminalListEntry {
  terminalId: string;
  workspaceId: string;
  pid: number;
  scrollbackLength: number;
  title: string;
  /** Prune the tab when the shell exits on its own (see `SpawnExtras.cleanupOnExit`). */
  cleanupOnExit: boolean;
}

/**
 * Stateful in-memory registry of PTY sessions.
 *
 * Infra tier — manages an external resource (forked shell processes). The
 * class is deliberately small and dependency-free aside from `node-pty` and
 * the `shellPath` helper; all business logic (workspace resolution, layout
 * persistence, event emission) lives in `TerminalService`.
 *
 * One instance per PTY host: the terminal daemon owns one, and
 * `InProcessTerminalBackend` owns one when the daemon isn't used. Callers in
 * the web server go through a `TerminalBackend`, never the pool directly.
 */
export class TerminalPool {
  /** terminalId -> session */
  private readonly terminals = new Map<string, TerminalSession>();

  /** workspaceId -> Set<terminalId> (reverse index for workspace-level cleanup) */
  private readonly workspaceTerminals = new Map<string, Set<string>>();

  /** terminalId -> Set<listener> for live output streaming */
  private readonly outputListeners = new Map<string, Set<TerminalOutputListener>>();

  private readonly exitListeners = new Set<(event: TerminalExitEvent) => void>();

  /**
   * terminalId -> in-flight spawn promise. A single terminal is created via TWO
   * concurrent paths — the WebSocket handler (spawn-on-`getSession`-miss) and
   * the tRPC `terminal.create` mutation. Without deduplication both spawn a PTY
   * and the second `terminals.set` overwrites the first, so the client stays
   * wired to one PTY while the server's session map (and thus scrollback /
   * `terminals output` / reconnect-replay) points at the other. That's the
   * "output on screen but empty server scrollback until reload" bug
   * (band-app/band#617). This map makes concurrent spawns share ONE PTY.
   */
  private readonly spawning = new Map<string, Promise<TerminalSession>>();

  /** terminalId -> in-flight serialize drain, shared by concurrent callers
   *  (see {@link serialize} for why the pause/resume pair must not overlap). */
  private readonly serializing = new Map<string, Promise<TerminalSnapshot | null>>();

  /** terminalIds with a shrink-and-restore nudge in flight (see
   *  {@link nudgeResize} for why concurrent nudges must not compound). */
  private readonly nudging = new Set<string>();

  /**
   * Spawn (or return the already-spawning/spawned) PTY for a terminalId.
   *
   * Idempotent per terminalId: if a session already exists it is returned
   * as-is, and concurrent spawn calls for the same id share a single in-flight
   * promise — so the WebSocket and tRPC create paths never create competing
   * PTYs. `workspaceRoot` is the absolute worktree path; resolving the
   * workspaceId to a path is the service tier's job so the pool stays oblivious
   * to the workspace registry.
   */
  async spawn(
    workspaceId: string,
    terminalId: string,
    workspaceRoot: string,
    options?: SpawnOptions,
    extras?: SpawnExtras,
  ): Promise<TerminalSession> {
    const existing = this.terminals.get(terminalId);
    if (existing) return existing;
    const inflight = this.spawning.get(terminalId);
    if (inflight) return inflight;
    // Store the promise synchronously (before any await) so a concurrent call
    // that arrives while this one is awaiting sees it and reuses it.
    const promise = this.spawnNew(workspaceId, terminalId, workspaceRoot, options, extras);
    this.spawning.set(terminalId, promise);
    try {
      return await promise;
    } finally {
      this.spawning.delete(terminalId);
    }
  }

  private async spawnNew(
    workspaceId: string,
    terminalId: string,
    workspaceRoot: string,
    options?: SpawnOptions,
    extras?: SpawnExtras,
  ): Promise<TerminalSession> {
    const shell = defaultShell();
    const resolvedPath = await shellPath();

    // Filter env to only string values — posix_spawnp fails on undefined/null
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(extras?.baseEnv ?? process.env)) {
      if (value != null) {
        env[key] = value;
      }
    }
    env.PATH = resolvedPath;
    env.TERM = "xterm-256color";
    // Advertise 24-bit colour support. xterm.js handles truecolor escapes
    // natively, but many statusline tools (starship, claude-code, oh-my-posh,
    // etc.) gate their RGB output on COLORTERM=truecolor — without it they
    // fall back to plain text or basic 16-colour, which renders the Powerline
    // segments as monochrome blocks. iTerm2/Alacritty/kitty/Ghostty all set
    // this; node-pty does not, so we set it explicitly.
    env.COLORTERM = "truecolor";
    // Color vars inherited from the launching shell — NO_COLOR / CLICOLOR=0
    // disable color, FORCE_COLOR pins a level — override COLORTERM's
    // truecolor hint in most tools (e.g. a server started from a profile
    // exporting NO_COLOR=1 renders every pane monochrome). This pane IS a
    // truecolor terminal, so drop them and let tools detect from COLORTERM.
    delete env.NO_COLOR;
    delete env.FORCE_COLOR;
    delete env.CLICOLOR;
    // Hint foreground/background colors so CLI tools (vim, bat, etc.) don't send
    // OSC 11 queries whose responses leak as visible garbage in the terminal.
    env.COLORFGBG = "15;0";
    // Remove PORT so workspace dev servers don't inherit the Band server's port
    delete env.PORT;

    // Merge extra env from spawn options
    if (options?.env) {
      Object.assign(env, options.env);
    }

    // Pin the dispatch target for any nested `band` CLI call typed into
    // this pane to `terminal`, matching where it runs. The server's own
    // process.env carries no `BAND_DISPATCH` today, so the Rust CLI would
    // already fall through to its `terminal` default — but setting it
    // explicitly keeps the terminal path correct even if a future change
    // ever sets `BAND_DISPATCH` server-wide, and mirrors the
    // `BAND_DISPATCH=chat` the coding-agent subprocesses inject (see
    // packages/coding-agent/src/adapter-env.ts). Set AFTER the
    // `options.env` merge so the pool-mandated value always wins — a
    // caller can't accidentally (or deliberately) downgrade a terminal
    // pane to `chat` dispatch.
    env.BAND_DISPATCH = "terminal";

    // Resolve cwd: options.cwd is relative to workspace root
    let cwd = workspaceRoot;
    if (options?.cwd) {
      const resolved = join(workspaceRoot, options.cwd);
      // Security: ensure the resolved path stays within the workspace.
      // Append `sep` (with an equality carve-out for cwd === root) so a
      // sibling like `<root>-evil` can't pass the prefix check — same
      // shape as `serveWorkspaceFile` in start-server.ts.
      if (resolved !== workspaceRoot && !resolved.startsWith(workspaceRoot + sep)) {
        log.warn(
          "Ignoring cwd %s — resolves outside workspace root %s",
          options.cwd,
          workspaceRoot,
        );
      } else if (existsSync(resolved)) {
        cwd = resolved;
      } else {
        log.warn("Ignoring cwd %s — directory does not exist", options.cwd);
      }
    }

    if (!existsSync(cwd)) {
      throw new Error(`Workspace directory does not exist: ${cwd}`);
    }
    if (!existsSync(shell)) {
      throw new Error(`Shell not found: ${shell}`);
    }

    log.debug(
      "Spawning shell %s in %s for terminal %s (PATH=%s)",
      shell,
      cwd,
      terminalId,
      resolvedPath.slice(0, 200),
    );

    // Use the namespace directly rather than `.default`. node-pty's
    // CJS index.js sets `exports.__esModule = true` and never sets
    // `module.exports.default` — so:
    //   - Node's CJS-to-ESM interop (used by the prod bundle) exposes
    //     the whole module both as `.default` *and* as a namespace
    //     containing `spawn`, `fork`, etc.
    //   - tsx's esbuild-style loader (used by `pnpm dev:web` since
    //     #477 collapsed dev onto `start-server.ts`) honours the
    //     `__esModule` flag and exposes ONLY the namespace, leaving
    //     `.default` undefined.
    // Reaching for `.spawn` on the namespace works under both loaders.
    const nodePty = await import("node-pty");
    let ptyProcess: IPty;
    try {
      ptyProcess = nodePty.spawn(shell, [], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd,
        env,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("pty.spawn failed: %s (shell=%s, cwd=%s)", msg, shell, cwd);
      throw err;
    }

    // Headless xterm mirror for replay-on-reconnect (see `serialize`).
    // Same CJS-ESM interop caveat as node-pty above, with a twist: these
    // packages ship webpack bundles whose named exports Node's
    // cjs-module-lexer can't detect, so under a plain Node import the
    // classes are reachable ONLY via `.default`, while tsx's loader (and
    // esbuild's bundle interop) put them on the namespace. Reach through
    // whichever is present.
    let headless: HeadlessTerminal;
    let serializeAddon: SerializeAddon;
    try {
      const headlessNs = (await import("@xterm/headless")) as
        | typeof import("@xterm/headless")
        | { default: typeof import("@xterm/headless") };
      const { Terminal } = "Terminal" in headlessNs ? headlessNs : headlessNs.default;
      const serializeNs = (await import("@xterm/addon-serialize")) as
        | typeof import("@xterm/addon-serialize")
        | { default: typeof import("@xterm/addon-serialize") };
      const { SerializeAddon } =
        "SerializeAddon" in serializeNs ? serializeNs : serializeNs.default;

      // Dims match the PTY spawn above; `resize` keeps them in lock-step.
      headless = new Terminal({
        cols: 80,
        rows: 24,
        scrollback: HEADLESS_SCROLLBACK_LINES,
        allowProposedApi: true,
      });
      serializeAddon = new SerializeAddon();
      // SerializeAddon's typings are written against the browser
      // `@xterm/xterm` Terminal; the headless Terminal exposes the same core
      // surface minus the DOM members, so the addon works but needs the cast.
      headless.loadAddon(serializeAddon as unknown as Parameters<typeof headless.loadAddon>[0]);
    } catch (err) {
      // The PTY spawned above but the session was never registered — kill it
      // so a failed headless setup can't leak an orphaned shell process.
      ptyProcess.kill();
      const msg = err instanceof Error ? err.message : String(err);
      log.error("headless mirror setup failed for terminal %s: %s", terminalId, msg);
      throw err;
    }

    const session: TerminalSession = {
      pty: ptyProcess,
      scrollback: new OutputTail(MAX_SCROLLBACK_SIZE),
      headless,
      serializeAddon,
      workspaceId,
      seq: 0,
      holds: 0,
      cleanupOnExit: extras?.cleanupOnExit ?? false,
    };
    this.terminals.set(terminalId, session);

    // Auto-run initial command if provided. Robust against the cold-PTY
    // race — see autoRunCommand for why a naive `pty.write` truncates and
    // mangles long prompt-as-argv command lines.
    if (options?.command) {
      this.autoRunCommand(session, options.command);
    }

    // Register in reverse index
    let ids = this.workspaceTerminals.get(workspaceId);
    if (!ids) {
      ids = new Set();
      this.workspaceTerminals.set(workspaceId, ids);
    }
    ids.add(terminalId);

    // Buffer all PTY output for the plain-text read paths, mirror it into
    // the headless terminal for replay-on-reconnect, and notify listeners.
    ptyProcess.onData((data: string) => {
      session.scrollback.append(data);
      session.headless.write(data);
      session.seq += 1;
      const seq = session.seq;
      const listeners = this.outputListeners.get(terminalId);
      if (listeners) {
        for (const cb of listeners) {
          try {
            cb(data, seq);
          } catch {
            // listener errors must not crash the PTY data handler
          }
        }
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      log.debug("Terminal exited: %s (workspace %s)", terminalId, workspaceId);
      // Distinguish a natural exit from an explicit `kill()`: the `kill()` path
      // calls `pty.kill()` and then synchronously deletes the session from
      // `terminals` — both run before node-pty's async `onExit` fires here, so
      // if the entry is already gone the caller tore this terminal down. On a
      // natural exit the entry is still present (this handler deletes it just
      // below). Captured before that delete.
      const explicitlyKilled = !this.terminals.has(terminalId);
      this.terminals.delete(terminalId);
      this.outputListeners.delete(terminalId);
      const set = this.workspaceTerminals.get(workspaceId);
      if (set) {
        set.delete(terminalId);
        if (set.size === 0) {
          this.workspaceTerminals.delete(workspaceId);
        }
      }
      // Remove the staged auto-run command file, if any.
      if (session.autoRunFile) {
        try {
          unlinkSync(session.autoRunFile);
        } catch {
          // Already gone / never written — nothing to clean up.
        }
      }
      // Tear down the headless mirror with the PTY. This handler fires for
      // explicit `kill()` paths too (pty.kill → onExit), so it is the single
      // dispose site; also disposes the loaded SerializeAddon.
      session.headless.dispose();
      // The pool stays oblivious to layout / event concerns; listeners decide
      // what an exit means. `killed` lets them skip the teardown an explicit
      // `kill()` caller already ran, so `terminal-killed` isn't emitted twice.
      // Guarded so a throwing listener can't wedge the exit handler.
      const event: TerminalExitEvent = {
        terminalId,
        workspaceId,
        exitCode,
        killed: explicitlyKilled,
        cleanupOnExit: session.cleanupOnExit,
      };
      for (const listener of this.exitListeners) {
        try {
          listener(event);
        } catch (err) {
          log.warn("exit listener threw for terminal %s: %s", terminalId, err);
        }
      }
    });

    return session;
  }

  /**
   * Auto-run the workspace's initial command inside a freshly spawned PTY,
   * robustly.
   *
   * Writing a long command line straight into a cold PTY is racy on three
   * fronts, all of which surfaced in production with `via=terminal`
   * prompt-as-argv launches (`'<agent-binary>' '<entire-prompt>'`):
   *
   *   1. **Dropped newline.** The shell may not have finished sourcing its
   *      rc files, and the tty can still be in its startup canonical-mode
   *      window. A trailing `\n` written then is swallowed — the command
   *      is typed at the prompt but never executed.
   *   2. **Truncation.** A single input line longer than the tty's
   *      canonical buffer (`MAX_CANON`, ~4 KB) is clipped. Long prompts
   *      blow past that easily.
   *   3. **UTF-8 corruption.** A multi-byte sequence split across a tty
   *      buffer boundary is mangled (the classic em-dash → mojibake).
   *
   * Fix both layers: (1) stage the command's bytes in a temp file so they
   * never traverse the tty's canonical input buffer — sidestepping the
   * truncation and UTF-8-split failures entirely — and (2) wait for the
   * shell to emit its first output (its prompt) before writing the
   * *short* `source <file>` line. The short line is well under the
   * canonical limit and lands after the cold-start window, so its newline
   * survives. `source` runs the command in the current interactive shell,
   * so the user keeps their session afterwards.
   */
  private autoRunCommand(session: TerminalSession, command: string): void {
    const pty = session.pty;
    let cmdFile: string;
    try {
      // Derive the temp filename from a FRESH server-side `randomUUID()`,
      // NOT from the caller-supplied `terminalId`: the `/terminal`
      // WebSocket spawn path takes that id straight from the query string
      // without validation (the tRPC `terminal.create` input IS
      // UUID-constrained, but the WS path is not), and `path.join`
      // collapses `../` segments — so keying the path on it would let a
      // caller (`terminalId=../../etc/cron.d/evil`) steer this write
      // anywhere. A fresh UUID keeps the path unconditionally inside
      // `tmpdir()`, which is why the unvalidated WS id is harmless here.
      cmdFile = join(tmpdir(), `band-autorun-${randomUUID()}.sh`);
      // Trailing newline so the final command in the file is a complete
      // line for the shell parser. UTF-8 bytes are preserved verbatim —
      // the shell reads them from the file, not through the tty.
      //
      // `flag: "wx"` opens with O_CREAT|O_EXCL so the write REFUSES to
      // follow a pre-existing file or symlink planted at this path —
      // closing the classic predictable-temp-file symlink/TOCTOU hole on
      // a multi-user host. With a fresh UUID a collision is effectively
      // impossible; if one ever occurs the EEXIST throw drops us to the
      // catch's direct-write fallback, which is safe.
      writeFileSync(cmdFile, `${command}\n`, { encoding: "utf-8", mode: 0o600, flag: "wx" });
      session.autoRunFile = cmdFile;
    } catch (err) {
      // If we can't stage a temp file, fall back to the naive write —
      // better to risk the cold-PTY race than to silently not run the
      // command at all.
      // Log only the message, not the raw error — its serialisation can
      // include the attempted filesystem path.
      log.warn(
        "autoRunCommand: temp-file staging failed (%s); writing command directly",
        err instanceof Error ? err.message : String(err),
      );
      pty.write(`${command}\n`);
      return;
    }

    // Use the POSIX dot builtin (`. '<file>'`), NOT `source`: `source` is
    // a bash/zsh-ism that dash (`/bin/sh` on most Linux hosts) doesn't
    // recognise, so the injected line would silently fail there. `.` runs
    // the file in the current interactive shell across sh/dash/bash/zsh.
    // Single-quote the path and escape any embedded single-quote (POSIX
    // `'\''`) so a `TMPDIR` containing a `'` can't break the quoting and
    // inject into the shell.
    const quotedPath = cmdFile.replace(/'/g, `'\\''`);
    const sourceLine = `. '${quotedPath}'\n`;

    let done = false;
    const inject = () => {
      if (done) return;
      done = true;
      try {
        pty.write(sourceLine);
      } catch (err) {
        // The PTY exited before we got to inject (e.g. the user closed the
        // pane during the cold-start window). Nothing left to run.
        log.warn("autoRunCommand: failed to inject command line (%s)", err);
      }
    };

    // Dispose the readiness listener at most once — node-pty's IDisposable
    // doesn't promise idempotency, so a double-dispose could throw.
    let dataDisposed = false;
    const disposeData = () => {
      if (dataDisposed) return;
      dataDisposed = true;
      dataDisposable.dispose();
    };

    // The shell's first output (its prompt) is our readiness signal that
    // the tty is past its cold-start window. Inject then. A fallback timer
    // covers a shell that prints nothing, so the command still runs; it's
    // unref'd so it never keeps the process alive. An `onExit` listener
    // cancels both signals so a late timer can never write to a dead PTY.
    const dataDisposable = pty.onData(() => {
      disposeData();
      inject();
    });
    const timer = setTimeout(inject, 750);
    timer.unref();
    let exitDisposed = false;
    const exitDisposable = pty.onExit(() => {
      done = true;
      clearTimeout(timer);
      disposeData();
      // Self-remove (once) so this listener doesn't outlive the single PTY
      // exit it exists to catch. Guarded like `disposeData` because
      // node-pty's IDisposable doesn't promise idempotency.
      if (exitDisposed) return;
      exitDisposed = true;
      exitDisposable.dispose();
    });
  }

  /**
   * Returns an existing PTY session by terminalId, or undefined.
   */
  get(terminalId: string): TerminalSession | undefined {
    return this.terminals.get(terminalId);
  }

  /**
   * Resize the underlying PTY. No-op if the terminal isn't known to the pool.
   */
  resize(terminalId: string, cols: number, rows: number): void {
    const session = this.terminals.get(terminalId);
    if (session) {
      // Clamp client-supplied dims to a sane range — floor at 1 (node-pty
      // rejects zero/negative) and cap so an absurd request can't force a
      // huge mirror allocation. See MAX_COLS / MAX_ROWS.
      // `|| 1` also catches NaN / 0 (both coerce to the floor of 1).
      const safeCols = Math.min(Math.max(Math.trunc(cols) || 1, 1), MAX_COLS);
      const safeRows = Math.min(Math.max(Math.trunc(rows) || 1, 1), MAX_ROWS);
      session.pty.resize(safeCols, safeRows);
      // Keep the headless mirror on the same geometry so serialized replays
      // reconstruct the screen at the dims the client renders at.
      session.headless.resize(safeCols, safeRows);
    }
  }

  /**
   * Shrink-and-restore resize so a live full-screen TUI (claude-code, vim)
   * repaints after a client re-attach. Replaying the serialized snapshot
   * restores what the screen looked like, but the running app doesn't know
   * a new client is watching — two SIGWINCHes with a real dimension change
   * in between force a redraw. The 50 ms gap keeps the pair from
   * coalescing into a same-size no-op.
   *
   * Nudges ROWS, not cols: a column change forces a synchronous re-wrap of
   * the headless mirror's whole scrollback (O(buffer) — tens of ms at 10k
   * lines, and wake-from-sleep re-attaches every open terminal at once),
   * while a row change is O(1) and delivers the same SIGWINCH.
   *
   * Concurrent nudges for one terminal are deduped: two clients
   * re-attaching together (the same pair that shares a serialize drain)
   * would otherwise compound shrinks — A shrinks R→R-1, B shrinks
   * R-1→R-2, A's restore guard fails, B restores only to R-1 — leaving
   * the PTY one row short until a real client resize.
   */
  nudgeResize(terminalId: string): void {
    const session = this.terminals.get(terminalId);
    if (!session) return;
    if (this.nudging.has(terminalId)) return;
    const { cols, rows } = session.pty;
    if (rows <= 1) return;
    this.nudging.add(terminalId);
    this.resize(terminalId, cols, rows - 1);
    const timer = setTimeout(() => {
      this.nudging.delete(terminalId);
      const current = this.terminals.get(terminalId);
      // Restore only if the dims are still ours — a real client resize
      // landing in between carries the final dims and must win.
      if (current && current.pty.cols === cols && current.pty.rows === rows - 1) {
        this.resize(terminalId, cols, rows);
      }
    }, 50);
    timer.unref();
  }

  /**
   * List metadata for every PTY session bound to the given workspace.
   *
   * The returned `title` is the foreground process name reported by the
   * PTY; reading `pty.process` can throw if the process has already exited
   * between the reverse-index lookup and the read, so the read is wrapped.
   */
  list(workspaceId: string): TerminalListEntry[] {
    const ids = this.workspaceTerminals.get(workspaceId);
    if (!ids) return [];
    const result: TerminalListEntry[] = [];
    for (const terminalId of ids) {
      const entry = this.info(terminalId);
      if (entry) result.push(entry);
    }
    return result;
  }

  /** Number of live sessions. */
  get size(): number {
    return this.terminals.size;
  }

  /** Every live session across all workspaces. */
  listAll(): TerminalListEntry[] {
    const result: TerminalListEntry[] = [];
    for (const terminalId of this.terminals.keys()) {
      const entry = this.info(terminalId);
      if (entry) result.push(entry);
    }
    return result;
  }

  /** Metadata for one session, or `null` if it isn't live. */
  info(terminalId: string): TerminalListEntry | null {
    const session = this.terminals.get(terminalId);
    if (!session) return null;
    let title = "";
    try {
      title = session.pty.process;
    } catch {
      // pty.process can throw if the process has exited
    }
    return {
      terminalId,
      workspaceId: session.workspaceId,
      pid: session.pty.pid,
      scrollbackLength: session.scrollback.length,
      title,
      cleanupOnExit: session.cleanupOnExit,
    };
  }

  /**
   * Returns the scrollback buffer for a terminal, optionally limited to the
   * last N lines. Returns `null` if the terminal is not found.
   *
   * This is the plain-text read surface (`terminal.output` /
   * `band terminals output`). Replaying these raw bytes into a terminal
   * emulator is NOT sound — use {@link serialize} for that.
   */
  getScrollback(terminalId: string, lines?: number): string | null {
    const session = this.terminals.get(terminalId);
    if (!session) return null;
    const scrollback = session.scrollback.toString();
    if (lines == null) return scrollback;
    const allLines = scrollback.split("\n");
    return allLines.slice(-lines).join("\n");
  }

  /**
   * Serialize the terminal's current state (screen, scrollback, colors,
   * modes, alt buffer) into an escape-sequence stream that reconstructs it
   * when written into a fresh client terminal. Returns `null` if the
   * terminal is not found.
   *
   * This is the replay-on-reconnect payload. The raw `scrollback` buffer is
   * unsound for replay: it is tail-sliced at `MAX_SCROLLBACK_SIZE`, so it
   * can start mid-escape-sequence, and TUI apps that draw with relative
   * cursor motion (claude-code, vim) land their moves on the wrong rows —
   * a garbled screen after reload/reconnect. The headless mirror has parsed
   * the full stream, so serializing it always yields a clean, complete
   * repaint.
   *
   * Async because xterm parses writes on an internal queue. The PTY is
   * paused while the queue drains, so the snapshot covers exactly the
   * chunks already delivered to output listeners — a caller that sends the
   * snapshot and then subscribes to live output (before the microtask
   * chain yields to I/O) neither loses nor duplicates bytes.
   *
   * Concurrent calls for the same terminal (a `/terminal` WS reconnect
   * racing a `terminal.stream` attach, or two windows waking together)
   * share ONE in-flight drain — same pattern as `spawning`. Without the
   * dedupe, the first caller's `finally` would resume the PTY while the
   * second was still draining, letting fresh chunks flow before the second
   * caller's output forwarder exists: silent output loss.
   */
  serialize(terminalId: string): Promise<TerminalSnapshot | null> {
    const inflight = this.serializing.get(terminalId);
    if (inflight) return inflight;
    const promise = this.drainAndSerialize(terminalId).finally(() => {
      this.serializing.delete(terminalId);
    });
    this.serializing.set(terminalId, promise);
    return promise;
  }

  private async drainAndSerialize(terminalId: string): Promise<TerminalSnapshot | null> {
    const session = this.terminals.get(terminalId);
    if (!session) return null;
    // No output has ever been emitted — there is no state to snapshot, so
    // skip the pause/drain entirely. This matters beyond the wasted work:
    // pausing a JUST-SPAWNED PTY before its first read can wedge node-pty's
    // flow control under load (the shell's prompt then never reaches any
    // client). A chunk that lands right after this check is simply
    // delivered live by the caller's forwarder — not lost, not duplicated.
    if (session.scrollback.length === 0) return { data: "", seq: session.seq };
    this.holdOutput(terminalId);
    let deathWatch: NodeJS.Timeout | undefined;
    let drainCap: NodeJS.Timeout | undefined;
    try {
      // A zero-length write's callback fires only after everything queued
      // before it has been parsed. Two guards keep this promise from
      // hanging — an unsettled await would skip the `finally` and leave
      // the PTY PAUSED FOREVER (a silently dead terminal for every
      // client, which is strictly worse than any stale snapshot):
      //  - death watch: if the PTY exits mid-drain, `onExit` disposes the
      //    headless terminal and xterm drops queued callbacks without
      //    invoking them.
      //  - hard cap: the parse queue drains in single-digit ms; if the
      //    callback ever stalls (loaded event loop, write-buffer edge
      //    case), give up after 1 s and serialize whatever has parsed —
      //    late chunks are simply delivered live by the caller instead.
      await new Promise<void>((resolve) => {
        session.headless.write("", resolve);
        deathWatch = setInterval(() => {
          if (this.terminals.get(terminalId) !== session) resolve();
        }, 50);
        deathWatch.unref();
        drainCap = setTimeout(resolve, 1_000);
        drainCap.unref();
      });
      if (this.terminals.get(terminalId) !== session) return null;
      // The PTY is paused, so no chunk lands between reading `seq` and
      // serializing: the snapshot holds exactly chunks 1..seq (modulo the
      // drain cap above, whose late chunks the caller gets live).
      return { data: session.serializeAddon.serialize(), seq: session.seq };
    } finally {
      if (deathWatch) clearInterval(deathWatch);
      if (drainCap) clearTimeout(drainCap);
      // Skip the release if the session died mid-drain — the PTY is gone.
      if (this.terminals.get(terminalId) === session) this.releaseOutput(terminalId);
    }
  }

  /**
   * Stop reading the terminal's PTY until a matching {@link releaseOutput}.
   * The shell blocks once the kernel's PTY buffer fills, so a flood stops at
   * its source instead of piling up in memory. Holds nest.
   */
  holdOutput(terminalId: string): void {
    const session = this.terminals.get(terminalId);
    if (!session) return;
    session.holds += 1;
    if (session.holds === 1) session.pty.pause();
  }

  /** Undo one {@link holdOutput}; the PTY resumes when the last is released. */
  releaseOutput(terminalId: string): void {
    const session = this.terminals.get(terminalId);
    if (!session || session.holds === 0) return;
    session.holds -= 1;
    if (session.holds === 0) session.pty.resume();
  }

  /**
   * Writes data to a terminal's PTY stdin.
   * Returns false if the terminal is not found.
   */
  write(terminalId: string, data: string): boolean {
    const session = this.terminals.get(terminalId);
    if (!session) return false;
    session.pty.write(data);
    return true;
  }

  /**
   * Replay-on-attach in one step: resize to the client's dims (so the snapshot
   * reconstructs the grid at the width it will be rendered at), subscribe
   * `listener`, then serialize.
   *
   * The listener is subscribed BEFORE the snapshot, so it may receive chunks
   * that are already inside it. The caller drops every chunk whose `seq` is
   * at or below the returned snapshot's `seq`. That cut, rather than event
   * loop timing, is what keeps the replay free of gaps and duplicates, and it
   * is the only ordering guarantee that survives a socket hop to the daemon.
   *
   * Returns `null` (and subscribes nothing) when the terminal isn't live.
   */
  async attach(
    terminalId: string,
    dims: { cols: number; rows: number } | undefined,
    listener: TerminalOutputListener,
  ): Promise<{ snapshot: TerminalSnapshot; unsubscribe: () => void } | null> {
    if (!this.terminals.has(terminalId)) return null;
    if (dims) this.resize(terminalId, dims.cols, dims.rows);
    const unsubscribe = this.subscribeOutput(terminalId, listener);
    let snapshot: TerminalSnapshot | null;
    try {
      snapshot = await this.serialize(terminalId);
    } catch (err) {
      // Replay is best-effort: a serialize failure must not abandon the
      // attach, or the client would hold a socket that accepts keystrokes but
      // never shows output. An empty snapshot at seq 0 lets every chunk the
      // listener receives through.
      log.error("Failed to serialize terminal %s for replay: %s", terminalId, err);
      snapshot = { data: "", seq: 0 };
    }
    if (!snapshot) {
      unsubscribe();
      return null;
    }
    return { snapshot, unsubscribe };
  }

  /**
   * Subscribe to a pool-wide exit feed: one {@link TerminalExitEvent} per
   * session. Returns an unsubscribe function.
   */
  onExit(listener: (event: TerminalExitEvent) => void): () => void {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  /**
   * Subscribe to live output from a terminal's PTY.
   * Returns an unsubscribe function.
   */
  private subscribeOutput(terminalId: string, callback: TerminalOutputListener): () => void {
    let listeners = this.outputListeners.get(terminalId);
    if (!listeners) {
      listeners = new Set();
      this.outputListeners.set(terminalId, listeners);
    }
    listeners.add(callback);
    return () => {
      listeners.delete(callback);
      if (listeners.size === 0) {
        this.outputListeners.delete(terminalId);
      }
    };
  }

  /**
   * Kill a single terminal by terminalId.
   */
  kill(terminalId: string): void {
    const session = this.terminals.get(terminalId);
    if (session) {
      // `pty.kill()` triggers the `onExit` handler registered in `spawn`,
      // which is what unlinks `session.autoRunFile` — cleanup is delegated
      // there rather than duplicated in every kill path.
      session.pty.kill();
      this.terminals.delete(terminalId);
      const set = this.workspaceTerminals.get(session.workspaceId);
      if (set) {
        set.delete(terminalId);
        if (set.size === 0) {
          this.workspaceTerminals.delete(session.workspaceId);
        }
      }
    }
  }

  /**
   * Kill all terminals for a workspace.
   */
  killWorkspace(workspaceId: string): void {
    const ids = this.workspaceTerminals.get(workspaceId);
    if (!ids) return;
    for (const terminalId of ids) {
      const session = this.terminals.get(terminalId);
      if (session) {
        session.pty.kill();
        this.terminals.delete(terminalId);
      }
    }
    this.workspaceTerminals.delete(workspaceId);
  }

  /**
   * Kill every tracked PTY (server shutdown path).
   */
  killAll(): void {
    for (const [, session] of this.terminals) {
      session.pty.kill();
    }
    this.terminals.clear();
    this.workspaceTerminals.clear();
    // Output subscribers go with their sessions. Exit listeners stay: the
    // kills above still report their exits through them.
    this.outputListeners.clear();
  }
}
