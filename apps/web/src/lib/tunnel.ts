import { type ChildProcess, spawn } from "node:child_process";
import { createLogger } from "@band-app/logger";
import { getToken } from "./auth-token";
import { shellPath } from "./process-utils";
import { emit } from "./watcher";

const log = createLogger("tunnel");

let tunnelProcess: ChildProcess | null = null;
let tunnelUrl: string | null = null;
let startInProgress: Promise<void> | null = null;

/**
 * Extract a trycloudflare.com URL from cloudflared output.
 * cloudflared prints the tunnel URL to stderr in a line like:
 *   ... | https://some-random-words.trycloudflare.com
 * or sometimes with INF prefix:
 *   INF +-------------------------------------------+
 *   INF |  https://xxx.trycloudflare.com            |
 *   INF +-------------------------------------------+
 */
export function extractUrl(text: string): string | null {
  const match = text.match(/https:\/\/[^\s|]+\.trycloudflare\.com/);
  return match ? match[0] : null;
}

function appendToken(baseUrl: string, token: string): string {
  const sep = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${sep}token=${token}`;
}

function spawnTunnel(options: { port: number }, resolvedPath: string): Promise<void> {
  const args = ["tunnel", "--config", "/dev/null", "--url", `http://localhost:${options.port}`];

  log.debug("spawning cloudflared %s", args.join(" "));

  return new Promise((resolve, reject) => {
    const child = spawn("cloudflared", args, {
      env: { ...process.env, PATH: resolvedPath },
      stdio: ["ignore", "pipe", "pipe"],
    });

    tunnelProcess = child;
    let settled = false;
    const stderrChunks: string[] = [];

    const handleOutput = (data: Buffer) => {
      const text = data.toString();
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        log.debug("output: %s", trimmed);

        const url = extractUrl(trimmed);
        if (url) {
          const token = getToken();
          tunnelUrl = appendToken(url, token);

          log.debug("detected URL: %s", tunnelUrl);
          emit({ kind: "tunnel-url", url: tunnelUrl });

          if (!settled) {
            settled = true;
            resolve();
          }
        }
      }
    };

    child.stdout?.on("data", handleOutput);
    child.stderr?.on("data", (data: Buffer) => {
      stderrChunks.push(data.toString());
      handleOutput(data);
    });

    child.on("error", (err) => {
      log.debug("process error: %s", err.message);
      tunnelProcess = null;
      tunnelUrl = null;
      emit({ kind: "tunnel-error", error: err.message });
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    child.on("exit", (code) => {
      log.debug("process exited with code: %d", code ?? -1);
      const wasRunning = tunnelProcess !== null && settled;
      tunnelProcess = null;
      tunnelUrl = null;
      if (!settled) {
        settled = true;
        if (code !== 0) {
          reject(
            new Error(`cloudflared exited with code ${code}: ${stderrChunks.join("").trim()}`),
          );
        } else {
          resolve();
        }
      } else if (wasRunning && code !== 0) {
        // Process died after tunnel was established — notify UI immediately
        emit({
          kind: "tunnel-error",
          error: `cloudflared exited unexpectedly (code ${code ?? -1})`,
        });
      }
    });

    // Timeout: if URL not detected within 30s, resolve anyway
    setTimeout(() => {
      if (!settled) {
        log.debug("30s timeout reached, resolving without URL");
        settled = true;
        resolve();
      }
    }, 30_000);
  });
}

export async function startTunnel(options: { port: number }): Promise<void> {
  // If a start is already in progress, wait for it
  if (startInProgress) {
    log.debug("startTunnel: start already in progress, waiting...");
    await startInProgress;
    return;
  }

  if (tunnelProcess) {
    log.debug("startTunnel: already running, re-emitting URL");
    if (tunnelUrl) {
      emit({ kind: "tunnel-url", url: tunnelUrl });
    }
    return;
  }

  const doStart = async () => {
    const resolvedPath = await shellPath();
    await spawnTunnel(options, resolvedPath);
  };

  startInProgress = doStart();
  try {
    await startInProgress;
  } finally {
    startInProgress = null;
  }
}

export async function stopTunnel(): Promise<void> {
  if (tunnelProcess) {
    tunnelProcess.kill("SIGTERM");
    tunnelProcess = null;
  }
  tunnelUrl = null;
}

export function getTunnelStatus(): {
  running: boolean;
  url: string | null;
} {
  return {
    running: tunnelProcess !== null,
    url: tunnelUrl,
  };
}
