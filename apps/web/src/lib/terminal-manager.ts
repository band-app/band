import { existsSync } from "node:fs";
import { createLogger } from "@band/logger";
import pty from "node-pty";
import { shellPath } from "./process-utils";
import { resolveWorkspace } from "./workspace";

const log = createLogger("terminal");

const MAX_SCROLLBACK_SIZE = 100_000;

interface TerminalSession {
  pty: pty.IPty;
  scrollback: string;
}

const terminals = new Map<string, TerminalSession>();

/**
 * Returns an existing terminal session for the workspace, or spawns a new one.
 */
export async function getOrSpawnTerminal(workspaceId: string): Promise<TerminalSession> {
  const existing = terminals.get(workspaceId);
  if (existing) {
    return existing;
  }

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

  const cwd = workspace.worktree.path;
  if (!existsSync(cwd)) {
    throw new Error(`Workspace directory does not exist: ${cwd}`);
  }
  if (!existsSync(shell)) {
    throw new Error(`Shell not found: ${shell}`);
  }

  log.debug("Spawning shell %s in %s (PATH=%s)", shell, cwd, resolvedPath.slice(0, 200));

  let ptyProcess: pty.IPty;
  try {
    ptyProcess = pty.spawn(shell, [], {
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

  const session: TerminalSession = { pty: ptyProcess, scrollback: "" };
  terminals.set(workspaceId, session);

  // Buffer all PTY output for replay on reconnect
  ptyProcess.onData((data: string) => {
    session.scrollback += data;
    if (session.scrollback.length > MAX_SCROLLBACK_SIZE) {
      session.scrollback = session.scrollback.slice(-MAX_SCROLLBACK_SIZE);
    }
  });

  ptyProcess.onExit(() => {
    log.debug("Terminal exited for workspace %s", workspaceId);
    terminals.delete(workspaceId);
  });

  return session;
}

export function getTerminal(workspaceId: string): TerminalSession | undefined {
  return terminals.get(workspaceId);
}

export function resizeTerminal(workspaceId: string, cols: number, rows: number): void {
  const session = terminals.get(workspaceId);
  if (session) {
    session.pty.resize(cols, rows);
  }
}

export function killTerminal(workspaceId: string): void {
  const session = terminals.get(workspaceId);
  if (session) {
    session.pty.kill();
    terminals.delete(workspaceId);
  }
}

export function killAllTerminals(): void {
  for (const [, session] of terminals) {
    session.pty.kill();
  }
  terminals.clear();
}
