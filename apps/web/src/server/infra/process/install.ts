/**
 * Raw Homebrew `brew install <pkg>` adapter. Currently used to install
 * `cloudflared` from the dashboard's "Install Tunnel" button.
 *
 * Lives in the infra tier so the `execFile` shell-out is behind a single
 * seam (issue #535, follow-up 3). The services-tier orchestration
 * (resolving the interactive `$PATH` via `shellPath()` first, then calling
 * this) lives in `services/system-service.ts`.
 */

import { execFile } from "node:child_process";

/**
 * Install a Homebrew package by name with the supplied `PATH` (so `brew`
 * itself is locatable on a process that inherited a stripped-down PATH
 * from launchd / Electron). Times out at 120s; surfaces stderr in the
 * thrown error so the UI can show why the install failed.
 */
export async function brewInstall(pkg: string, resolvedPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(
      "brew",
      ["install", pkg],
      { env: { ...process.env, PATH: resolvedPath }, timeout: 120_000 },
      (err, _stdout, stderr) => {
        if (err) {
          reject(new Error(stderr || err.message));
          return;
        }
        resolve();
      },
    );
  });
}
