import { type ChildProcess, spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Duplex } from "@band-app/host-api";
import { createLogger } from "@band-app/logger";
import { shellPath } from "../process/path";

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
interface LspServerSession {
  process: ChildProcess;
  /** Output queues of the open connections. Each receives every stdout chunk. */
  subscribers: Set<OutputQueue>;
}

/** Single-consumer queue (one concurrent iterator) behind a connection's `output` stream. */
class OutputQueue implements AsyncIterable<Uint8Array> {
  private readonly chunks: Uint8Array[] = [];
  private wake: (() => void) | null = null;
  private ended = false;

  push(chunk: Uint8Array): void {
    if (this.ended) return;
    this.chunks.push(chunk);
    this.wake?.();
  }

  /** Ends the stream and drops chunks nobody will read. */
  discard(): void {
    this.chunks.length = 0;
    this.end();
  }

  end(): void {
    this.ended = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
    for (;;) {
      const chunk = this.chunks.shift();
      if (chunk) {
        yield chunk;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = null;
    }
  }
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
 * Returns an existing language server session or spawns a new one in `root`.
 * The server process is ready for stdio communication but the LSP
 * initialize handshake is left to the client library (@codemirror/lsp-client).
 */
async function getOrSpawnServer(
  workspaceId: string,
  lang: string,
  root: string,
): Promise<LspServerSession> {
  const serverId = toServerId(workspaceId, lang);

  const existing = servers.get(serverId);
  if (existing) return existing;

  const config = Object.hasOwn(LANG_SERVER_CONFIG, lang) ? LANG_SERVER_CONFIG[lang] : undefined;
  if (!config) {
    throw new Error(`No language server configured for: ${lang}`);
  }

  const resolvedPath = await shellPath();
  const cwd = root;

  // Build PATH: app node_modules/.bin (where typescript-language-server
  // lives), workspace node_modules/.bin (where tsserver lives), then
  // the user's shell PATH for anything else (node, etc.).
  //
  // In development, __dirname is packages/host-local/src/lsp/ so we walk up
  // two levels to reach packages/host-local/, then into node_modules/.bin
  // (the package depends on typescript-language-server). In the bundled DMG,
  // __dirname is dist/ so we need ./node_modules/.bin instead. Use both so
  // it works in either environment, and in the worker package.
  const appBin = resolve(__dirname, "../../node_modules/.bin");
  const bundledBin = resolve(__dirname, "node_modules/.bin");
  // The worker bundle is `<package>/dist/band-worker.mjs`. Its dependencies
  // install in `<package>/node_modules`, or beside the package when hoisted.
  const workerBin = resolve(__dirname, "../node_modules/.bin");
  const hoistedBin = resolve(__dirname, "../../../.bin");
  const workspaceBin = join(cwd, "node_modules/.bin");
  const pathSep = process.platform === "win32" ? ";" : ":";
  const combinedPath = [bundledBin, appBin, workerBin, hoistedBin, workspaceBin, resolvedPath].join(
    pathSep,
  );

  log.debug("Spawning %s language server in %s for workspace %s", lang, cwd, workspaceId);

  const child = spawn(config.command, config.args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v != null)),
      PATH: combinedPath,
    },
  });

  const session: LspServerSession = { process: child, subscribers: new Set() };

  function removeSession(): void {
    // A replacement may already hold the id after a kill and respawn.
    const current = servers.get(serverId);
    if (current && current !== session) return;
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

  // Server stdout fans out to every connection
  child.stdout?.on("data", (chunk: Buffer) => {
    for (const subscriber of session.subscribers) subscriber.push(chunk);
  });

  // Auto-remove on exit, and end every connection's output
  child.on("exit", (code) => {
    log.debug("Language server exited: %s (code %s)", serverId, String(code));
    removeSession();
    for (const subscriber of session.subscribers) subscriber.end();
    session.subscribers.clear();
  });

  // Handle spawn errors (e.g. ENOENT when the command is not found).
  // Without this listener the error event crashes the host process.
  child.on("error", (err) => {
    log.error("Language server error: %s — %s", serverId, err.message);
    removeSession();
    // An error after spawn (a broken stdin pipe) need not be followed by `exit`.
    for (const subscriber of session.subscribers) subscriber.end();
    session.subscribers.clear();
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
 * Opens a connection to the workspace's language server for `lang`, starting
 * the server first if it isn't running.
 */
export async function connectLspServer(spec: {
  workspaceId: string;
  lang: string;
  root: string;
}): Promise<Duplex> {
  const session = await getOrSpawnServer(spec.workspaceId, spec.lang, spec.root);
  const { process: child, subscribers } = session;
  if (!child.stdin || !child.stdout) {
    throw new Error("Language server stdio not available");
  }
  const output = new OutputQueue();
  let closed = false;
  // The server may have exited between spawn and now.
  if (child.exitCode !== null || child.signalCode !== null) output.end();
  else subscribers.add(output);

  return {
    write(chunk) {
      if (closed || !child.stdin?.writable) return;
      child.stdin.write(chunk);
    },
    output,
    close() {
      closed = true;
      subscribers.delete(output);
      output.discard();
    },
  };
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
