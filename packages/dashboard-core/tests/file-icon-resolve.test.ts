import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  manifest,
  resolveFolderIconName,
  resolveIconName,
  resolveIconPath,
} from "../src/lib/file-icon-resolve.ts";

describe("resolveIconName", () => {
  it("matches exact filename before extension", () => {
    const dockerName = manifest.fileNames.dockerfile;
    assert.ok(dockerName, "manifest.fileNames.dockerfile missing");
    assert.equal(resolveIconName("Dockerfile"), dockerName);
    assert.equal(resolveIconName("path/to/Dockerfile"), dockerName);
  });

  it("resolves common code extensions via manifest.fileExtensions", () => {
    const expected = manifest.fileExtensions.tsx;
    assert.ok(expected, "manifest.fileExtensions.tsx missing");
    assert.equal(resolveIconName("Component.tsx"), expected);
  });

  it("prefers longer compound extension when available", () => {
    const storiesEntry = manifest.fileExtensions["stories.tsx"];
    if (!storiesEntry) {
      // Manifest doesn't ship a `stories.tsx` mapping; nothing to assert.
      return;
    }
    assert.equal(resolveIconName("Button.stories.tsx"), storiesEntry);
  });

  it("falls back to manifest.file for unknown extensions", () => {
    assert.equal(resolveIconName("mystery.qqq"), manifest.file);
    assert.equal(resolveIconName("noext"), manifest.file);
  });

  it("lowercases input for matching", () => {
    const expected = manifest.fileExtensions.tsx;
    assert.equal(resolveIconName("Foo.TSX"), expected);
  });
});

describe("resolveFolderIconName", () => {
  it("returns the default folder when name is unknown", () => {
    assert.equal(resolveFolderIconName("zzz-unknown", false), manifest.folder);
    assert.equal(resolveFolderIconName("zzz-unknown", true), manifest.folderExpanded);
  });

  it("returns the named folder icon when present", () => {
    const src = manifest.folderNames.src;
    assert.ok(src, "manifest.folderNames.src should exist in material-icon-theme");
    assert.equal(resolveFolderIconName("src", false), src);
  });

  it("uses the expanded variant when expanded=true", () => {
    const srcExpanded = manifest.folderNamesExpanded.src;
    assert.ok(srcExpanded, "manifest.folderNamesExpanded.src should exist in material-icon-theme");
    assert.equal(resolveFolderIconName("src", true), srcExpanded);
  });
});

describe("resolveIconPath", () => {
  it("returns iconPath for known names", () => {
    const path = resolveIconPath(manifest.file);
    assert.ok(path?.endsWith(".svg"));
  });

  it("falls back to manifest.file iconPath for unknown names", () => {
    const fallback = resolveIconPath(manifest.file);
    assert.equal(resolveIconPath("definitely-not-an-icon-name"), fallback);
  });
});
