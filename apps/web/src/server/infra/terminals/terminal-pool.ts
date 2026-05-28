import { existsSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "@band-app/logger";
import type { IPty } from "node-pty";
import { shellPath } from "../../../lib/process-utils";

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
   * Spawn a new PTY for the given workspace + terminalId.
   *
   * `workspaceRoot` is the absolute path to the worktree on disk; resolving
   * the workspaceId to a path is the service tier's job so that the pool
   * stays oblivious to the workspace registry.
   */
  async spawn(
    workspaceId: string,
    terminalId: string,
    workspaceRoot: string,
    options?: SpawnOptions,
  ): Promise<TerminalSession> {
    const shell = process.env.SHELL || "/bin/zsh";
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

    // Resolve cwd: options.cwd is relative to workspace root
    let cwd = workspaceRoot;
    if (options?.cwd) {
      const resolved = join(workspaceRoot, options.cwd);
      // Security: ensure the resolved path stays within the workspace
      if (!resolved.startsWith(workspaceRoot)) {
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

    // Auto-run initial command if provided
    if (options?.command) {
      ptyProcess.write(`${options.command}\n`);
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
      this.terminals.delete(terminalId);
      this.outputListeners.delete(terminalId);
      const set = this.workspaceTerminals.get(workspaceId);
      if (set) {
        set.delete(terminalId);
        if (set.size === 0) {
          this.workspaceTerminals.delete(workspaceId);
        }
      }
    });

    return session;
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
