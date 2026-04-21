import { type ChildProcess, spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "@band-app/logger";
import { shellPath } from "./process-utils";
import { resolveWorkspace } from "./workspace";

/** Directory of this module — used to locate local node_modules/.bin */
const __dirname = dirname(fileURLToPath(import.meta.url));

const log = createLogger("lsp");

// ---------------------------------------------------------------------------
// Language server configuration — add new languages here
// ---------------------------------------------------------------------------
interface LangServerConfig {
  command: string;
  args: string[];
}

const LANG_SERVER_CONFIG: Record<string, LangServerConfig> = {
  typescript: { command: "typescript-language-server", args: ["--stdio"] },
};

// ---------------------------------------------------------------------------
// Session tracking (mirrors terminal-manager.ts dual-map pattern)
// ---------------------------------------------------------------------------
export interface LspServerSession {
  process: ChildProcess;
  workspaceId: string;
  lang: string;
}

/** serverId -> session (serverId = `${workspaceId}:${lang}`) */
const servers = new Map<string, LspServerSession>();

/** workspaceId -> Set<serverId> (reverse index for workspace-level cleanup) */
const workspaceServers = new Map<string, Set<string>>();

function toServerId(workspaceId: string, lang: string): string {
  return `${workspaceId}:${lang}`;
}

// ---------------------------------------------------------------------------
// Spawn / lookup
// ---------------------------------------------------------------------------

/**
 * Returns an existing language server session or spawns a new one.
 * The server process is ready for stdio communication but the LSP
 * initialize handshake is left to the client library (@codemirror/lsp-client).
 */
export async function getOrSpawnServer(
  workspaceId: string,
  lang: string,
): Promise<LspServerSession> {
  const serverId = toServerId(workspaceId, lang);

  const existing = servers.get(serverId);
  if (existing) return existing;

  const config = LANG_SERVER_CONFIG[lang];
  if (!config) {
    throw new Error(`No language server configured for: ${lang}`);
  }

  const workspace = resolveWorkspace(workspaceId);
  if (!workspace) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }

  const resolvedPath = await shellPath();
  const cwd = workspace.worktree.path;

  // Build PATH: app node_modules/.bin (where typescript-language-server
  // lives), workspace node_modules/.bin (where tsserver lives), then
  // the user's shell PATH for anything else (node, etc.).
  const appBin = resolve(__dirname, "../../node_modules/.bin");
  const workspaceBin = join(cwd, "node_modules/.bin");
  const pathSep = process.platform === "win32" ? ";" : ":";
  const combinedPath = [appBin, workspaceBin, resolvedPath].join(pathSep);

  log.debug("Spawning %s language server in %s for workspace %s", lang, cwd, workspaceId);

  const child = spawn(config.command, config.args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v != null)),
      PATH: combinedPath,
    },
  });

  const session: LspServerSession = { process: child, workspaceId, lang };

  function removeSession(): void {
    servers.delete(serverId);
    const set = workspaceServers.get(workspaceId);
    if (set) {
      set.delete(serverId);
      if (set.size === 0) {
        workspaceServers.delete(workspaceId);
      }
    }
  }

  servers.set(serverId, session);

  // Register in reverse index
  let ids = workspaceServers.get(workspaceId);
  if (!ids) {
    ids = new Set();
    workspaceServers.set(workspaceId, ids);
  }
  ids.add(serverId);

  // Auto-remove on exit
  child.on("exit", (code) => {
    log.debug("Language server exited: %s (code %s)", serverId, String(code));
    removeSession();
  });

  // Handle spawn errors (e.g. ENOENT when the command is not found).
  // Without this listener the error event crashes the host process.
  child.on("error", (err) => {
    log.error("Language server error: %s — %s", serverId, err.message);
    removeSession();
  });

  // Log stderr (language server diagnostics/errors)
  child.stderr?.on("data", (chunk: Buffer) => {
    log.debug("LSP stderr [%s]: %s", serverId, chunk.toString().trimEnd());
  });

  // Wait for the process to actually spawn so a synchronous failure (ENOENT)
  // rejects the promise instead of silently leaving a dead session.
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    // Use once + setImmediate so we don't double-fire with the persistent
    // error handler above — by the time reject runs, removeSession has
    // already been called by the persistent handler.
    child.once("error", (err) => reject(err));
  });

  return session;
}

/**
 * Returns an existing language server session by serverId, or undefined.
 */
export function getServer(serverId: string): LspServerSession | undefined {
  return servers.get(serverId);
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Kill all language servers for a workspace.
 */
export function killWorkspaceServers(workspaceId: string): void {
  const ids = workspaceServers.get(workspaceId);
  if (!ids) return;
  for (const serverId of ids) {
    const session = servers.get(serverId);
    if (session) {
      session.process.kill();
      servers.delete(serverId);
    }
  }
  workspaceServers.delete(workspaceId);
}

/**
 * Kill all language servers (server shutdown).
 */
export function killAllServers(): void {
  for (const [, session] of servers) {
    session.process.kill();
  }
  servers.clear();
  workspaceServers.clear();
}
