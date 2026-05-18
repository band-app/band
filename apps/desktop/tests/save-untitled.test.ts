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
      writeSavedFile(target, body);
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
      writeSavedFile(target, body);
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
      writeSavedFile(target, "first revision\n");
      writeSavedFile(target, "second revision\n");
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
      writeSavedFile(target, "");
      const info = await stat(target);
      assert.equal(info.size, 0);
      const onDisk = await readFile(target, "utf8");
      assert.equal(onDisk, "");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("propagates filesystem errors instead of swallowing them", () => {
    // A non-existent parent directory triggers ENOENT. The error must
    // bubble up so the IPC chain can surface it to the renderer rather
    // than the dialog reporting success and the user losing their work.
    const bogus = join(tmpdir(), "band-save-untitled-missing-parent", "missing-dir", "x.txt");
    assert.throws(() => writeSavedFile(bogus, "should fail"), /ENOENT/);
  });
});
