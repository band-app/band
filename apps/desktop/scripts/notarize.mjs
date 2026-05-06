#!/usr/bin/env node

/**
 * Submit a packaged .app to Apple's notarization service via `notarytool`.
 *
 * Invoked from scripts/after-sign.mjs after electron-builder has signed
 * the outer .app. The deep-sign of nested binaries happens earlier in
 * scripts/after-pack.mjs (before the outer seal is computed); by the
 * time we reach notarize, every Mach-O inside the bundle already carries
 * a valid Developer ID signature.
 *
 * The flow itself is the canonical Apple workflow:
 *
 *   ditto -c -k --keepParent <app> <zip>   ← notarytool requires a .zip,
 *   xcrun notarytool submit <zip> --wait   ← .pkg, or .dmg (the older
 *   xcrun stapler staple <app>             ← `altool` accepted a raw .app,
 *                                            notarytool does not). Stapling
 *                                            writes the ticket into the
 *                                            .app itself, so any .dmg /
 *                                            .zip electron-builder later
 *                                            produces from this .app
 *                                            inherits the ticket.
 *
 * Notarization requirements:
 *
 *   - The .app has been signed with a Developer ID Application certificate
 *     and the hardened runtime is enabled (electron-builder + the
 *     afterPack hook handle that).
 *   - Either an App Store Connect API key (preferred — non-interactive) or
 *     an app-specific password is provided via env.
 *
 * On rejection, the script auto-fetches the diagnostic log via `notarytool
 * log <submission-id>` and dumps the JSON inline so the CI failure log
 * carries the actual reason (which executable was unsigned, which entitlement
 * is wrong, etc.) — no need to re-auth and pull the log manually.
 *
 * Env (App Store Connect API key — preferred):
 *   APPLE_API_KEY_PATH   Path to the .p8 key file written by
 *                        .github/actions/apple-sign-setup.
 *   APPLE_API_KEY_ID     Key ID (10-char string from App Store Connect).
 *   APPLE_API_ISSUER     Issuer UUID from App Store Connect.
 *
 * Env (app-specific password — fallback for legacy CI):
 *   APPLE_ID             Apple ID email.
 *   APPLE_APP_SPECIFIC_PASSWORD  app-specific password from appleid.apple.com.
 *   APPLE_TEAM_ID        Team ID (10-char alphanumeric).
 *
 * Optional env:
 *   SKIP_NOTARIZE=1      Short-circuit (matches the dev-build pattern from
 *                        Tauri's sign-mac-deps.sh).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

/**
 * @typedef {object} NotarizeCredentials
 * @property {"api-key"|"app-password"} kind
 * @property {string[]} args  Extra `notarytool submit` args carrying creds.
 */

/**
 * Default `runner` — shells out to the named binary. When `opts.capture` is
 * set, returns stdout as a string (used for parsing notarytool's JSON
 * output); otherwise inherits stdio and returns nothing.
 *
 * @returns {string | undefined}
 */
function defaultRunner(cmd, args, opts) {
  if (opts?.capture) {
    return execFileSync(cmd, args, { encoding: "utf8" });
  }
  execFileSync(cmd, args, { stdio: "inherit" });
  return undefined;
}

/**
 * Resolve credentials from env, returning `null` when nothing is configured
 * (so the caller can short-circuit instead of failing the build).
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {NotarizeCredentials | null}
 */
export function resolveCredentials(env) {
  if (env.APPLE_API_KEY_PATH && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) {
    if (!existsSync(env.APPLE_API_KEY_PATH)) {
      throw new Error(
        `[notarize] APPLE_API_KEY_PATH points to ${env.APPLE_API_KEY_PATH} which does not exist`,
      );
    }
    return {
      kind: "api-key",
      args: [
        "--key",
        env.APPLE_API_KEY_PATH,
        "--key-id",
        env.APPLE_API_KEY_ID,
        "--issuer",
        env.APPLE_API_ISSUER,
      ],
    };
  }
  if (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID) {
    return {
      kind: "app-password",
      args: [
        "--apple-id",
        env.APPLE_ID,
        "--password",
        env.APPLE_APP_SPECIFIC_PASSWORD,
        "--team-id",
        env.APPLE_TEAM_ID,
      ],
    };
  }
  return null;
}

/**
 * Best-effort: fetch the diagnostic log Apple produced for `submissionId`
 * and dump it via `log()`. Used on rejection so the CI failure surface
 * carries the actual issues array (rather than just "status: Invalid").
 *
 * Errors here are swallowed because the caller is already going to throw a
 * notarization-failed error — we don't want to mask the original failure
 * with a "couldn't fetch log" error.
 */
function dumpNotarizationLog(submissionId, creds, runner, log) {
  log(`[notarize] fetching diagnostic log for submission ${submissionId}`);
  try {
    const stdout = runner(
      "xcrun",
      ["notarytool", "log", submissionId, ...creds.args],
      { capture: true },
    );
    if (typeof stdout === "string" && stdout.trim().length > 0) {
      log("[notarize] --- begin notarytool log ---");
      log(stdout.trimEnd());
      log("[notarize] --- end notarytool log ---");
      log(
        "[notarize] tip: each `issues[]` entry tells you which path / arch failed and why.",
      );
    }
  } catch (err) {
    log(
      `[notarize] could not fetch diagnostic log for ${submissionId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Try to extract the submission ID from notarytool's JSON output.
 * notarytool with `--output-format json --wait` prints a single JSON object
 * on completion: `{"id":"...","status":"Accepted|Invalid|...","message":"..."}`.
 *
 * Returns `null` when the input isn't valid JSON or has no `id` field — the
 * caller should fall through to a generic "submission failed" error.
 *
 * @param {string | undefined} stdout
 * @returns {{ id?: string, status?: string, message?: string } | null}
 */
function parseSubmitOutput(stdout) {
  if (typeof stdout !== "string" || stdout.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(stdout);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // Not JSON — could be a connectivity error from notarytool itself.
  }
  return null;
}

/**
 * Submit `appPath` for notarization and staple the resulting ticket.
 *
 * On any non-Accepted outcome, fetches the diagnostic log from
 * `notarytool log <id>` and dumps it before throwing — so the CI failure
 * log shows *which* binary / entitlement Apple rejected, not just that the
 * submission failed.
 *
 * @param {object} opts
 * @param {string} opts.appPath       Absolute path to the .app bundle.
 * @param {NodeJS.ProcessEnv} [opts.env]  Defaults to `process.env`.
 * @param {(cmd: string, args: string[], runOpts?: { capture?: boolean }) => string | undefined} [opts.runner]
 *   How to invoke `xcrun`. When `runOpts.capture` is true, returns stdout as
 *   a string; otherwise inherits stdio. Defaults to `execFileSync`-backed
 *   runner; callers may override to dry-run or pipe to a custom logger.
 * @param {(msg: string) => void} [opts.log]  Defaults to console.log.
 * @returns {"submitted"|"skipped"} `"skipped"` when env opts out.
 */
export function notarize(opts) {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((m) => console.log(m));

  if (env.SKIP_NOTARIZE === "1") {
    log("[notarize] SKIP_NOTARIZE=1 — skipping");
    return "skipped";
  }

  if (process.platform !== "darwin") {
    log("[notarize] non-macOS host — skipping");
    return "skipped";
  }

  const creds = resolveCredentials(env);
  if (!creds) {
    log("[notarize] no notarization credentials in env — skipping (dev build)");
    return "skipped";
  }

  if (!existsSync(opts.appPath)) {
    throw new Error(`[notarize] .app bundle not found at ${opts.appPath}`);
  }

  const runner = opts.runner ?? defaultRunner;

  // notarytool no longer accepts a raw .app bundle (the older `altool` did);
  // it requires a .zip / .pkg / .dmg. Apple's documented workflow is:
  //   ditto -c -k --keepParent <app> <zip>   ← create archive
  //   xcrun notarytool submit <zip> --wait   ← submit archive
  //   xcrun stapler staple <app>             ← staple the *original* .app
  // The staple is written into the .app bundle itself, so any subsequent
  // .dmg / .zip electron-builder produces from that .app inherits the
  // ticket. We zip into an os.tmpdir() so the throwaway archive doesn't
  // leak into dist-builder/.
  const tmpDir = mkdtempSync(join(tmpdir(), "band-notarize-"));
  const zipPath = join(tmpDir, `${basename(opts.appPath)}.zip`);
  try {
    log(`[notarize] zipping ${opts.appPath} → ${zipPath}`);
    runner("ditto", ["-c", "-k", "--keepParent", opts.appPath, zipPath]);

    // `--wait` blocks until Apple returns a final state. `--output-format
    // json` gives us a single parseable line on completion so we can
    // extract the submission ID and final status without scraping
    // human-readable output.
    log(`[notarize] submitting ${zipPath} (auth: ${creds.kind})`);
    const submitArgs = [
      "notarytool",
      "submit",
      zipPath,
      ...creds.args,
      "--wait",
      "--output-format",
      "json",
    ];

    /** @type {string | undefined} */
    let submitStdout;
    try {
      submitStdout = runner("xcrun", submitArgs, { capture: true });
    } catch (err) {
      // notarytool itself failed (network error, auth error, etc.). It may
      // have printed the submission ID to stdout before bailing — try to
      // capture and surface it.
      const stdoutFromErr =
        err && typeof err === "object" && "stdout" in err
          ? String(/** @type {{ stdout?: unknown }} */ (err).stdout ?? "")
          : "";
      const parsed = parseSubmitOutput(stdoutFromErr);
      if (parsed?.id) {
        dumpNotarizationLog(parsed.id, creds, runner, log);
      }
      throw new Error(
        `[notarize] notarytool submit failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const result = parseSubmitOutput(submitStdout);
    if (!result || !result.id) {
      throw new Error(
        `[notarize] could not parse notarytool output (got: ${JSON.stringify(submitStdout)})`,
      );
    }

    if (result.status !== "Accepted") {
      // Apple finished the scan and rejected. Fetch the issues array so the
      // CI log carries the actual reason.
      dumpNotarizationLog(result.id, creds, runner, log);
      throw new Error(
        `[notarize] Apple rejected submission ${result.id} (status: ${result.status}${
          result.message ? `, message: ${result.message}` : ""
        }). See the notarytool log dumped above for the offending paths.`,
      );
    }

    log(`[notarize] accepted (submission: ${result.id})`);
    log("[notarize] stapling ticket");
    runner("xcrun", ["stapler", "staple", opts.appPath]);
    log("[notarize] done");
    return "submitted";
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
