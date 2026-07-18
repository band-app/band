import { type ChildProcess, spawn } from "node:child_process";
import { createLogger } from "@band-app/logger";
import { getToken } from "../auth/auth-token";
import { emit } from "../events/status-event-bus";
import { shellPath } from "../process/path";

const log = createLogger("tunnel");

/**
 * Manages a single cloudflared tunnel process. Lifted from
 * `lib/tunnel.ts` as part of Phase 7.5 (issue #517) — the cloudflared
 * subprocess + emitted "tunnel-url" / "tunnel-error" events are now an
 * infra-layer concern, with `TunnelService` (services tier) providing the
 * business-logic API and the `api/tunnel/router.ts` exposing it via tRPC.
 *
 * Process-wide singleton (`tunnelClient`): cloudflared runs at most once,
 * any subsequent `start()` re-emits the cached URL instead of forking a
 * second child.
 */
export class TunnelClient {
  private tunnelProcess: ChildProcess | null = null;
  private tunnelUrl: string | null = null;
  private startInProgress: Promise<void> | null = null;

  /**
   * Extract a trycloudflare.com URL from cloudflared output.
   * cloudflared prints the tunnel URL to stderr in a line like:
   *   ... | https://some-random-words.trycloudflare.com
   * or sometimes with INF prefix:
   *   INF +-------------------------------------------+
   *   INF |  https://xxx.trycloudflare.com            |
   *   INF +-------------------------------------------+
   */
  static extractUrl(text: string): string | null {
    const match = text.match(/https:\/\/[^\s|]+\.trycloudflare\.com/);
    return match ? match[0] : null;
  }

  private static appendToken(baseUrl: string, token: string): string {
    const sep = baseUrl.includes("?") ? "&" : "?";
    return `${baseUrl}${sep}token=${token}`;
  }

  private spawnTunnel(options: { port: number }, resolvedPath: string): Promise<void> {
    // Point cloudflared at the platform's null device so it never picks up
    // a stray config file: `/dev/null` on POSIX, `NUL` on Windows.
    const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
    const args = ["tunnel", "--config", nullDevice, "--url", `http://localhost:${options.port}`];

    log.debug("spawning cloudflared %s", args.join(" "));

    return new Promise((resolve, reject) => {
      const child = spawn("cloudflared", args, {
        env: { ...process.env, PATH: resolvedPath },
        stdio: ["ignore", "pipe", "pipe"],
      });

      this.tunnelProcess = child;
      let settled = false;
      const stderrChunks: string[] = [];

      const handleOutput = (data: Buffer) => {
        const text = data.toString();
        for (const line of text.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          log.debug("output: %s", trimmed);

          const url = TunnelClient.extractUrl(trimmed);
          if (url) {
            const token = getToken();
            this.tunnelUrl = TunnelClient.appendToken(url, token);

            log.debug("detected URL: %s", this.tunnelUrl);
            emit({ kind: "tunnel-url", url: this.tunnelUrl });

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
        this.tunnelProcess = null;
        this.tunnelUrl = null;
        emit({ kind: "tunnel-error", error: err.message });
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      child.on("exit", (code) => {
        log.debug("process exited with code: %d", code ?? -1);
        const wasRunning = this.tunnelProcess !== null && settled;
        this.tunnelProcess = null;
        this.tunnelUrl = null;
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

  async start(options: { port: number }): Promise<void> {
    // If a start is already in progress, wait for it
    if (this.startInProgress) {
      log.debug("start: start already in progress, waiting...");
      await this.startInProgress;
      return;
    }

    if (this.tunnelProcess) {
      log.debug("start: already running, re-emitting URL");
      if (this.tunnelUrl) {
        emit({ kind: "tunnel-url", url: this.tunnelUrl });
      }
      return;
    }

    const doStart = async () => {
      const resolvedPath = await shellPath();
      await this.spawnTunnel(options, resolvedPath);
    };

    this.startInProgress = doStart();
    try {
      await this.startInProgress;
    } finally {
      this.startInProgress = null;
    }
  }

  async stop(): Promise<void> {
    if (this.tunnelProcess) {
      this.tunnelProcess.kill("SIGTERM");
      this.tunnelProcess = null;
    }
    this.tunnelUrl = null;
  }

  getStatus(): { running: boolean; url: string | null } {
    return {
      running: this.tunnelProcess !== null,
      url: this.tunnelUrl,
    };
  }
}

/**
 * Process-wide singleton. Cloudflared runs at most once per server boot,
 * so a shared client is the right shape — see the comment on the class.
 */
export const tunnelClient = new TunnelClient();
