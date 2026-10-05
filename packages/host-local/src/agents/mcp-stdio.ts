/**
 * Starts stdio MCP servers for `LocalHost.mcp.openStdio` (plan step 4.4).
 *
 * The process runs in its own process group like an agent does, so `kill()`
 * also stops what the server started. The spec's env may hold vault secrets,
 * so nothing here logs or stores it, and stderr is read and dropped because a
 * server may echo what it was given.
 */

import { homedir } from "node:os";
import type { McpStdio, McpStdioSpec } from "@band-app/host-api";
import { spawnAgentProcess } from "./agent-spawn";

const DEFAULT_IDLE_MS = 15 * 60 * 1000;

/** How long a server may go with no bytes either way before it is killed. Read on every open. */
function idleMs(): number {
  const parsed = Number(process.env.BAND_MCP_STDIO_IDLE_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_IDLE_MS;
}

const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL|PRIVATE_?KEY)/i;

/** The host's own Band settings and secret-looking variables, blanked so the server does not inherit them. */
function blankedHostEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("BAND_") || SECRET_NAME.test(name)) out[name] = "";
  }
  return out;
}

export async function openMcpStdio(spec: McpStdioSpec): Promise<McpStdio> {
  const proc = await spawnAgentProcess(
    { command: spec.command, args: spec.args, env: { ...blankedHostEnv(), ...spec.env } },
    spec.cwd ?? homedir(),
  );
  void (async () => {
    try {
      for await (const _chunk of proc.stderr) {
        // dropped on purpose
      }
    } catch {
      // the process went away
    }
  })();

  let exited = false;
  void proc.exit.then(() => {
    exited = true;
  });
  // SIGTERM first, then SIGKILL for a server that ignores it, so closing a session always ends the process.
  const kill = () => {
    proc.kill();
    setTimeout(() => {
      if (!exited) proc.kill("SIGKILL");
    }, 3_000).unref();
  };

  const limit = idleMs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const touch = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(kill, limit);
    timer.unref();
  };
  touch();
  void proc.exit.then(() => {
    if (timer) clearTimeout(timer);
  });

  return {
    pid: proc.pid,
    stdin: {
      write: (chunk) => {
        touch();
        proc.stdin.write(chunk);
      },
      end: () => proc.stdin.end(),
    },
    stdout: (async function* () {
      for await (const chunk of proc.stdout) {
        touch();
        yield chunk;
      }
    })(),
    kill,
  };
}
