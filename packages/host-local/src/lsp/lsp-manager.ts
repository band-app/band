import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Duplex } from "@band-app/host-api";
import { createLogger } from "@band-app/logger";
import { shellPath } from "../process/path";

const log = createLogger("lsp");

// ---------------------------------------------------------------------------
// Language server registry. Servers come from installed extensions: the worker
// builds the list from their manifests (`contributes.languageServers`) and the
// host reads it on every connection.
// ---------------------------------------------------------------------------

/** One language server an extension contributes, resolved against its unpacked folder. */
export interface LanguageServerSpec {
  /** `<extension id>/<server id>`. The `lang` of a connection. */
  key: string;
  /** The extension's unpacked folder. */
  dir: string;
  command: string;
  args: string[];
  rootMarkers: string[];
  /** Why the server cannot run on this worker, such as `needs node`. Absent when it can. */
  unavailable?: string;
}

/** Where the manager looks a server up. */
export type LanguageServerLookup = () => readonly LanguageServerSpec[];

/** The command and arguments that start a server: its script under the worker's node, or a binary on the PATH. */
export function launchCommand(spec: LanguageServerSpec): {
  command: string;
  args: string[];
  electron: boolean;
} {
  if (/\.(?:m?js|cjs)$/.test(spec.command)) {
    return {
      command: process.execPath,
      args: [join(spec.dir, spec.command), ...spec.args],
      // Band itself runs as plain Node only with this variable.
      electron: process.versions.electron !== undefined,
    };
  }
  return { command: spec.command, args: spec.args, electron: false };
}

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

/** serverId -> session (serverId = `${worktreeId}:${lang}`) */
const servers = new Map<string, LspServerSession>();

/** worktreeId -> Set<serverId> (reverse index for worktree-level cleanup) */
const worktreeServers = new Map<string, Set<string>>();

function toServerId(worktreeId: string, lang: string): string {
  return `${worktreeId}:${lang}`;
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
  lookup: LanguageServerLookup,
  worktreeId: string,
  lang: string,
  root: string,
): Promise<LspServerSession> {
  const serverId = toServerId(worktreeId, lang);

  const existing = servers.get(serverId);
  if (existing) return existing;

  const spec = lookup().find((candidate) => candidate.key === lang);
  if (!spec) {
    throw new Error(`No language server configured for: ${lang}`);
  }
  if (spec.unavailable) {
    throw new Error(`The ${lang} language server is not available here: ${spec.unavailable}`);
  }
  if (spec.rootMarkers.length > 0 && !spec.rootMarkers.some((m) => existsSync(join(root, m)))) {
    throw new Error(
      `No project for ${lang}: the worktree has none of ${spec.rootMarkers.join(", ")}`,
    );
  }

  const resolvedPath = await shellPath();
  const cwd = root;
  // The worktree's own node_modules/.bin first (a project's tools), then the shell PATH.
  const pathSep = process.platform === "win32" ? ";" : ":";
  const combinedPath = [join(cwd, "node_modules/.bin"), resolvedPath].join(pathSep);
  const launch = launchCommand(spec);

  log.debug("Spawning %s language server in %s for worktree %s", lang, cwd, worktreeId);

  const child = spawn(launch.command, launch.args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v != null)),
      PATH: combinedPath,
      ...(launch.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    } as unknown as NodeJS.ProcessEnv,
  });

  const session: LspServerSession = { process: child, subscribers: new Set() };

  function removeSession(): void {
    // A replacement may already hold the id after a kill and respawn.
    const current = servers.get(serverId);
    if (current && current !== session) return;
    servers.delete(serverId);
    const set = worktreeServers.get(worktreeId);
    if (set) {
      set.delete(serverId);
      if (set.size === 0) {
        worktreeServers.delete(worktreeId);
      }
    }
  }

  servers.set(serverId, session);

  // Register in reverse index
  let ids = worktreeServers.get(worktreeId);
  if (!ids) {
    ids = new Set();
    worktreeServers.set(worktreeId, ids);
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
 * Opens a connection to the worktree's language server for `lang`, starting
 * the server first if it isn't running.
 */
export async function connectLspServer(
  lookup: LanguageServerLookup,
  spec: {
    worktreeId: string;
    lang: string;
    root: string;
  },
): Promise<Duplex> {
  const session = await getOrSpawnServer(lookup, spec.worktreeId, spec.lang, spec.root);
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
 * Kill all language servers for a worktree.
 */
export function killWorktreeServers(worktreeId: string): void {
  const ids = worktreeServers.get(worktreeId);
  if (!ids) return;
  for (const serverId of ids) {
    const session = servers.get(serverId);
    if (session) {
      session.process.kill();
      servers.delete(serverId);
    }
  }
  worktreeServers.delete(worktreeId);
}

/**
 * Kill all language servers (server shutdown).
 */
export function killAllServers(): void {
  for (const [, session] of servers) {
    session.process.kill();
  }
  servers.clear();
  worktreeServers.clear();
}
