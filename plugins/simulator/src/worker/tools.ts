import { execFile } from "node:child_process";

export interface RunResult {
  stdout: string;
  stderr: string;
}

/** Runs a binary and rejects with its stderr (or the spawn error) when it fails. */
export function run(
  bin: string,
  args: string[],
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv; stdin?: string } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
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
    if (options.stdin !== undefined) child.stdin?.end(options.stdin);
  });
}
