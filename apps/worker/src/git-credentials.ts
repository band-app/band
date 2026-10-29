/**
 * Git credentials for the processes the worker starts (plan step 4.1).
 *
 * Git runs `band-worker git-credential get` as a credential helper. The helper
 * is a short process that talks to the worker over a Unix socket, and the
 * worker asks the hub over its link (`git.credential`). The hub answers only
 * for a remote of a repository placed on this worker, so nothing is stored
 * here: the token goes from the hub through the worker's memory to the helper's
 * stdout, then to git. The environment the worker hands to agents and
 * terminals holds the helper command and the socket path, never a token.
 */

import { createHash } from "node:crypto";
import { chmodSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { join } from "node:path";
import { ensurePrivateDir } from "@band-app/host-local/terminals/daemon/endpoint";
import { shortSocketDir } from "@band-app/host-local/terminals/daemon/protocol";
import {
  type GitCredentialParams,
  type GitCredentialReply,
  METHOD_GIT_CREDENTIAL,
} from "@band-app/link";
import type { WorkerContext } from "./context.ts";

export const GIT_CREDENTIAL_SOCKET_ENV = "BAND_GIT_CREDENTIAL_SOCK";
export const GIT_CREDENTIAL_SUBCOMMAND = "git-credential";

/** How long the hub may take to answer a credential request. */
const HUB_ANSWER_MS = 30_000;
const MAX_REQUEST_BYTES = 8 * 1024;

/** The longest Unix socket path that fits `sun_path` on macOS (104 bytes with the NUL). */
const MAX_SOCKET_PATH_BYTES = 103;

const shellQuote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;

/** The `credential.helper` value that runs this worker's helper, as git's `!` shell form. */
export function helperCommand(nodePath: string, scriptPath: string): string {
  return `!${shellQuote(nodePath)} ${shellQuote(scriptPath)} ${GIT_CREDENTIAL_SUBCOMMAND}`;
}

/**
 * Adds the helper to the git configuration `env` carries (`GIT_CONFIG_COUNT`
 * and its keys). With `resetHelpers`, an empty `credential.helper` first resets
 * the helpers the machine configures, so the worker's own is the only one: git
 * would otherwise offer the token to `store` on a keychain or a file. Without
 * it the machine's helpers run first and the worker's helper is the fallback.
 */
export function gitCredentialEnv(
  env: NodeJS.ProcessEnv,
  helper: string,
  socketPath: string,
  options: { resetHelpers: boolean },
): NodeJS.ProcessEnv {
  const start = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10) || 0;
  const entries: [string, string][] = [
    ...(options.resetHelpers ? [["credential.helper", ""] as [string, string]] : []),
    ["credential.helper", helper],
    ["credential.useHttpPath", "true"],
  ];
  const out: NodeJS.ProcessEnv = { ...env, GIT_CONFIG_COUNT: String(start + entries.length) };
  entries.forEach(([key, value], i) => {
    out[`GIT_CONFIG_KEY_${start + i}`] = key;
    out[`GIT_CONFIG_VALUE_${start + i}`] = value;
  });
  out[GIT_CREDENTIAL_SOCKET_ENV] = socketPath;
  out.GIT_TERMINAL_PROMPT ??= "0";
  return out;
}

/**
 * Where the broker's socket lives for a state dir. The path depends only on the
 * state dir, so a restarted worker listens where the agents and terminals it
 * started before still look (their environment holds this path). A state dir
 * whose path is too long for a Unix socket gets a hashed name under
 * `/tmp/band-<uid>/`.
 */
export function gitCredentialSocketPath(stateDir: string): string {
  const inRunDir = join(stateDir, "run", "git-credential.sock");
  if (Buffer.byteLength(inRunDir) <= MAX_SOCKET_PATH_BYTES) return inRunDir;
  const hash = createHash("sha256").update(stateDir).digest("hex").slice(0, 16);
  return join(shortSocketDir(), `gc-${hash}.sock`);
}

/**
 * Answers the helper processes on a Unix socket at a path that stays the same
 * across worker restarts, in a 0700 directory, the socket mode 0600.
 */
export class GitCredentialBroker {
  private server: Server | null = null;
  private path: string | null = null;

  constructor(private readonly ctx: WorkerContext) {}

  /** Starts listening and returns the socket path. */
  async start(): Promise<string> {
    const path = gitCredentialSocketPath(this.ctx.stateDir);
    ensurePrivateDir(join(path, ".."));
    // A previous worker's socket file is dead (this worker is the only one on the state dir).
    rmSync(path, { force: true });
    const server = createServer((socket) => {
      let data = "";
      socket.setEncoding("utf8");
      socket.on("error", () => socket.destroy());
      socket.setTimeout(HUB_ANSWER_MS, () => socket.destroy());
      socket.on("data", (chunk: string) => {
        data += chunk;
        if (data.length > MAX_REQUEST_BYTES) return void socket.destroy();
        if (!data.includes("\n")) return;
        socket.removeAllListeners("data");
        void this.answer(data.slice(0, data.indexOf("\n"))).then((reply) => socket.end(reply));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => {
        server.off("error", reject);
        chmodSync(path, 0o600);
        resolve();
      });
    });
    this.server = server;
    this.path = path;
    return path;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    // `close()` unlinks the socket. The next start recreates it at the same path.
    if (this.path) rmSync(this.path, { force: true });
    this.path = null;
  }

  private async answer(line: string): Promise<string> {
    const release = this.ctx.activity.hold();
    try {
      const params = JSON.parse(line) as GitCredentialParams;
      const reply = await this.ctx.session.request<GitCredentialReply>(
        METHOD_GIT_CREDENTIAL,
        { protocol: params.protocol, host: params.host, path: params.path },
        { timeoutMs: HUB_ANSWER_MS },
      );
      return `${JSON.stringify(reply)}\n`;
    } catch (err) {
      // The message only: it never holds a credential, and the hub's refusal reason is useful.
      return `${JSON.stringify({ error: err instanceof Error ? err.message : "failed" })}\n`;
    } finally {
      release();
    }
  }
}

/** Reads the `key=value` lines git sends a helper, up to the blank line. */
function parseAttributes(text: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (line === "") break;
    const eq = line.indexOf("=");
    if (eq > 0) attrs[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return attrs;
}

async function readStdin(): Promise<string> {
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

function ask(socketPath: string, request: GitCredentialParams): Promise<GitCredentialReply> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let data = "";
    socket.setEncoding("utf8");
    socket.setTimeout(HUB_ANSWER_MS + 5_000, () => socket.destroy(new Error("timed out")));
    socket.on("data", (chunk: string) => {
      data += chunk;
    });
    socket.on("error", reject);
    socket.on("end", () => {
      try {
        const reply = JSON.parse(data) as GitCredentialReply & { error?: string };
        if (reply.error) reject(new Error(reply.error));
        else resolve(reply);
      } catch {
        reject(new Error("unreadable answer"));
      }
    });
    socket.write(`${JSON.stringify(request)}\n`);
  });
}

/**
 * `band-worker git-credential <get|store|erase>`, run by git. `store` and
 * `erase` do nothing, because nothing is kept here. `get` prints the
 * credential, or nothing when the hub has none, so git fails the way it would
 * with no helper. Returns the exit code.
 */
export async function runGitCredentialHelper(operation: string | undefined): Promise<number> {
  if (operation !== "get") {
    // Git writes the credential to `store` on a successful use and to `erase` on a rejected one.
    if (operation === "store" || operation === "erase") await readStdin();
    return 0;
  }
  const socketPath = process.env[GIT_CREDENTIAL_SOCKET_ENV];
  const attrs = parseAttributes(await readStdin());
  if (!socketPath || !attrs.host || !attrs.protocol) return 0;
  try {
    const reply = await ask(socketPath, {
      protocol: attrs.protocol,
      host: attrs.host,
      path: attrs.path ?? "",
    });
    if (reply.found) {
      process.stdout.write(`username=${reply.username}\npassword=${reply.password}\n`);
    }
  } catch (err) {
    process.stderr.write(
      `band-worker: no git credential for ${attrs.host}: ${err instanceof Error ? err.message : "failed"}\n`,
    );
  }
  return 0;
}
