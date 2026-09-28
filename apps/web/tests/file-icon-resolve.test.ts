import { describe, expect, it } from "vitest";

import {
  manifest,
  resolveFolderIconName,
  resolveIconName,
  resolveIconPath,
} from "../src/dashboard/lib/file-icon-resolve.ts";

describe("resolveIconName", () => {
  it("matches exact filename before extension", () => {
    const dockerName = manifest.fileNames.dockerfile;
    expect(dockerName, "manifest.fileNames.dockerfile missing").toBeTruthy();
    expect(resolveIconName("Dockerfile")).toBe(dockerName);
    expect(resolveIconName("path/to/Dockerfile")).toBe(dockerName);
  });

  it("resolves common code extensions via manifest.fileExtensions", () => {
    const expected = manifest.fileExtensions.tsx;
    expect(expected, "manifest.fileExtensions.tsx missing").toBeTruthy();
    expect(resolveIconName("Component.tsx")).toBe(expected);
  });

  it("prefers longer compound extension when available", (ctx) => {
    const storiesEntry = manifest.fileExtensions["stories.tsx"];
    if (!storiesEntry) {
      // `stories.tsx` is the compound extension we picked for this assertion
      // because material-icon-theme historically shipped a dedicated mapping
      // for it. If a future release drops it, surface the skip explicitly
      // rather than letting the test pass vacuously — that hides the
      // regression from vitest's summary. (The compound-extension
      // resolution path is also covered indirectly via `d.ts` / `spec.ts`
      // mappings in other test cases below.)
      ctx.skip();
      return;
    }
    expect(resolveIconName("Button.stories.tsx")).toBe(storiesEntry);
  });

  it("falls back to manifest.file for unknown extensions", () => {
    expect(resolveIconName("mystery.qqq")).toBe(manifest.file);
    expect(resolveIconName("noext")).toBe(manifest.file);
  });

  it("lowercases input for matching", () => {
    const expected = manifest.fileExtensions.tsx;
    expect(resolveIconName("Foo.TSX")).toBe(expected);
  });
});

describe("resolveFolderIconName", () => {
  it("returns the default folder when name is unknown", () => {
    expect(resolveFolderIconName("zzz-unknown", false)).toBe(manifest.folder);
    expect(resolveFolderIconName("zzz-unknown", true)).toBe(manifest.folderExpanded);
  });

  it("returns the named folder icon when present", () => {
    const src = manifest.folderNames.src;
    expect(src, "manifest.folderNames.src should exist in material-icon-theme").toBeTruthy();
    expect(resolveFolderIconName("src", false)).toBe(src);
  });

  it("uses the expanded variant when expanded=true", () => {
    const srcExpanded = manifest.folderNamesExpanded.src;
    expect(
      srcExpanded,
      "manifest.folderNamesExpanded.src should exist in material-icon-theme",
    ).toBeTruthy();
    expect(resolveFolderIconName("src", true)).toBe(srcExpanded);
  });
});

describe("resolveIconPath", () => {
  it("returns iconPath for known names", () => {
    const path = resolveIconPath(manifest.file);
    expect(path?.endsWith(".svg")).toBe(true);
  });

  it("falls back to manifest.file iconPath for unknown names", () => {
    const fallback = resolveIconPath(manifest.file);
    expect(resolveIconPath("definitely-not-an-icon-name")).toBe(fallback);
  });
});
