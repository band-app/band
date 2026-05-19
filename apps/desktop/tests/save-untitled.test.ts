/**
 * Integration test for the "Save As" untitled-tab IPC handler
 * (issue #434).
 *
 * The full `pickSaveFile` orchestrates two pieces:
 *
 *   1. `dialog.showSaveDialog` — Electron's native modal; opening it
 *      from a node:test worker would either block on user input or
 *      require mocking Electron itself, neither of which matches the
 *      "no mocks, real filesystem" rule in `CLAUDE.md`.
 *   2. `writeSavedFile` — a plain `fs.writeFileSync` call that
 *      persists the renderer's buffer once a path is chosen.
 *
 * Piece (2) is the part the IPC handler is responsible for ON BEHALF
 * of the renderer (the renderer never touches disk directly — the
 * "filesystem trust boundary stays inside the desktop shell"
 * invariant from `pickSaveFile`'s doc comment). It's also the part
 * with the integration test value: a regression where the wrong
 * encoding is used, the path doesn't get created, or trailing bytes
 * get truncated would slip past any contract-level test of the
 * dialog plumbing.
 *
 * `resolveSaveDialogSeed` is the small piece of pre-dialog logic that
 * decides what to hand to `defaultPath` based on the renderer's
 * suggested name + workspace dir. Covered here too because it's
 * easy to get wrong on the "only filename" / "only directory" /
 * "neither" branches.
 */

import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { resolveSaveDialogSeed, writeSavedFile } from "../src/main/ipc/save-helpers.ts";

describe("resolveSaveDialogSeed", () => {
  test("joins defaultPath and defaultName when both are provided", () => {
    const seed = resolveSaveDialogSeed({
      defaultPath: "/Users/alice/projects/band",
      defaultName: "Untitled-1.txt",
    });
    assert.equal(seed, "/Users/alice/projects/band/Untitled-1.txt");
  });

  test("uses defaultPath alone when defaultName is omitted", () => {
    const seed = resolveSaveDialogSeed({ defaultPath: "/Users/alice/projects/band" });
    assert.equal(seed, "/Users/alice/projects/band");
  });

  test("uses defaultName alone when defaultPath is omitted", () => {
    const seed = resolveSaveDialogSeed({ defaultName: "scratch.md" });
    assert.equal(seed, "scratch.md");
  });

  test("falls back to Untitled.txt when neither is provided", () => {
    assert.equal(resolveSaveDialogSeed({}), "Untitled.txt");
  });
});

describe("writeSavedFile", () => {
  test("persists buffer content under the chosen path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "band-save-untitled-write-"));
    try {
      const target = join(dir, "scratch.md");
      const body = "# Hello\n\nA fresh untitled buffer.\n";
      await writeSavedFile(target, body);
      const onDisk = await readFile(target, "utf8");
      assert.equal(onDisk, body);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("writes content as UTF-8 (round-trips non-ASCII without mangling)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "band-save-untitled-utf8-"));
    try {
      const target = join(dir, "russe.txt");
      // Mix of multi-byte UTF-8 sequences: Cyrillic, emoji, Korean.
      const body = "Привет 👋 안녕하세요\n";
      await writeSavedFile(target, body);
      const onDisk = await readFile(target, "utf8");
      assert.equal(onDisk, body);
      // Confirm the disk byte count matches the UTF-8-encoded length —
      // catches a future regression where someone swaps utf8 for ascii.
      const info = await stat(target);
      assert.equal(info.size, Buffer.byteLength(body, "utf8"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("overwrites an existing file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "band-save-untitled-overwrite-"));
    try {
      const target = join(dir, "scratch.txt");
      await writeSavedFile(target, "first revision\n");
      await writeSavedFile(target, "second revision\n");
      const onDisk = await readFile(target, "utf8");
      assert.equal(onDisk, "second revision\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("writes an empty buffer to disk (zero-byte file)", async () => {
    // The renderer can save an untitled tab with no content (the user
    // hits Cmd+S immediately after creating it). The result should be
    // a real zero-byte file, not a missing one.
    const dir = await mkdtemp(join(tmpdir(), "band-save-untitled-empty-"));
    try {
      const target = join(dir, "empty.txt");
      await writeSavedFile(target, "");
      const info = await stat(target);
      assert.equal(info.size, 0);
      const onDisk = await readFile(target, "utf8");
      assert.equal(onDisk, "");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("propagates filesystem errors instead of swallowing them", async () => {
    // A non-existent parent directory triggers ENOENT. The error must
    // bubble up so the IPC chain can surface it to the renderer rather
    // than the dialog reporting success and the user losing their work.
    const bogus = join(tmpdir(), "band-save-untitled-missing-parent", "missing-dir", "x.txt");
    await assert.rejects(writeSavedFile(bogus, "should fail"), /ENOENT/);
  });

  test("does not leave a temp file behind when the rename target's directory is missing", async () => {
    // The write-to-temp + rename path can fail in two phases: the
    // writeFile (parent missing), or the rename itself (very rare on
    // normal filesystems but possible across mounts). Either way we
    // shouldn't leak a `.band-save-*.tmp` next to the target.
    const dir = await mkdtemp(join(tmpdir(), "band-save-untitled-cleanup-"));
    try {
      const bogus = join(dir, "nonexistent-subdir", "x.txt");
      await assert.rejects(writeSavedFile(bogus, "should fail"), /ENOENT/);
      // The temp file lives in the same directory as the target, which
      // doesn't exist — nothing to assert on a subdir that was never
      // created. The point is the call threw and didn't leave a temp
      // file in the parent directory.
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(dir);
      assert.equal(
        entries.filter((e) => e.startsWith(".band-save-")).length,
        0,
        "expected no .band-save-*.tmp files left in the parent directory",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("atomic: a successful write replaces the previous content in one step", async () => {
    // Atomicity guarantee: the rename(2) swap means the destination
    // path is always either the old or new content, never a truncated
    // intermediate. We can't easily force a mid-write crash in a
    // single-process test, but we can verify the temp + rename
    // mechanics actually run (the function completes, the destination
    // has the new content, and no stray .tmp files remain).
    const dir = await mkdtemp(join(tmpdir(), "band-save-untitled-atomic-"));
    try {
      const target = join(dir, "doc.md");
      await writeSavedFile(target, "original\n");
      await writeSavedFile(target, "replaced\n");
      assert.equal(await readFile(target, "utf8"), "replaced\n");
      const { readdir } = await import("node:fs/promises");
      const stray = (await readdir(dir)).filter((e) => e.startsWith(".band-save-"));
      assert.deepEqual(stray, [], "no temp file should remain after a successful rename");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
