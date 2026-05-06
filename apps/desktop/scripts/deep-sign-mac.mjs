#!/usr/bin/env node

/**
 * Deep-sign nested macOS native binaries inside the .app bundle.
 *
 * Tauri's bundler doesn't recursively sign native dependencies inside
 * bundled resources, and notarization rejects unsigned executables.
 * electron-builder has the same gap for `extraResources` content:
 *
 *   - The bundled web server (`Resources/web/`) ships `.node` addons,
 *     `.dylib` libraries, and node-pty's `spawn-helper` — handled by
 *     `deepSignMac` (heuristic walk by filename).
 *   - The CLI sidecar (`Resources/binaries/band`) is a single Mach-O
 *     executable with no extension — handled by `signFile` (one explicit
 *     path, called separately by the afterSign hook).
 *
 * Both helpers share the same codesign command line — see `signOne` /
 * `verifyOne` below — so signature parameters (hardened runtime flag,
 * timestamp, entitlements) stay consistent across every binary in the
 * bundle.
 *
 * Exposed as both library functions (used by scripts/after-sign.mjs) and a
 * standalone CLI (`node scripts/deep-sign-mac.mjs <root>`) for reproducing
 * notarization failures locally against an unpacked build tree.
 *
 * Required env: APPLE_SIGNING_IDENTITY (e.g. "Developer ID Application: ...").
 * Optional env: SKIP_NATIVE_SIGN=1 to short-circuit (unsigned dev builds).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Filenames considered "native binaries" that need their own signature. */
const NATIVE_BASENAMES = new Set(["spawn-helper"]);
const NATIVE_EXTENSIONS = [".node", ".dylib"];

function isNativeBinary(filename) {
  if (NATIVE_BASENAMES.has(filename)) return true;
  return NATIVE_EXTENSIONS.some((ext) => filename.endsWith(ext));
}

/**
 * Walk `root` (synchronously) and return absolute paths of every regular
 * file matching {@link isNativeBinary}.
 */
export function collectNativeBinaries(root) {
  if (!existsSync(root)) return [];
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // Permissions / vanished entry — skip.
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue; // never follow symlinks
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && isNativeBinary(entry.name)) {
        out.push(full);
      }
    }
  }
  out.sort();
  return out;
}

/**
 * Default `runner` — shells out to the named binary (`codesign`) with
 * inherited stdio. Used when the caller doesn't override.
 */
function defaultRunner(cmd, args) {
  execFileSync(cmd, args, { stdio: "inherit" });
}

/**
 * Issue the `codesign --force --sign … --options runtime --timestamp
 * --entitlements …` command for a single file. Pulled out so every signing
 * call site (deep walker, single-file CLI sidecar) uses identical args.
 */
function signOne(runner, target, identity, entitlements) {
  runner("codesign", [
    "--force",
    "--sign",
    identity,
    "--options",
    "runtime",
    "--timestamp",
    "--entitlements",
    entitlements,
    target,
  ]);
}

/** Issue `codesign --verify --strict --verbose=1` for a single file. */
function verifyOne(runner, target) {
  runner("codesign", ["--verify", "--strict", "--verbose=1", target]);
}

/**
 * Common short-circuit checks shared by `deepSignMac` and `signFile`.
 *
 * Returns the resolved identity when signing should proceed, or `null` when
 * the caller should bail out early (and the helper has already logged the
 * reason). Throws on a missing entitlements file because that's a config
 * bug, not a dev-build short-circuit.
 *
 * @returns {string | null}
 */
function resolveSigningContext(opts, log, label) {
  if (process.env.SKIP_NATIVE_SIGN === "1") {
    log(`[${label}] SKIP_NATIVE_SIGN=1 — skipping`);
    return null;
  }

  const identity = opts.identity ?? process.env.APPLE_SIGNING_IDENTITY;
  if (!identity) {
    log(`[${label}] APPLE_SIGNING_IDENTITY not set — skipping (unsigned dev build)`);
    return null;
  }

  if (process.platform !== "darwin") {
    log(`[${label}] non-macOS host — skipping`);
    return null;
  }

  if (!existsSync(opts.entitlements)) {
    throw new Error(`[${label}] entitlements not found at ${opts.entitlements}`);
  }

  return identity;
}

/**
 * Sign + verify a single explicit Mach-O file with the project's standard
 * codesign args (hardened runtime, timestamp, entitlements plist).
 *
 * Used by the afterSign hook for the CLI sidecar at
 * `Resources/binaries/band`, which has no `.node`/`.dylib`/`spawn-helper`
 * naming convention — `deepSignMac`'s heuristic walker would skip it.
 *
 * Honors the same env-driven short-circuits as `deepSignMac`
 * (SKIP_NATIVE_SIGN, missing APPLE_SIGNING_IDENTITY, non-darwin host) so
 * unsigned dev builds remain ergonomic.
 *
 * @param {object} opts
 * @param {string} opts.path  Absolute path to the binary to sign.
 * @param {string} opts.entitlements  Absolute path to the entitlements plist.
 * @param {string} [opts.identity]  Override APPLE_SIGNING_IDENTITY.
 * @param {(cmd: string, args: string[]) => void} [opts.runner]
 *   How to invoke `codesign`. Defaults to `execFileSync` with inherited stdio.
 * @param {(msg: string) => void} [opts.log]  Defaults to `console.log`.
 * @returns {boolean} `true` when the file was signed, `false` on short-circuit.
 */
export function signFile(opts) {
  const log = opts.log ?? ((m) => console.log(m));
  const identity = resolveSigningContext(opts, log, "sign-file");
  if (!identity) return false;

  if (!existsSync(opts.path)) {
    throw new Error(`[sign-file] target not found: ${opts.path}`);
  }

  const runner = opts.runner ?? defaultRunner;
  log(`[sign-file] signing ${opts.path} with identity: ${identity}`);
  signOne(runner, opts.path, identity, opts.entitlements);
  log("[sign-file] verify");
  verifyOne(runner, opts.path);
  log("[sign-file] done");
  return true;
}

/**
 * Sign every native binary under `root` with the given identity + entitlements.
 *
 * Returns the list of paths that were signed. Honors SKIP_NATIVE_SIGN=1 and
 * a missing APPLE_SIGNING_IDENTITY by returning an empty list (matches Tauri
 * dev behavior — log + skip rather than fail).
 *
 * Two-pass design (sign all, then verify all): if signing fails partway
 * through we want to fail before claiming the bundle is verified.
 *
 * @param {object} opts
 * @param {string} opts.root  Directory to walk.
 * @param {string} opts.entitlements  Absolute path to the entitlements plist.
 * @param {string} [opts.identity]  Override APPLE_SIGNING_IDENTITY.
 * @param {(cmd: string, args: string[]) => void} [opts.runner]
 *   How to invoke the `codesign` binary. Defaults to `execFileSync` with
 *   inherited stdio; callers may override to capture output, dry-run, or
 *   pipe to a custom logger.
 * @param {(msg: string) => void} [opts.log]  Defaults to `console.log`.
 * @returns {string[]} signed paths
 */
export function deepSignMac(opts) {
  const log = opts.log ?? ((m) => console.log(m));
  const identity = resolveSigningContext(opts, log, "deep-sign-mac");
  if (!identity) return [];

  if (!existsSync(opts.root)) {
    throw new Error(`[deep-sign-mac] root not found: ${opts.root}`);
  }

  const targets = collectNativeBinaries(opts.root);
  if (targets.length === 0) {
    log("[deep-sign-mac] no native binaries found");
    return [];
  }

  const runner = opts.runner ?? defaultRunner;

  log(`[deep-sign-mac] signing ${targets.length} native binaries with identity: ${identity}`);
  for (const target of targets) {
    log(`  → ${target}`);
    signOne(runner, target, identity, opts.entitlements);
  }

  log("[deep-sign-mac] verify");
  for (const target of targets) {
    verifyOne(runner, target);
  }
  log("[deep-sign-mac] done");
  return targets;
}

/** Default entitlements path (relative to repo layout). */
export function defaultEntitlements() {
  return resolve(__dirname, "..", "build", "entitlements.mac.plist");
}

// CLI entry-point: `node scripts/deep-sign-mac.mjs <root> [entitlements]`.
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url === `file://${resolve(process.argv[1] ?? "")}`;

if (isMain) {
  const [, , rootArg, entitlementsArg] = process.argv;
  if (!rootArg) {
    console.error("usage: deep-sign-mac.mjs <root-dir> [entitlements.plist]");
    process.exit(2);
  }
  try {
    const signed = deepSignMac({
      root: resolve(rootArg),
      entitlements: entitlementsArg ? resolve(entitlementsArg) : defaultEntitlements(),
    });
    if (signed.length === 0 && process.env.APPLE_SIGNING_IDENTITY) {
      // Identity present but nothing signed — surface for CI debugging.
      console.log("[deep-sign-mac] (no targets matched)");
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
