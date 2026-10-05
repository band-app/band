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

import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const shellQuote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;

/** The `credential.helper` value that runs this worker's helper, as git's `!` shell form. */
export function helperCommand(nodePath: string, scriptPath: string): string {
  return `!${shellQuote(nodePath)} ${shellQuote(scriptPath)} ${GIT_CREDENTIAL_SUBCOMMAND}`;
}

/**
 * Adds the helper to the git configuration `env` carries (`GIT_CONFIG_COUNT`
 * and its keys). The empty `credential.helper` first resets the helpers the
 * machine configures, so the worker's own is the only one: git would otherwise
 * offer the token to `store` on a keychain or a file.
 */
export function gitCredentialEnv(
  env: NodeJS.ProcessEnv,
  helper: string,
  socketPath: string,
): NodeJS.ProcessEnv {
  const start = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10) || 0;
  const entries: [string, string][] = [
    ["credential.helper", ""],
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

/** Answers the helper processes on a Unix socket in a private temp directory. */
export class GitCredentialBroker {
  private server: Server | null = null;
  private dir: string | null = null;

  constructor(private readonly ctx: WorkerContext) {}

  /** Starts listening and returns the socket path. */
  async start(): Promise<string> {
    this.dir = await mkdtemp(join(tmpdir(), "band-gc-"));
    const path = join(this.dir, "s");
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
        resolve();
      });
    });
    this.server = server;
    return path;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (this.dir) await rm(this.dir, { recursive: true, force: true }).catch(() => undefined);
    this.dir = null;
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
