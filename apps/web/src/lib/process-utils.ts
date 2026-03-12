import { execFile } from "node:child_process";

let cachedShellPath: string | null = null;

export async function shellPath(): Promise<string> {
  if (cachedShellPath) return cachedShellPath;

  const shell = process.env.SHELL || "/bin/zsh";
  try {
    const result = await new Promise<string>((resolve, reject) => {
      execFile(shell, ["-li", "-c", "echo $PATH"], { timeout: 5000 }, (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(stdout.trim());
      });
    });
    if (result) {
      cachedShellPath = result;
      return result;
    }
  } catch {
    // Fall through to default
  }

  const fallback = `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ""}`;
  cachedShellPath = fallback;
  return fallback;
}

export async function whichBinary(name: string): Promise<string | null> {
  const resolvedPath = await shellPath();
  try {
    const result = await new Promise<string>((resolve, reject) => {
      execFile("which", [name], { env: { ...process.env, PATH: resolvedPath } }, (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(stdout.trim());
      });
    });
    return result || null;
  } catch {
    return null;
  }
}

export async function checkPrereqs(): Promise<{ cloudflared: boolean }> {
  const cloudflared = await whichBinary("cloudflared");
  return { cloudflared: cloudflared !== null };
}
