/**
 * Resolves the user's full shell PATH (so `node`, `git`, etc. are findable
 * when the app is launched from Finder, where the inherited PATH is sparse).
 *
 * Direct port of `apps/dashboard/src-tauri/src/commands/webserver.rs::shell_path`.
 * Runs `$SHELL -li -c 'echo $PATH'`. Called once during boot and the result
 * is passed to the spawn env, so per-call cost (~30ms) is irrelevant.
 */

import { spawnSync } from "node:child_process";

function fallbackPath(): string {
  const inherited = process.env.PATH ?? "";
  return `/opt/homebrew/bin:/usr/local/bin:${inherited}`;
}

export function shellPath(): string {
  const shell = process.env.SHELL ?? "/bin/zsh";
  try {
    const result = spawnSync(shell, ["-li", "-c", "echo $PATH"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    });
    if (result.status === 0) {
      const out = (result.stdout ?? "").trim();
      if (out.length > 0) return out;
    }
  } catch {
    // shell not present, signal, etc — fall through
  }
  return fallbackPath();
}
