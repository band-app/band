import { existsSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "@band-app/logger";
import type { IPty } from "node-pty";
import { shellPath } from "./process-utils";
import { resolveWorkspace } from "./workspace";

const log = createLogger("terminal");

const MAX_SCROLLBACK_SIZE = 100_000;

export interface SpawnOptions {
  /** Shell command to auto-run after the PTY spawns. */
  command?: string;
  /** Working directory, resolved relative to the workspace root. */
  cwd?: string;
  /** Extra environment variables merged into the base env. */
  env?: Record<string, string>;
}

export interface TerminalSession {
  pty: IPty;
  scrollback: string;
  workspaceId: string;
}

/** terminalId -> session */
const terminals = new Map<string, TerminalSession>();

/** workspaceId -> Set<terminalId> (reverse index for workspace-level cleanup) */
const workspaceTerminals = new Map<string, Set<string>>();

/** terminalId -> Set<listener> for live output streaming */
const outputListeners = new Map<string, Set<(data: string) => void>>();

/**
 * Spawns a new terminal session for the given workspace and terminalId.
 * Always creates a new PTY (each split pane gets its own shell).
 *
 * When `options` is provided, the PTY can use a custom working directory,
 * extra environment variables, and an initial command written to stdin.
 */
export async function spawnTerminal(
  workspaceId: string,
  terminalId: string,
  options?: SpawnOptions,
): Promise<TerminalSession> {
  const workspace = resolveWorkspace(workspaceId);
  if (!workspace) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }

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
  const workspaceRoot = workspace.worktree.path;
  let cwd = workspaceRoot;
  if (options?.cwd) {
    const resolved = join(workspaceRoot, options.cwd);
    // Security: ensure the resolved path stays within the workspace
    if (!resolved.startsWith(workspaceRoot)) {
      log.warn("Ignoring cwd %s — resolves outside workspace root %s", options.cwd, workspaceRoot);
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

  const nodePty = (await import("node-pty")).default;
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
  terminals.set(terminalId, session);

  // Auto-run initial command if provided
  if (options?.command) {
    ptyProcess.write(`${options.command}\n`);
  }

  // Register in reverse index
  let ids = workspaceTerminals.get(workspaceId);
  if (!ids) {
    ids = new Set();
    workspaceTerminals.set(workspaceId, ids);
  }
  ids.add(terminalId);

  // Buffer all PTY output for replay on reconnect + notify listeners
  ptyProcess.onData((data: string) => {
    session.scrollback += data;
    if (session.scrollback.length > MAX_SCROLLBACK_SIZE) {
      session.scrollback = session.scrollback.slice(-MAX_SCROLLBACK_SIZE);
    }
    const listeners = outputListeners.get(terminalId);
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
    terminals.delete(terminalId);
    outputListeners.delete(terminalId);
    const set = workspaceTerminals.get(workspaceId);
    if (set) {
      set.delete(terminalId);
      if (set.size === 0) {
        workspaceTerminals.delete(workspaceId);
      }
    }
  });

  return session;
}

/**
 * Returns an existing terminal session by terminalId, or undefined.
 */
export function getTerminalSession(terminalId: string): TerminalSession | undefined {
  return terminals.get(terminalId);
}

export function resizeTerminal(terminalId: string, cols: number, rows: number): void {
  const session = terminals.get(terminalId);
  if (session) {
    session.pty.resize(cols, rows);
  }
}

/**
 * List all terminal sessions for a workspace.
 */
export function listTerminals(
  workspaceId: string,
): Array<{ terminalId: string; workspaceId: string; pid: number; scrollbackLength: number; title: string }> {
  const ids = workspaceTerminals.get(workspaceId);
  if (!ids) return [];
  const result: Array<{ terminalId: string; workspaceId: string; pid: number; scrollbackLength: number; title: string }> = [];
  for (const terminalId of ids) {
    const session = terminals.get(terminalId);
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
 * Returns the scrollback buffer for a terminal, optionally limited to the last N lines.
 * Returns null if the terminal is not found.
 */
export function getScrollback(terminalId: string, lines?: number): string | null {
  const session = terminals.get(terminalId);
  if (!session) return null;
  if (lines == null) return session.scrollback;
  const allLines = session.scrollback.split("\n");
  return allLines.slice(-lines).join("\n");
}

/**
 * Writes data to a terminal's PTY stdin.
 * Returns false if the terminal is not found.
 */
export function writeToTerminal(terminalId: string, data: string): boolean {
  const session = terminals.get(terminalId);
  if (!session) return false;
  session.pty.write(data);
  return true;
}

/**
 * Subscribe to live output from a terminal's PTY.
 * Returns an unsubscribe function.
 */
export function subscribeTerminalOutput(
  terminalId: string,
  callback: (data: string) => void,
): () => void {
  let listeners = outputListeners.get(terminalId);
  if (!listeners) {
    listeners = new Set();
    outputListeners.set(terminalId, listeners);
  }
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
    if (listeners.size === 0) {
      outputListeners.delete(terminalId);
    }
  };
}

/**
 * Kill a single terminal by terminalId.
 */
export function killTerminal(terminalId: string): void {
  const session = terminals.get(terminalId);
  if (session) {
    session.pty.kill();
    terminals.delete(terminalId);
    const set = workspaceTerminals.get(session.workspaceId);
    if (set) {
      set.delete(terminalId);
      if (set.size === 0) {
        workspaceTerminals.delete(session.workspaceId);
      }
    }
  }
}

/**
 * Kill all terminals for a workspace.
 */
export function killWorkspaceTerminals(workspaceId: string): void {
  const ids = workspaceTerminals.get(workspaceId);
  if (!ids) return;
  for (const terminalId of ids) {
    const session = terminals.get(terminalId);
    if (session) {
      session.pty.kill();
      terminals.delete(terminalId);
    }
  }
  workspaceTerminals.delete(workspaceId);
}

export function killAllTerminals(): void {
  for (const [, session] of terminals) {
    session.pty.kill();
  }
  terminals.clear();
  workspaceTerminals.clear();
}
