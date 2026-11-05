/**
 * `readLocalFile` and `saveLocalFile` read and write files on this Mac for the renderer. They take
 * an absolute path from the page, so the limits are the contract: no symlink, regular files only,
 * a size cap, binary detection, and a save never creates a file. They call plain `node:fs` against
 * a temp dir, with no state to fake, which is why this runs outside Electron.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
  MAX_LOCAL_FILE_SIZE,
  readLocalFile,
  saveLocalFile,
} from "../src/main/services/local-files.ts";
import { OpenFileQueue } from "../src/main/services/open-file-queue.ts";

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "band-local-files-"));
});
after(() => rmSync(dir, { recursive: true, force: true }));

describe("readLocalFile", () => {
  test("returns content, size and a language hint", async () => {
    const file = join(dir, "a.ts");
    writeFileSync(file, "const a = 1;\n");
    assert.deepEqual(await readLocalFile(file), {
      content: "const a = 1;\n",
      size: 13,
      language: "typescript",
    });
  });

  test("refuses a relative path, a directory and a missing file", async () => {
    await assert.rejects(readLocalFile("a.ts"), /Absolute path required/);
    await assert.rejects(readLocalFile(dir), /directory/);
    await assert.rejects(readLocalFile(join(dir, "nope")), /File not found/);
  });

  test("refuses a symlink", async () => {
    const target = join(dir, "real.txt");
    writeFileSync(target, "x");
    const link = join(dir, "link.txt");
    symlinkSync(target, link);
    await assert.rejects(readLocalFile(link), /Symbolic links/);
  });

  test("reports a file over the cap and a binary file without their bytes", async () => {
    const big = join(dir, "big.txt");
    writeFileSync(big, Buffer.alloc(MAX_LOCAL_FILE_SIZE + 1, 65));
    assert.deepEqual(await readLocalFile(big), { tooLarge: true, size: MAX_LOCAL_FILE_SIZE + 1 });
    const bin = join(dir, "x.bin");
    writeFileSync(bin, Buffer.from([0, 1, 2]));
    assert.deepEqual(await readLocalFile(bin), { binary: true, size: 3 });
  });
});

describe("saveLocalFile", () => {
  test("writes an existing file", async () => {
    const file = join(dir, "save.txt");
    writeFileSync(file, "old");
    await saveLocalFile(file, "new");
    assert.equal(readFileSync(file, "utf8"), "new");
  });

  test("never creates a file", async () => {
    await assert.rejects(saveLocalFile(join(dir, "created.txt"), "x"), /File not found/);
  });

  test("never writes through a symlink", async () => {
    const target = join(dir, "t.txt");
    writeFileSync(target, "keep");
    const link = join(dir, "l.txt");
    symlinkSync(target, link);
    await assert.rejects(saveLocalFile(link, "evil"), /Symbolic links/);
    assert.equal(readFileSync(target, "utf8"), "keep");
  });

  test("refuses a relative path, a directory and content over the cap", async () => {
    await assert.rejects(saveLocalFile("rel.txt", "x"), /Absolute path required/);
    await assert.rejects(saveLocalFile(dir, "x"), /directory/);
    const file = join(dir, "cap.txt");
    writeFileSync(file, "ok");
    await assert.rejects(saveLocalFile(file, "a".repeat(MAX_LOCAL_FILE_SIZE + 1)), /too large/);
    assert.equal(readFileSync(file, "utf8"), "ok");
  });
});

describe("OpenFileQueue", () => {
  test("holds paths that arrive before anyone listens, then hands them over once", () => {
    const queue = new OpenFileQueue();
    queue.push("/a/one.txt");
    queue.push("/a/two.txt");
    assert.deepEqual(queue.take(), ["/a/one.txt", "/a/two.txt"]);
    assert.deepEqual(queue.take(), []);
  });

  test("announces each push and ignores relative or malformed paths", () => {
    const queue = new OpenFileQueue();
    let pushes = 0;
    const stop = queue.onPush(() => {
      pushes++;
    });
    queue.push("relative.txt");
    queue.push("/bad\0path");
    queue.push("/ok.txt");
    stop();
    queue.push("/after.txt");
    assert.equal(pushes, 1);
    assert.deepEqual(queue.take(), ["/ok.txt", "/after.txt"]);
  });
});
