import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { type ChangesLike, changeListItems, countChanges } from "../src/lib/files/changes.ts";
import { splitRunsIntoLines, textLines } from "../src/lib/files/code-lines.ts";
import { flattenTree } from "../src/lib/files/file-tree.ts";
import { baseName, dirName, fileKind, joinPath, languageForPath } from "../src/lib/files/paths.ts";
import { parseUnifiedDiff } from "../src/lib/files/unified-diff.ts";

describe("paths", () => {
  it("joins, splits and classifies", () => {
    assert.equal(joinPath("", "a.ts"), "a.ts");
    assert.equal(joinPath("src/lib", "a.ts"), "src/lib/a.ts");
    assert.equal(baseName("src/lib/a.ts"), "a.ts");
    assert.equal(dirName("src/lib/a.ts"), "src/lib");
    assert.equal(dirName("a.ts"), "");
    assert.equal(fileKind("logo.PNG"), "image");
    assert.equal(fileKind("docs/README.md"), "markdown");
    assert.equal(fileKind("spec.pdf"), "pdf");
    assert.equal(fileKind("icon.svg"), "code");
    assert.equal(fileKind(".gitignore"), "code");
  });

  it("names a language from the path, then the hub's hint", () => {
    assert.equal(languageForPath("a/b.tsx"), "typescript");
    assert.equal(languageForPath("Makefile"), "makefile");
    assert.equal(languageForPath("x.unknown", "toml"), "toml");
    assert.equal(languageForPath("x.unknown"), "");
  });
});

describe("flattenTree", () => {
  const listings = new Map([
    [
      "",
      [
        { name: "src", type: "directory" as const },
        { name: "empty", type: "directory" as const },
        { name: "README.md", type: "file" as const },
      ],
    ],
    ["src", [{ name: "index.ts", type: "file" as const }]],
  ]);

  it("lists the root with folders closed", () => {
    const rows = flattenTree(listings, new Set());
    assert.deepEqual(
      rows.map((r) => [r.path, r.depth, r.expanded]),
      [
        ["src", 0, false],
        ["empty", 0, false],
        ["README.md", 0, false],
      ],
    );
  });

  it("shows an open folder's entries below it, one level deeper", () => {
    const rows = flattenTree(listings, new Set(["src"]));
    assert.deepEqual(
      rows.map((r) => [r.path, r.depth]),
      [
        ["src", 0],
        ["src/index.ts", 1],
        ["empty", 0],
        ["README.md", 0],
      ],
    );
  });

  it("marks an open folder whose listing has not arrived as loading", () => {
    const rows = flattenTree(listings, new Set(["empty"]));
    assert.equal(rows.find((r) => r.path === "empty")?.loading, true);
    assert.equal(rows.find((r) => r.path === "src")?.loading, false);
  });
});

describe("code lines", () => {
  it("splits runs at newlines and keeps scopes", () => {
    const lines = splitRunsIntoLines([
      { text: "a " },
      { text: "/* x\ny */", scope: "comment" },
      { text: " b" },
    ]);
    assert.deepEqual(lines, [
      [{ text: "a " }, { text: "/* x", scope: "comment" }],
      [{ text: "y */", scope: "comment" }, { text: " b" }],
    ]);
  });

  it("drops the empty line after a trailing newline and CRs", () => {
    assert.deepEqual(textLines("a\r\nb\n"), ["a", "b"]);
    assert.deepEqual(textLines(""), [""]);
  });
});

describe("parseUnifiedDiff", () => {
  const diff = [
    "diff --git a/f.ts b/f.ts",
    "index 111..222 100644",
    "--- a/f.ts",
    "+++ b/f.ts",
    "@@ -1,3 +1,3 @@ function x",
    " keep",
    "-old",
    "+new",
    " tail",
    "@@ -10,1 +10,2 @@",
    " ten",
    "+eleven",
    "\\ No newline at end of file",
  ].join("\n");

  it("numbers both sides and counts changes", () => {
    const parsed = parseUnifiedDiff(diff);
    assert.equal(parsed.added, 2);
    assert.equal(parsed.removed, 1);
    assert.deepEqual(parsed.rows[0], { kind: "hunk", text: "@@ -1,3 +1,3 @@ function x" });
    assert.deepEqual(parsed.rows[1], { kind: "context", text: "keep", oldLine: 1, newLine: 1 });
    assert.deepEqual(parsed.rows[2], { kind: "del", text: "old", oldLine: 2 });
    assert.deepEqual(parsed.rows[3], { kind: "add", text: "new", newLine: 2 });
    assert.deepEqual(parsed.rows[6], { kind: "context", text: "ten", oldLine: 10, newLine: 10 });
    assert.deepEqual(parsed.rows[8], { kind: "note", text: "No newline at end of file" });
  });

  it("reports a binary diff with no rows", () => {
    const parsed = parseUnifiedDiff(
      "diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n",
    );
    assert.equal(parsed.binary, true);
    assert.deepEqual(parsed.rows, []);
  });

  it("reads an added file", () => {
    const parsed = parseUnifiedDiff("--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n");
    assert.deepEqual(
      parsed.rows.filter((r) => r.kind === "add").map((r) => (r.kind === "add" ? r.newLine : 0)),
      [1, 2],
    );
  });
});

describe("changeListItems", () => {
  const entry = (path: string, status: "A" | "M" | "D" | "R" | "U" = "M") => ({ path, status });
  const changes: ChangesLike = {
    compareBranch: "main",
    mergeBase: null,
    branchStatus: "ready",
    conflicts: [],
    unstaged: [entry("a.ts"), entry("b.ts", "D")],
    staged: [entry("c.ts", "A")],
    untracked: [entry("d.txt", "U")],
    branch: [],
  };

  it("groups in the web's order and skips empty sections", () => {
    const items = changeListItems(changes);
    assert.deepEqual(
      items.map((i) => (i.type === "header" ? `${i.title} ${i.count}` : i.entry.path)),
      ["Changes 2", "a.ts", "b.ts", "Staged Changes 1", "c.ts", "Untracked Files 1", "d.txt"],
    );
    assert.equal(countChanges(changes), 4);
  });
});
