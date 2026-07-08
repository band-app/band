import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { createLogger } from "@band-app/logger";
import type { IPty } from "node-pty";
import { defaultShell, shellPath } from "../process/path";

const log = createLogger("terminal-pool");

const MAX_SCROLLBACK_SIZE = 100_000;

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
 * One live PTY session tracked by the pool.
 *
 * The pool owns the `IPty` handle, the buffered scrollback, and the
 * `workspaceId` reverse-lookup so the service tier never has to touch
 * `node-pty` directly. `scrollback` is a single growing string capped at
 * `MAX_SCROLLBACK_SIZE` (~100 KB) — see `onData` below for the bounded
 * write.
 */
export interface TerminalSession {
  pty: IPty;
  scrollback: string;
  workspaceId: string;
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
}

/**
 * Stateful in-memory registry of PTY sessions.
 *
 * Infra tier — manages an external resource (forked shell processes) and
 * exposes a typed CRUD-shaped API to the service tier. The class is
 * deliberately small and dependency-free aside from `node-pty` and the
 * `shellPath` helper; all business logic (workspace resolution, layout
 * persistence, event emission) lives in `TerminalService`.
 *
 * Singleton — see `terminalPool` at the bottom of this file. PTY sessions
 * live for the lifetime of the server process and are not partitioned per
 * tenant, so a module-level instance is the natural shape.
 */
export class TerminalPool {
  /** terminalId -> session */
  private readonly terminals = new Map<string, TerminalSession>();

  /** workspaceId -> Set<terminalId> (reverse index for workspace-level cleanup) */
  private readonly workspaceTerminals = new Map<string, Set<string>>();

  /** terminalId -> Set<listener> for live output streaming */
  private readonly outputListeners = new Map<string, Set<(data: string) => void>>();

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
    onExit?: () => void,
  ): Promise<TerminalSession> {
    const existing = this.terminals.get(terminalId);
    if (existing) return existing;
    const inflight = this.spawning.get(terminalId);
    if (inflight) return inflight;
    // Store the promise synchronously (before any await) so a concurrent call
    // that arrives while this one is awaiting sees it and reuses it.
    const promise = this.spawnNew(workspaceId, terminalId, workspaceRoot, options, onExit);
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
    onExit?: () => void,
  ): Promise<TerminalSession> {
    const shell = defaultShell();
    const resolvedPath = await shellPath();

    // Filter env to only string values — posix_spawnp fails on undefined/null
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
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

    const session: TerminalSession = { pty: ptyProcess, scrollback: "", workspaceId };
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

    // Buffer all PTY output for replay on reconnect + notify listeners
    ptyProcess.onData((data: string) => {
      session.scrollback += data;
      if (session.scrollback.length > MAX_SCROLLBACK_SIZE) {
        session.scrollback = session.scrollback.slice(-MAX_SCROLLBACK_SIZE);
      }
      const listeners = this.outputListeners.get(terminalId);
      if (listeners) {
        for (const cb of listeners) {
          try {
            cb(data);
          } catch {
            // listener errors must not crash the PTY data handler
          }
        }
      }
    });

    ptyProcess.onExit(() => {
      log.debug("Terminal exited: %s (workspace %s)", terminalId, workspaceId);
      // Distinguish a natural exit from an explicit `kill()`: `kill()` removes
      // the session from `terminals` synchronously before `pty.kill()`'s async
      // `onExit` lands here, so a missing entry means the caller already tore
      // this terminal down. Captured before this handler's own delete below.
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
      // Notify the caller that the PTY exited on its OWN (e.g. a self-closing
      // cron pane whose command ended with `exit`). The pool stays oblivious to
      // layout / event concerns; the service-supplied callback does that
      // cleanup. Skipped on an explicit `kill()` — that path already runs the
      // same teardown synchronously, so firing here too would double-emit
      // `terminal-killed`. Guarded so a throwing callback can't wedge the exit
      // handler.
      if (onExit && !explicitlyKilled) {
        try {
          onExit();
        } catch (err) {
          log.warn("onExit callback threw for terminal %s: %s", terminalId, err);
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
      session.pty.resize(cols, rows);
    }
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
      const session = this.terminals.get(terminalId);
      if (session) {
        let title = "";
        try {
          title = session.pty.process;
        } catch {
          // pty.process can throw if the process has exited
        }
        result.push({
          terminalId,
          workspaceId,
          pid: session.pty.pid,
          scrollbackLength: session.scrollback.length,
          title,
        });
      }
    }
    return result;
  }

  /**
   * Returns the scrollback buffer for a terminal, optionally limited to the
   * last N lines. Returns `null` if the terminal is not found.
   */
  getScrollback(terminalId: string, lines?: number): string | null {
    const session = this.terminals.get(terminalId);
    if (!session) return null;
    if (lines == null) return session.scrollback;
    const allLines = session.scrollback.split("\n");
    return allLines.slice(-lines).join("\n");
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
   * Subscribe to live output from a terminal's PTY.
   * Returns an unsubscribe function.
   */
  subscribeOutput(terminalId: string, callback: (data: string) => void): () => void {
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
  }
}

/**
 * Process-wide singleton used by the service tier and the WebSocket entry
 * point. PTY processes outlive any single request so a single shared
 * instance is the correct shape — analogous to `agentPool` and the eventual
 * `lspPool`.
 */
export const terminalPool = new TerminalPool();
