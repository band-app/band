import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { findFilePaths, isFilePath } from "../src/file-path-detection.ts";

describe("findFilePaths", () => {
  it("finds paths with a line number in plain text", () => {
    const text = "See src/app.ts:12 and ./lib/util.js:3-9, not 127.0.0.1:5173.";
    assert.deepEqual(findFilePaths(text), [
      { start: 4, end: 17, path: "src/app.ts:12" },
      { start: 22, end: 39, path: "./lib/util.js:3-9" },
    ]);
  });

  it("finds nothing in text without a line number", () => {
    assert.deepEqual(findFilePaths("Edit src/app.ts later"), []);
  });

  it("isFilePath accepts a path and rejects a command", () => {
    assert.equal(isFilePath("src/app.ts"), true);
    assert.equal(isFilePath("npm test"), false);
  });
});
