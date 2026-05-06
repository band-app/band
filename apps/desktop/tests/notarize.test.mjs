/**
 * Integration tests for scripts/notarize.mjs.
 *
 * Black-box: we lay out a fake .app bundle directory in tmp and exercise
 * the public API:
 *
 *   - `resolveCredentials(env)` — pure: maps env to notarytool args.
 *   - `notarize({ appPath, env, runner, ... })` — orchestrates xcrun
 *     notarytool + stapler. We use the documented `runner` injection seam
 *     to capture command-line args without depending on the real xcrun.
 *
 * The `runner` is called with three args — `(cmd, args, opts?)` — where
 * `opts.capture` is set when notarize wants stdout back (used to parse
 * notarytool's JSON output). Test spies return JSON strings for capture
 * calls and undefined otherwise, mirroring what the default execFileSync
 * runner does in production.
 *
 * Apple notarization itself can't be exercised in CI (it requires real
 * App Store Connect credentials and several minutes per round-trip), so we
 * assert the command-line we hand to `xcrun` is correct and that the
 * rejection / log-fetch flow surfaces the diagnostic info.
 */

import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { notarize, resolveCredentials } from "../scripts/notarize.mjs";

/**
 * Build a runner spy that returns a canned JSON response for the
 * `notarytool submit` capture call (and any subsequent `notarytool log`
 * call, with `logResponse`). All captured invocations land in `calls`.
 *
 * @param {object} responses
 * @param {object} [responses.submitResponse]  JSON object returned for submit
 * @param {string} [responses.logResponse]     Stringified JSON returned for log
 * @param {Error} [responses.submitThrows]     If set, the runner throws on submit
 */
function makeRunner({ submitResponse, logResponse, submitThrows } = {}) {
  /** @type {Array<{ cmd: string, args: string[], opts?: { capture?: boolean } }>} */
  const calls = [];
  const runner = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (cmd === "xcrun" && args[0] === "notarytool" && args[1] === "submit") {
      if (submitThrows) throw submitThrows;
      if (opts?.capture) return JSON.stringify(submitResponse ?? { id: "test-id", status: "Accepted" });
      return undefined;
    }
    if (cmd === "xcrun" && args[0] === "notarytool" && args[1] === "log") {
      if (opts?.capture) return logResponse ?? "{}";
      return undefined;
    }
    return undefined;
  };
  return { runner, calls };
}

describe("resolveCredentials", () => {
  test("returns api-key creds when API trio is present", async () => {
    const dir = await mkdtemp(join(tmpdir(), "band-notarize-creds-api-"));
    try {
      const keyPath = join(dir, "api-key.p8");
      await writeFile(keyPath, "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----");

      const creds = resolveCredentials({
        APPLE_API_KEY_PATH: keyPath,
        APPLE_API_KEY_ID: "ABC1234567",
        APPLE_API_ISSUER: "00000000-0000-0000-0000-000000000000",
      });
      assert.equal(creds?.kind, "api-key");
      assert.deepEqual(creds?.args, [
        "--key",
        keyPath,
        "--key-id",
        "ABC1234567",
        "--issuer",
        "00000000-0000-0000-0000-000000000000",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("throws when API key path does not exist on disk", () => {
    assert.throws(
      () =>
        resolveCredentials({
          APPLE_API_KEY_PATH: "/tmp/band-no-such-key-XYZ.p8",
          APPLE_API_KEY_ID: "ABC1234567",
          APPLE_API_ISSUER: "00000000-0000-0000-0000-000000000000",
        }),
      /APPLE_API_KEY_PATH/,
    );
  });

  test("falls back to app-password when API trio is incomplete", () => {
    const creds = resolveCredentials({
      APPLE_ID: "dev@example.com",
      APPLE_APP_SPECIFIC_PASSWORD: "abcd-efgh-ijkl-mnop",
      APPLE_TEAM_ID: "TEAM123456",
    });
    assert.equal(creds?.kind, "app-password");
    assert.deepEqual(creds?.args, [
      "--apple-id",
      "dev@example.com",
      "--password",
      "abcd-efgh-ijkl-mnop",
      "--team-id",
      "TEAM123456",
    ]);
  });

  test("returns null when nothing is configured (dev build)", () => {
    assert.equal(resolveCredentials({}), null);
  });

  test("returns null when only some app-password fields are set", () => {
    assert.equal(
      resolveCredentials({ APPLE_ID: "dev@example.com", APPLE_TEAM_ID: "TEAM123456" }),
      null,
    );
  });
});

describe("notarize", () => {
  /** Lay out a minimal Band.app/Contents/MacOS skeleton. */
  async function makeFakeApp(parent) {
    const appPath = join(parent, "Band.app");
    await mkdir(join(appPath, "Contents", "MacOS"), { recursive: true });
    await writeFile(join(appPath, "Contents", "Info.plist"), "<plist></plist>");
    return appPath;
  }

  test("submits + staples on darwin with API-key creds", async () => {
    if (process.platform !== "darwin") return;
    const dir = await mkdtemp(join(tmpdir(), "band-notarize-submit-"));
    try {
      const appPath = await makeFakeApp(dir);
      const keyPath = join(dir, "api-key.p8");
      await writeFile(keyPath, "fake");

      const { runner, calls } = makeRunner({
        submitResponse: { id: "submission-abc", status: "Accepted" },
      });
      const result = notarize({
        appPath,
        env: {
          APPLE_API_KEY_PATH: keyPath,
          APPLE_API_KEY_ID: "ABC1234567",
          APPLE_API_ISSUER: "00000000-0000-0000-0000-000000000000",
        },
        runner,
        log: () => {},
      });

      assert.equal(result, "submitted");
      // Three calls: ditto (zip the .app), notarytool submit (the zip),
      // stapler (the original .app).
      assert.equal(calls.length, 3);

      // 1) ditto creates the archive notarytool requires. The zip path
      //    lives in an os.tmpdir()/band-notarize-* directory the script
      //    creates per-invocation.
      assert.equal(calls[0].cmd, "ditto");
      assert.equal(calls[0].args[0], "-c");
      assert.equal(calls[0].args[1], "-k");
      assert.equal(calls[0].args[2], "--keepParent");
      assert.equal(calls[0].args[3], appPath);
      assert.match(calls[0].args[4], /band-notarize-.*\/Band\.app\.zip$/);
      assert.notEqual(calls[0].opts?.capture, true);

      // 2) Submit the zip (NOT the .app — notarytool rejects raw .app).
      const zipPath = calls[0].args[4];
      assert.equal(calls[1].cmd, "xcrun");
      assert.deepEqual(calls[1].args, [
        "notarytool",
        "submit",
        zipPath,
        "--key",
        keyPath,
        "--key-id",
        "ABC1234567",
        "--issuer",
        "00000000-0000-0000-0000-000000000000",
        "--wait",
        "--output-format",
        "json",
      ]);
      assert.equal(calls[1].opts?.capture, true);

      // 3) Staple the *original* .app, not the zip — the ticket is written
      //    into the bundle and propagates into any later .dmg/.zip.
      assert.equal(calls[2].cmd, "xcrun");
      assert.deepEqual(calls[2].args, ["stapler", "staple", appPath]);
      assert.notEqual(calls[2].opts?.capture, true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("submits with app-password creds when API trio is absent", async () => {
    if (process.platform !== "darwin") return;
    const dir = await mkdtemp(join(tmpdir(), "band-notarize-pwd-"));
    try {
      const appPath = await makeFakeApp(dir);

      const { runner, calls } = makeRunner({
        submitResponse: { id: "submission-xyz", status: "Accepted" },
      });
      const result = notarize({
        appPath,
        env: {
          APPLE_ID: "dev@example.com",
          APPLE_APP_SPECIFIC_PASSWORD: "abcd-efgh-ijkl-mnop",
          APPLE_TEAM_ID: "TEAM123456",
        },
        runner,
        log: () => {},
      });

      assert.equal(result, "submitted");
      // calls[0] is the ditto zip step; submit is calls[1] and references
      // the zip path the script just created (not the .app).
      assert.equal(calls[0].cmd, "ditto");
      const zipPath = calls[0].args[4];
      assert.deepEqual(calls[1].args, [
        "notarytool",
        "submit",
        zipPath,
        "--apple-id",
        "dev@example.com",
        "--password",
        "abcd-efgh-ijkl-mnop",
        "--team-id",
        "TEAM123456",
        "--wait",
        "--output-format",
        "json",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("on rejection: fetches the diagnostic log, dumps it, then throws", async () => {
    if (process.platform !== "darwin") return;
    const dir = await mkdtemp(join(tmpdir(), "band-notarize-reject-"));
    try {
      const appPath = await makeFakeApp(dir);
      const keyPath = join(dir, "api-key.p8");
      await writeFile(keyPath, "fake");

      // Apple finished the scan and rejected. notarytool log returns the
      // structured issues array.
      const issuesLog = JSON.stringify({
        logFormatVersion: 1,
        jobId: "submission-bad",
        status: "Invalid",
        statusSummary: "Archive contains critical validation errors",
        issues: [
          {
            severity: "error",
            path: "Band.app/Contents/Resources/binaries/band",
            message: "The signature of the binary is invalid.",
            architecture: "arm64",
          },
        ],
      });
      const { runner, calls } = makeRunner({
        submitResponse: { id: "submission-bad", status: "Invalid", message: "see log" },
        logResponse: issuesLog,
      });

      /** @type {string[]} */
      const logged = [];
      assert.throws(
        () =>
          notarize({
            appPath,
            env: {
              APPLE_API_KEY_PATH: keyPath,
              APPLE_API_KEY_ID: "ABC1234567",
              APPLE_API_ISSUER: "00000000-0000-0000-0000-000000000000",
            },
            runner,
            log: (m) => logged.push(m),
          }),
        // The thrown error should mention the rejection status and the
        // submission ID so users can correlate with App Store Connect.
        /Apple rejected submission submission-bad.*Invalid/,
      );

      // We expect exactly: 1 ditto (zip) + 1 submit (capture) + 1 log
      // fetch (capture). No stapler call should have been issued.
      assert.equal(calls.length, 3);
      assert.equal(calls[0].cmd, "ditto");
      assert.deepEqual(calls[1].args.slice(0, 2), ["notarytool", "submit"]);
      assert.deepEqual(calls[2].args, [
        "notarytool",
        "log",
        "submission-bad",
        "--key",
        keyPath,
        "--key-id",
        "ABC1234567",
        "--issuer",
        "00000000-0000-0000-0000-000000000000",
      ]);
      assert.equal(calls[2].opts?.capture, true);

      // The diagnostic log JSON should appear in the captured log output —
      // that's the whole point of this flow: a CI failure shows the issues
      // array inline without anyone having to re-auth and pull it manually.
      const concatenated = logged.join("\n");
      assert.match(concatenated, /begin notarytool log/);
      assert.match(concatenated, /Resources\/binaries\/band/);
      assert.match(concatenated, /signature of the binary is invalid/);
      assert.match(concatenated, /end notarytool log/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("on submit subprocess failure: still tries to fetch log if id is recoverable", async () => {
    if (process.platform !== "darwin") return;
    const dir = await mkdtemp(join(tmpdir(), "band-notarize-subfail-"));
    try {
      const appPath = await makeFakeApp(dir);
      const keyPath = join(dir, "api-key.p8");
      await writeFile(keyPath, "fake");

      // notarytool itself failed (e.g., transient network) but printed the
      // submission id to stdout before bailing. Mirror the way execFileSync
      // attaches stdout to the thrown error.
      const partialOutput = JSON.stringify({ id: "submission-fail", status: "In Progress" });
      const subprocessErr = Object.assign(new Error("xcrun exited with code 1"), {
        stdout: partialOutput,
      });

      const { runner, calls } = makeRunner({
        submitThrows: subprocessErr,
        logResponse: JSON.stringify({ status: "Invalid", issues: [] }),
      });

      assert.throws(
        () =>
          notarize({
            appPath,
            env: {
              APPLE_API_KEY_PATH: keyPath,
              APPLE_API_KEY_ID: "ABC1234567",
              APPLE_API_ISSUER: "00000000-0000-0000-0000-000000000000",
            },
            runner,
            log: () => {},
          }),
        /notarytool submit failed/,
      );

      // ditto + submit (threw) + log (recovered the id from the partial
      // stdout).
      assert.equal(calls.length, 3);
      assert.equal(calls[0].cmd, "ditto");
      assert.equal(calls[2].args[1], "log");
      assert.equal(calls[2].args[2], "submission-fail");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("on submit subprocess failure with no parseable id: throws without a log fetch", async () => {
    if (process.platform !== "darwin") return;
    const dir = await mkdtemp(join(tmpdir(), "band-notarize-noid-"));
    try {
      const appPath = await makeFakeApp(dir);
      const keyPath = join(dir, "api-key.p8");
      await writeFile(keyPath, "fake");

      const subprocessErr = Object.assign(new Error("xcrun exited with code 1"), {
        stdout: "garbage that is not JSON",
      });
      const { runner, calls } = makeRunner({ submitThrows: subprocessErr });

      assert.throws(
        () =>
          notarize({
            appPath,
            env: {
              APPLE_API_KEY_PATH: keyPath,
              APPLE_API_KEY_ID: "ABC1234567",
              APPLE_API_ISSUER: "00000000-0000-0000-0000-000000000000",
            },
            runner,
            log: () => {},
          }),
        /notarytool submit failed/,
      );

      // ditto (zip) + the failed submit attempt — no log fetch because
      // we couldn't recover a submission id to query from the unparseable
      // stdout.
      assert.equal(calls.length, 2);
      assert.equal(calls[0].cmd, "ditto");
      assert.deepEqual(calls[1].args.slice(0, 2), ["notarytool", "submit"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("skips when SKIP_NOTARIZE=1", async () => {
    const dir = await mkdtemp(join(tmpdir(), "band-notarize-skipenv-"));
    try {
      const appPath = await makeFakeApp(dir);
      const { runner, calls } = makeRunner();
      const result = notarize({
        appPath,
        env: {
          SKIP_NOTARIZE: "1",
          APPLE_API_KEY_PATH: appPath, // even if creds present, env wins
          APPLE_API_KEY_ID: "X",
          APPLE_API_ISSUER: "Y",
        },
        runner,
        log: () => {},
      });
      assert.equal(result, "skipped");
      assert.deepEqual(calls, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("skips when no credentials are configured (dev build)", async () => {
    if (process.platform !== "darwin") return;
    const dir = await mkdtemp(join(tmpdir(), "band-notarize-nocreds-"));
    try {
      const appPath = await makeFakeApp(dir);
      const { runner, calls } = makeRunner();
      const result = notarize({
        appPath,
        env: {}, // no credentials at all
        runner,
        log: () => {},
      });
      assert.equal(result, "skipped");
      assert.deepEqual(calls, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("throws when .app bundle is missing on disk", async () => {
    if (process.platform !== "darwin") return;
    const dir = await mkdtemp(join(tmpdir(), "band-notarize-noapp-"));
    try {
      const keyPath = join(dir, "api-key.p8");
      await writeFile(keyPath, "fake");
      assert.throws(
        () =>
          notarize({
            appPath: join(dir, "DoesNotExist.app"),
            env: {
              APPLE_API_KEY_PATH: keyPath,
              APPLE_API_KEY_ID: "ABC1234567",
              APPLE_API_ISSUER: "00000000-0000-0000-0000-000000000000",
            },
            runner: () => {},
            log: () => {},
          }),
        /\.app bundle not found/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
