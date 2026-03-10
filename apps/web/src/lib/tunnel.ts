import { type ChildProcess, execFile, spawn } from "node:child_process";
import { getToken } from "./auth-token";
import { shellPath } from "./process-utils";
import { emit } from "./watcher";

let tunnelProcess: ChildProcess | null = null;
let tunnelUrl: string | null = null;
let tunnelSubdomain: string | null = null;
let tunnelRemoteHost: string | null = null;

function extractUrl(text: string): string | null {
  const match = text.match(/https:\/\/[^\s]+\.instatunnel\.my/);
  return match ? match[0] : null;
}

function extractSubdomain(url: string): string | null {
  const match = url.match(/^https:\/\/(.+)\.instatunnel\.my/);
  if (!match) return null;
  const sub = match[1];
  if (sub === "api") return null;
  return sub;
}

function appendToken(baseUrl: string, token: string | null): string {
  if (!token) return baseUrl;
  const sep = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${sep}token=${token}`;
}

export async function startTunnel(options: {
  port: number;
  subdomain?: string;
  skipSubdomain?: boolean;
}): Promise<void> {
  if (tunnelProcess) {
    throw new Error("Tunnel is already running");
  }

  const resolvedPath = await shellPath();
  const args = [String(options.port)];
  if (options.subdomain && !options.skipSubdomain) {
    args.push("--subdomain", options.subdomain);
  }

  return new Promise((resolve, reject) => {
    const child = spawn("instatunnel", args, {
      env: { ...process.env, PATH: resolvedPath },
      stdio: ["ignore", "pipe", "pipe"],
    });

    tunnelProcess = child;
    let settled = false;
    let subdomainTaken = false;
    const stderrChunks: string[] = [];

    const handleOutput = (data: Buffer) => {
      const text = data.toString();
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const url = extractUrl(trimmed);
        if (url) {
          const sub = extractSubdomain(url);
          if (sub) {
            tunnelSubdomain = sub;
            const token = getToken();
            tunnelUrl = appendToken(url, token);

            emit({ kind: "tunnel-url", url: tunnelUrl });

            if (!settled) {
              settled = true;
              resolve();
            }
          }
        } else if (trimmed.includes("subdomain") && trimmed.toLowerCase().includes("taken")) {
          subdomainTaken = true;
          emit({ kind: "tunnel-subdomain-taken", subdomain: options.subdomain });
        } else if (trimmed.includes("remote host:")) {
          const host = trimmed.split("remote host:")[1]?.trim();
          if (host) {
            tunnelRemoteHost = host;
            emit({ kind: "tunnel-remote-host", remoteHost: host });
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
      tunnelProcess = null;
      tunnelUrl = null;
      tunnelSubdomain = null;
      tunnelRemoteHost = null;
      emit({ kind: "tunnel-error", error: err.message });
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    child.on("exit", (code) => {
      tunnelProcess = null;
      tunnelUrl = null;
      const sub = tunnelSubdomain;
      tunnelSubdomain = null;
      tunnelRemoteHost = null;
      if (!settled) {
        settled = true;
        if (code !== 0 && !subdomainTaken) {
          reject(
            new Error(`instatunnel exited with code ${code}: ${stderrChunks.join("").trim()}`),
          );
        } else {
          resolve();
        }
      }
      if (sub) {
        // Already exited, no more events
      }
    });

    // Timeout: if URL not detected within 30s, resolve anyway
    setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve();
      }
    }, 30_000);
  });
}

export async function stopTunnel(): Promise<void> {
  const sub = tunnelSubdomain;
  if (tunnelProcess) {
    tunnelProcess.kill("SIGTERM");
    tunnelProcess = null;
  }
  tunnelUrl = null;
  tunnelSubdomain = null;
  tunnelRemoteHost = null;

  // Also run instatunnel --kill to clean up remote
  if (sub) {
    const resolvedPath = await shellPath();
    await new Promise<void>((resolve) => {
      execFile(
        "instatunnel",
        ["--kill", sub],
        { env: { ...process.env, PATH: resolvedPath }, timeout: 10_000 },
        () => resolve(),
      );
    });
  }
}

export function getTunnelStatus(): {
  running: boolean;
  url: string | null;
  remoteHost: string | null;
} {
  return {
    running: tunnelProcess !== null,
    url: tunnelUrl,
    remoteHost: tunnelRemoteHost,
  };
}

export async function checkTunnelAuth(): Promise<boolean> {
  const resolvedPath = await shellPath();
  return new Promise((resolve) => {
    execFile(
      "instatunnel",
      ["auth", "show-key"],
      { env: { ...process.env, PATH: resolvedPath }, timeout: 10_000 },
      (err) => {
        resolve(!err);
      },
    );
  });
}

export async function checkTunnelHealth(
  subdomain: string,
  token: string | null,
): Promise<{ healthy: boolean; remoteHost?: string }> {
  const baseUrl = `https://${subdomain}.instatunnel.my`;
  const url = token ? `${baseUrl}/api/health?token=${token}` : baseUrl;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (token) {
      if (!response.ok) {
        return { healthy: false };
      }
      const body = (await response.json()) as { status?: string; hostname?: string };
      return {
        healthy: body.status === "ok",
        remoteHost: body.hostname,
      };
    }
    // No token — any HTTP response means the tunnel is alive
    return { healthy: true };
  } catch {
    return { healthy: false };
  }
}
