import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type FileIconMaps,
  resolveFileIconName,
  resolveFolderIconName,
} from "../src/file-icon-name.ts";

const maps: FileIconMaps = {
  fileNames: { dockerfile: "docker", "package.json": "nodejs" },
  fileExtensions: { ts: "typescript", "d.ts": "typescript-def", json: "json" },
  folderNames: { src: "folder-src" },
  folderNamesExpanded: { src: "folder-src-open" },
  file: "file",
  folder: "folder",
  folderExpanded: "folder-open",
};

describe("file icon names", () => {
  it("prefers an exact name, then the longest extension, then the generic icon", () => {
    assert.equal(resolveFileIconName(maps, "path/to/Dockerfile"), "docker");
    assert.equal(resolveFileIconName(maps, "package.json"), "nodejs");
    assert.equal(resolveFileIconName(maps, "a.d.ts"), "typescript-def");
    assert.equal(resolveFileIconName(maps, "a.ts"), "typescript");
    assert.equal(resolveFileIconName(maps, "a.zzz"), "file");
    assert.equal(resolveFileIconName(maps, "constructor"), "file");
  });

  it("resolves folders open and closed", () => {
    assert.equal(resolveFolderIconName(maps, "app/src", false), "folder-src");
    assert.equal(resolveFolderIconName(maps, "src", true), "folder-src-open");
    assert.equal(resolveFolderIconName(maps, "other", false), "folder");
    assert.equal(resolveFolderIconName(maps, "other", true), "folder-open");
  });
});
