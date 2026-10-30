import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export interface RunResult {
  stdout: string;
  stderr: string;
}

/** Runs a binary and rejects with its stderr (or the spawn error) when it fails. */
export function run(
  bin: string,
  args: string[],
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      {
        timeout: options.timeoutMs ?? 120_000,
        maxBuffer: 16 * 1024 * 1024,
        env: options.env ?? process.env,
      },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || stdout || err.message).trim();
          reject(new Error(`${bin} ${args.slice(0, 3).join(" ")}: ${detail}`));
        } else {
          resolve({ stdout: String(stdout), stderr: String(stderr) });
        }
      },
    );
  });
}

/**
 * Finds a binary on the PATH and in the directories where Homebrew and pipx put tools, because
 * a worker started by launchd has a short PATH. `BAND_<NAME>_BIN` replaces the lookup.
 */
export function findBinary(name: string, envName: string): string | null {
  const fromEnv = process.env[envName];
  if (fromEnv) return fromEnv;
  const dirs = [
    ...(process.env.PATH ?? "").split(delimiter),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(homedir(), ".local", "bin"),
  ];
  for (const dir of dirs) {
    if (!dir) continue;
    try {
      accessSync(join(dir, name), constants.X_OK);
      return join(dir, name);
    } catch {}
  }
  return null;
}
