#!/usr/bin/env node

/**
 * electron-builder afterSign hook.
 *
 * Runs after electron-builder has signed the outer .app with the primary
 * Developer ID Application certificate. At this point the bundle is fully
 * sealed: `Contents/_CodeSignature/CodeResources` records hashes for
 * every file under `Contents/Resources/`, and any modification to those
 * files would invalidate the seal and trigger Gatekeeper's "is damaged"
 * dialog on first launch.
 *
 * That's why the deep-sign work (nested .node / .dylib / spawn-helper
 * inside Resources/web/, plus the CLI sidecar at Resources/binaries/band)
 * lives in scripts/after-pack.mjs instead — it MUST happen before the
 * outer sign so the seal is computed against already-signed nested files.
 *
 * The only step left for afterSign is notarization: submit the signed
 * .app to Apple via `notarytool` and staple the resulting ticket so the
 * .dmg can be distributed online without the Gatekeeper grace-period
 * warning. The hook short-circuits cleanly when:
 *
 *   - SKIP_NOTARIZE=1 is set (CI escape hatch — see release.yml).
 *   - The host is not macOS.
 *   - No App Store Connect API key / app-specific password is configured
 *     (typical for forks / local dev builds).
 *
 * Hook contract (electron-builder docs):
 *   https://www.electron.build/configuration#aftersign
 *   - Receives an AfterPackContext-like object with `electronPlatformName`,
 *     `appOutDir`, `packager`, etc.
 *   - For non-mas/non-mac builds we no-op.
 *
 * The optional second `opts` argument is a dependency-injection seam for
 * orchestration tests. electron-builder calls `afterSign(context)` with
 * one argument; tests pass `afterSign(context, { runner, log })` to
 * capture xcrun invocations without shelling out to the real binary.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { notarize } from "./notarize.mjs";

/**
 * @param {object} context  AfterPackContext from electron-builder.
 * @param {string} context.electronPlatformName  e.g. "darwin", "win32", "linux".
 * @param {string} context.appOutDir  Directory containing the freshly signed .app
 *                                    (e.g. dist-builder/mac-arm64/Band.app).
 * @param {object} [context.packager]
 * @param {object} [context.packager.appInfo]
 * @param {string} [context.packager.appInfo.productFilename]  e.g. "Band".
 * @param {object} [opts]  Optional injection seam (see file header).
 * @param {(cmd: string, args: string[], runOpts?: { capture?: boolean }) => string | undefined} [opts.runner]
 * @param {(msg: string) => void} [opts.log]
 */
export default async function afterSign(context, opts = {}) {
  const platform = context.electronPlatformName;
  if (platform !== "darwin" && platform !== "mas") {
    return;
  }

  const productFilename = context.packager?.appInfo?.productFilename ?? "Band";
  const appPath = join(context.appOutDir, `${productFilename}.app`);
  if (!existsSync(appPath)) {
    throw new Error(`[after-sign] expected .app bundle at ${appPath}`);
  }

  notarize({ appPath, runner: opts.runner, log: opts.log });
}
