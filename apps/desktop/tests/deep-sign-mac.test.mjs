/**
 * Integration tests for scripts/deep-sign-mac.mjs.
 *
 * Black-box: we lay out a realistic packaged-app subtree under tmp (a few
 * fake `.node`, `.dylib`, and `spawn-helper` files inside `Resources/web/`),
 * then exercise the public API:
 *
 *   - `collectNativeBinaries(root)` — pure FS walk; no shell-out at all.
 *   - `deepSignMac({ root, entitlements, ... })` — orchestrates `codesign`
 *     across every Mach-O the walker finds.
 *   - `signFile({ path, entitlements, ... })` — explicit single-file signer
 *     used by the afterSign hook for the CLI sidecar (which has no naming
 *     convention the walker would catch).
 *
 * For the orchestration helpers we pass a runner spy (a normal IoC seam,
 * not a test-only branch) to capture every invocation without depending on
 * a real codesign binary or Apple Developer credentials in CI.
 */

import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  collectNativeBinaries,
  deepSignMac,
  signFile,
} from "../scripts/deep-sign-mac.mjs";

/**
 * Build a realistic Resources/web/ tree under `root` containing a mix of
 * native binaries (which should be signed) and benign files (which should
 * not). Returns the list of expected matches in the order
 * `collectNativeBinaries` will produce them (sorted).
 */
async function layoutResourcesTree(root) {
  const dist = join(root, "dist");
  const nodeModules = join(dist, "node_modules");
  const ptyDir = join(nodeModules, "node-pty", "build", "Release");
  const fsDir = join(nodeModules, "fsevents");
  await mkdir(ptyDir, { recursive: true });
  await mkdir(fsDir, { recursive: true });

  const expected = [
    join(fsDir, "fsevents.node"),
    join(ptyDir, "libuv.dylib"),
    join(ptyDir, "pty.node"),
    join(ptyDir, "spawn-helper"),
  ];
  for (const path of expected) {
    await writeFile(path, "// fake native binary");
  }

  // Decoys that must NOT be signed.
  await writeFile(join(dist, "start-server.mjs"), "// js entry");
  await writeFile(join(dist, "README.md"), "# docs");
  await writeFile(join(ptyDir, "binding.gyp"), "{}");

  return expected.sort();
}

describe("collectNativeBinaries", () => {
  test("finds .node, .dylib, and spawn-helper anywhere under root", async () => {
    const root = await mkdtemp(join(tmpdir(), "band-deep-sign-collect-"));
    try {
      const expected = await layoutResourcesTree(root);
      const found = collectNativeBinaries(root);
      assert.deepEqual(found, expected);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("returns empty array when root does not exist", () => {
    const found = collectNativeBinaries(join(tmpdir(), "band-does-not-exist-xyz"));
    assert.deepEqual(found, []);
  });

  test("ignores symlinks (does not follow into outside trees)", async () => {
    const root = await mkdtemp(join(tmpdir(), "band-deep-sign-symlink-"));
    const outside = await mkdtemp(join(tmpdir(), "band-deep-sign-outside-"));
    try {
      await mkdir(join(root, "dist"), { recursive: true });
      await writeFile(join(root, "dist", "real.node"), "// real");
      await writeFile(join(outside, "stowaway.node"), "// stowaway");
      await symlink(outside, join(root, "dist", "linked"));

      const found = collectNativeBinaries(root);
      assert.deepEqual(found, [join(root, "dist", "real.node")]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("returns empty array when no native binaries exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "band-deep-sign-empty-"));
    try {
      await mkdir(join(root, "dist"), { recursive: true });
      await writeFile(join(root, "dist", "index.js"), "// no natives here");
      assert.deepEqual(collectNativeBinaries(root), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("deepSignMac", () => {
  test("signs every native binary then verifies each, on darwin with identity", async () => {
    if (process.platform !== "darwin") return; // platform guard inside the function

    const root = await mkdtemp(join(tmpdir(), "band-deep-sign-darwin-"));
    const entitlements = join(root, "ents.plist");
    try {
      const expected = await layoutResourcesTree(root);
      await writeFile(entitlements, "<plist></plist>");

      /** @type {Array<{ cmd: string, args: string[] }>} */
      const calls = [];
      const signed = deepSignMac({
        root,
        entitlements,
        identity: "Developer ID Application: Test (TEAM)",
        runner: (cmd, args) => calls.push({ cmd, args }),
        log: () => {},
      });

      assert.deepEqual(signed, expected);

      // Two phases: N sign calls + N verify calls.
      assert.equal(calls.length, expected.length * 2);
      const signCalls = calls.slice(0, expected.length);
      const verifyCalls = calls.slice(expected.length);

      for (const [i, target] of expected.entries()) {
        assert.equal(signCalls[i].cmd, "codesign");
        assert.deepEqual(signCalls[i].args, [
          "--force",
          "--sign",
          "Developer ID Application: Test (TEAM)",
          "--options",
          "runtime",
          "--timestamp",
          "--entitlements",
          entitlements,
          target,
        ]);
        assert.equal(verifyCalls[i].cmd, "codesign");
        assert.deepEqual(verifyCalls[i].args, [
          "--verify",
          "--strict",
          "--verbose=1",
          target,
        ]);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("short-circuits when SKIP_NATIVE_SIGN=1", async () => {
    const root = await mkdtemp(join(tmpdir(), "band-deep-sign-skip-"));
    try {
      await layoutResourcesTree(root);
      const previous = process.env.SKIP_NATIVE_SIGN;
      process.env.SKIP_NATIVE_SIGN = "1";
      try {
        const calls = [];
        const signed = deepSignMac({
          root,
          entitlements: join(root, "ents.plist"),
          identity: "irrelevant",
          runner: (cmd, args) => calls.push({ cmd, args }),
          log: () => {},
        });
        assert.deepEqual(signed, []);
        assert.deepEqual(calls, []);
      } finally {
        if (previous === undefined) delete process.env.SKIP_NATIVE_SIGN;
        else process.env.SKIP_NATIVE_SIGN = previous;
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("short-circuits when no identity is supplied (unsigned dev build)", async () => {
    const root = await mkdtemp(join(tmpdir(), "band-deep-sign-noid-"));
    try {
      await layoutResourcesTree(root);
      const previous = process.env.APPLE_SIGNING_IDENTITY;
      delete process.env.APPLE_SIGNING_IDENTITY;
      try {
        const calls = [];
        const signed = deepSignMac({
          root,
          entitlements: join(root, "ents.plist"),
          runner: (cmd, args) => calls.push({ cmd, args }),
          log: () => {},
        });
        assert.deepEqual(signed, []);
        assert.deepEqual(calls, []);
      } finally {
        if (previous !== undefined) process.env.APPLE_SIGNING_IDENTITY = previous;
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("throws when entitlements path is missing", async () => {
    if (process.platform !== "darwin") return;
    const root = await mkdtemp(join(tmpdir(), "band-deep-sign-noents-"));
    try {
      await layoutResourcesTree(root);
      assert.throws(
        () =>
          deepSignMac({
            root,
            entitlements: join(root, "does-not-exist.plist"),
            identity: "Developer ID Application: Test (TEAM)",
            runner: () => {},
            log: () => {},
          }),
        /entitlements not found/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("returns empty list when root has no native binaries (no shell-out)", async () => {
    if (process.platform !== "darwin") return;
    const root = await mkdtemp(join(tmpdir(), "band-deep-sign-nobins-"));
    const entitlements = join(root, "ents.plist");
    try {
      await mkdir(join(root, "dist"), { recursive: true });
      await writeFile(join(root, "dist", "boot.js"), "// no natives");
      await writeFile(entitlements, "<plist></plist>");

      const calls = [];
      const signed = deepSignMac({
        root,
        entitlements,
        identity: "Developer ID Application: Test (TEAM)",
        runner: (cmd, args) => calls.push({ cmd, args }),
        log: () => {},
      });
      assert.deepEqual(signed, []);
      assert.deepEqual(calls, []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("signFile", () => {
  test("signs + verifies a single file with the canonical codesign args", async () => {
    if (process.platform !== "darwin") return;

    const dir = await mkdtemp(join(tmpdir(), "band-sign-file-"));
    const target = join(dir, "band");
    const entitlements = join(dir, "ents.plist");
    try {
      await writeFile(target, "// fake Mach-O");
      await writeFile(entitlements, "<plist></plist>");

      /** @type {Array<{ cmd: string, args: string[] }>} */
      const calls = [];
      const signed = signFile({
        path: target,
        entitlements,
        identity: "Developer ID Application: Test (TEAM)",
        runner: (cmd, args) => calls.push({ cmd, args }),
        log: () => {},
      });

      assert.equal(signed, true);
      assert.equal(calls.length, 2);

      // Sign call carries the same args deepSignMac uses — kept identical
      // so every binary in the bundle has the same signature shape.
      assert.equal(calls[0].cmd, "codesign");
      assert.deepEqual(calls[0].args, [
        "--force",
        "--sign",
        "Developer ID Application: Test (TEAM)",
        "--options",
        "runtime",
        "--timestamp",
        "--entitlements",
        entitlements,
        target,
      ]);

      // Verify call.
      assert.equal(calls[1].cmd, "codesign");
      assert.deepEqual(calls[1].args, [
        "--verify",
        "--strict",
        "--verbose=1",
        target,
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("short-circuits when SKIP_NATIVE_SIGN=1", async () => {
    const dir = await mkdtemp(join(tmpdir(), "band-sign-file-skip-"));
    try {
      const target = join(dir, "band");
      const entitlements = join(dir, "ents.plist");
      await writeFile(target, "// fake");
      await writeFile(entitlements, "<plist></plist>");

      const previous = process.env.SKIP_NATIVE_SIGN;
      process.env.SKIP_NATIVE_SIGN = "1";
      try {
        const calls = [];
        const signed = signFile({
          path: target,
          entitlements,
          identity: "irrelevant",
          runner: (cmd, args) => calls.push({ cmd, args }),
          log: () => {},
        });
        assert.equal(signed, false);
        assert.deepEqual(calls, []);
      } finally {
        if (previous === undefined) delete process.env.SKIP_NATIVE_SIGN;
        else process.env.SKIP_NATIVE_SIGN = previous;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("short-circuits when no identity is supplied (unsigned dev build)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "band-sign-file-noid-"));
    try {
      const target = join(dir, "band");
      const entitlements = join(dir, "ents.plist");
      await writeFile(target, "// fake");
      await writeFile(entitlements, "<plist></plist>");

      const previous = process.env.APPLE_SIGNING_IDENTITY;
      delete process.env.APPLE_SIGNING_IDENTITY;
      try {
        const calls = [];
        const signed = signFile({
          path: target,
          entitlements,
          runner: (cmd, args) => calls.push({ cmd, args }),
          log: () => {},
        });
        assert.equal(signed, false);
        assert.deepEqual(calls, []);
      } finally {
        if (previous !== undefined) process.env.APPLE_SIGNING_IDENTITY = previous;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("throws when target file does not exist", async () => {
    if (process.platform !== "darwin") return;
    const dir = await mkdtemp(join(tmpdir(), "band-sign-file-missing-"));
    const entitlements = join(dir, "ents.plist");
    try {
      await writeFile(entitlements, "<plist></plist>");
      assert.throws(
        () =>
          signFile({
            path: join(dir, "does-not-exist"),
            entitlements,
            identity: "Developer ID Application: Test (TEAM)",
            runner: () => {},
            log: () => {},
          }),
        /target not found/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("throws when entitlements path is missing", async () => {
    if (process.platform !== "darwin") return;
    const dir = await mkdtemp(join(tmpdir(), "band-sign-file-noents-"));
    try {
      const target = join(dir, "band");
      await writeFile(target, "// fake");
      assert.throws(
        () =>
          signFile({
            path: target,
            entitlements: join(dir, "does-not-exist.plist"),
            identity: "Developer ID Application: Test (TEAM)",
            runner: () => {},
            log: () => {},
          }),
        /entitlements not found/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
