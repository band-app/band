#!/usr/bin/env node

/**
 * electron-builder afterPack hook.
 *
 * Runs *before* electron-builder signs the outer .app bundle, while files
 * inside `Band.app/Contents/Resources/` are still mutable. The two steps
 * here MUST happen before the outer codesign call, because that call
 * records hashes of every resource into `_CodeSignature/CodeResources`.
 * Modifying any nested binary after the outer sign would invalidate that
 * seal and Gatekeeper would reject the bundle as "damaged" on first
 * launch (with the canonical
 * "'Band' is damaged and can't be opened" Finder dialog).
 *
 * The hook does two things:
 *
 *   1. Deep-sign nested native binaries inside `Resources/web/` (.node,
 *      .dylib, spawn-helper). electron-builder doesn't recurse into
 *      `extraResources` content. See scripts/deep-sign-mac.mjs.
 *   2. Sign the CLI sidecar at `Resources/binaries/band` (the Rust Mach-O
 *      executable). Same gap as (1) — electron-builder treats every
 *      `extraResources` entry as a verbatim copy. The CLI binary has no
 *      `.node`/`.dylib`/`spawn-helper` naming convention so the heuristic
 *      walker in (1) skips it; we sign it explicitly via `signFile`.
 *
 * Notarization lives in scripts/after-sign.mjs — it must run AFTER the
 * outer .app has been signed, since notarytool requires a valid
 * Developer ID signature on the bundle root.
 *
 * Hook contract (electron-builder docs):
 *   https://www.electron.build/configuration#afterPack
 *   - Receives an AfterPackContext with `electronPlatformName`,
 *     `appOutDir`, `packager`, etc. — same shape as the afterSign hook.
 *   - For non-mas/non-mac builds we no-op.
 *
 * The optional second `opts` argument is a dependency-injection seam for
 * orchestration tests. electron-builder calls `afterPack(context)` with
 * one argument; tests pass `afterPack(context, { runner, log })` to
 * capture codesign invocations without shelling out to the real binary.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { deepSignMac, defaultEntitlements, signFile } from "./deep-sign-mac.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * @param {object} context  AfterPackContext from electron-builder.
 * @param {string} context.electronPlatformName  e.g. "darwin", "win32", "linux".
 * @param {string} context.appOutDir  Directory containing the freshly built .app
 *                                    (e.g. dist-builder/mac-arm64/Band.app).
 * @param {object} [context.packager]
 * @param {object} [context.packager.appInfo]
 * @param {string} [context.packager.appInfo.productFilename]  e.g. "Band".
 * @param {object} [opts]  Optional injection seam (see file header).
 * @param {(cmd: string, args: string[]) => void} [opts.runner]
 * @param {(msg: string) => void} [opts.log]
 */
export default async function afterPack(context, opts = {}) {
  const platform = context.electronPlatformName;
  if (platform !== "darwin" && platform !== "mas") {
    // Windows/Linux signing happens inline during electron-builder's pack
    // step; nothing more to do here.
    return;
  }

  const productFilename = context.packager?.appInfo?.productFilename ?? "Band";
  const appPath = join(context.appOutDir, `${productFilename}.app`);
  if (!existsSync(appPath)) {
    throw new Error(`[after-pack] expected .app bundle at ${appPath}`);
  }

  const localEntitlements = resolve(__dirname, "..", "build", "entitlements.mac.plist");
  const entitlements = existsSync(localEntitlements) ? localEntitlements : defaultEntitlements();

  // 1. Deep-sign nested native binaries inside Resources/web/.
  //    electron-builder ships extraResources verbatim, so the structure is:
  //      Band.app/Contents/Resources/web/dist/...
  const webResources = join(appPath, "Contents", "Resources", "web");
  if (existsSync(webResources)) {
    deepSignMac({ root: webResources, entitlements, runner: opts.runner, log: opts.log });
  } else {
    (opts.log ?? ((m) => console.log(m)))(
      `[after-pack] ${webResources} not found — skipping deep-sign (no extraResources?)`,
    );
  }

  // 2. Sign the CLI sidecar (Rust Mach-O at Resources/binaries/band).
  //    Tauri's `externalBin` mechanism signed this automatically; electron-
  //    builder's `extraResources` does not. Without this step notarization
  //    rejects with "code object is not signed at all" pointing at band,
  //    AND Gatekeeper rejects the outer bundle as damaged because the
  //    unsigned executable mismatches the parent's signed-resource seal.
  const cliBinary = join(appPath, "Contents", "Resources", "binaries", "band");
  if (existsSync(cliBinary)) {
    signFile({ path: cliBinary, entitlements, runner: opts.runner, log: opts.log });
  } else {
    (opts.log ?? ((m) => console.log(m)))(
      `[after-pack] ${cliBinary} not found — skipping CLI sign (no sidecar?)`,
    );
  }
}
