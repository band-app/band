/**
 * Raw Homebrew `brew install <pkg>` adapter. Currently used to install
 * `cloudflared` from the dashboard's "Install Tunnel" button.
 *
 * Lives in the infra tier so the `execFile` shell-out is behind a single
 * seam (issue #535, follow-up 3). The services-tier orchestration
 * (resolving the interactive `$PATH` via `shellPath()` first, then calling
 * this) lives in `services/system-service.ts`.
 *
 * Web vs desktop split note (CLAUDE.md): `brew` is unix-only (macOS and
 * Linuxbrew). The `prereqs.installTunnel` tRPC procedure that ultimately
 * reaches this adapter pre-existed the #535 cleanup; relocating it
 * behind the desktop IPC bridge (alongside the Finder reveal / app open
 * helpers in `apps/desktop/src/main/ipc/macos-shell.ts`) is a separate
 * architectural change. The cleanup only moved the `execFile` call into
 * this file; it did not introduce or expand the surface.
 */

import { execFile } from "node:child_process";

/**
 * Packages this adapter is allowed to install. The literal union doubles
 * as runtime guard — a future caller that passes anything else fails to
 * compile, so the brewInstall surface can't accidentally become a
 * "install whatever package the request specifies" hole. Add new
 * entries here when a new install flow lands.
 */
type AllowedPackage = "cloudflared";

/**
 * Install a Homebrew package by name with the supplied `PATH` (so `brew`
 * itself is locatable on a process that inherited a stripped-down PATH
 * from launchd / Electron). Times out at 120s; surfaces stderr in the
 * thrown error so the UI can show why the install failed.
 */
export async function brewInstall(pkg: AllowedPackage, resolvedPath: string): Promise<void> {
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
