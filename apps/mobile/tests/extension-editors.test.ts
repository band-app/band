import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type ExtensionListLike,
  embedUrl,
  matchesSelector,
  parseFileChoice,
  resolveEditor,
  withFileChoice,
} from "../src/lib/extensions/editors.ts";
import { parsePageMessage } from "../src/lib/extensions/page-message.ts";
import {
  chipLabel,
  type EditorSelectionInfo,
  selectionBlock,
  withSelection,
} from "../src/lib/extensions/selection.ts";

const list: ExtensionListLike = {
  extensions: [
    {
      id: "gridcraft",
      name: "GridCraft",
      contributes: {
        fileEditors: [
          { id: "sheet", label: "Sheet", selector: ["*.xlsx", "*.csv"], default: true },
          { id: "raw", label: "Raw", selector: ["*.csv"] },
        ],
      },
    },
  ],
};

describe("resolveEditor", () => {
  it("uses the manifest default when nothing else is chosen", () => {
    assert.equal(resolveEditor(list, "data/a.xlsx", undefined, {})?.editor.id, "sheet");
  });
  it("returns null for a file no editor matches", () => {
    assert.equal(resolveEditor(list, "a.txt", undefined, {}), null);
  });
  it("prefers the glob default over the manifest default", () => {
    const raw = resolveEditor(list, "a.csv", undefined, { "*.csv": "gridcraft/raw" });
    assert.equal(raw?.editor.id, "raw");
    assert.equal(resolveEditor(list, "a.csv", undefined, { "*.csv": "builtin" }), null);
  });
  it("prefers the file's own choice over everything", () => {
    const chosen = resolveEditor(list, "a.csv", "gridcraft/raw", { "*.csv": "builtin" });
    assert.equal(chosen?.editor.id, "raw");
    assert.equal(resolveEditor(list, "a.xlsx", "builtin", {}), null);
  });
  it("falls back to the viewer when the chosen editor was removed", () => {
    assert.equal(resolveEditor(list, "a.xlsx", "gone/x", {}), null);
  });
});

describe("file choice storage", () => {
  it("reads and writes one file's editor and keeps other fields", () => {
    const raw = JSON.stringify({ "a.xlsx": { viewMode: "source" }, "b.md": { editor: "x/y" } });
    assert.equal(parseFileChoice(raw, "b.md"), "x/y");
    assert.equal(parseFileChoice(raw, "a.xlsx"), undefined);
    const next = JSON.parse(withFileChoice(raw, "a.xlsx", "gridcraft/sheet"));
    assert.deepEqual(next["a.xlsx"], { viewMode: "source", editor: "gridcraft/sheet" });
    const cleared = JSON.parse(withFileChoice(JSON.stringify(next), "a.xlsx", null));
    assert.equal(cleared["a.xlsx"].editor, undefined);
    assert.equal(parseFileChoice("not json", "a"), undefined);
  });
  it("matches selectors like the web", () => {
    assert.equal(matchesSelector("*.XLSX", "a.xlsx"), true);
    assert.equal(matchesSelector("*.csv", "a.csv.bak"), false);
  });
});

describe("embedUrl", () => {
  it("encodes the file, the editor and the token", () => {
    const url = new URL(embedUrl("https://hub.test/", "tok", "repo-main", "a b/c.xlsx", "g/sheet"));
    assert.equal(url.pathname, "/embed/editor");
    assert.equal(url.searchParams.get("path"), "a b/c.xlsx");
    assert.equal(url.searchParams.get("editor"), "g/sheet");
    assert.equal(url.searchParams.get("worktreeId"), "repo-main");
    assert.equal(url.searchParams.get("token"), "tok");
  });
});

describe("selection message", () => {
  const info: EditorSelectionInfo = {
    file: "docs/budget.xlsx",
    extensionId: "gridcraft",
    editorId: "sheet",
    selection: { address: "Sheet1!B2:C4", kind: "range", label: "Sheet1!B2:C4", text: "1\t2" },
  };
  it("labels the chip with the label and file name", () => {
    assert.equal(chipLabel(info), "Sheet1!B2:C4 · budget.xlsx");
  });
  it("formats the block as the contract says", () => {
    assert.equal(
      selectionBlock(info),
      "Selected in docs/budget.xlsx (gridcraft/sheet): Sheet1!B2:C4\nAddress: Sheet1!B2:C4\n1\t2",
    );
  });
  it("appends the block after the text and sends plain text without a chip", () => {
    assert.equal(withSelection("fix this", null), "fix this");
    assert.equal(withSelection("fix this", info), `fix this\n\n${selectionBlock(info)}`);
    assert.equal(withSelection("  ", info), selectionBlock(info));
  });
  it("omits the text line when the selection has none", () => {
    const bare = { ...info, selection: { ...info.selection, text: undefined } };
    assert.equal(selectionBlock(bare).split("\n").length, 2);
  });
});

describe("page messages", () => {
  it("reads the dirty flag and ignores everything else", () => {
    assert.deepEqual(parsePageMessage('{"type":"dirty","dirty":true}'), {
      type: "dirty",
      dirty: true,
    });
    assert.deepEqual(parsePageMessage('{"type":"dirty","dirty":false}'), {
      type: "dirty",
      dirty: false,
    });
    assert.equal(parsePageMessage('{"type":"other"}'), null);
    assert.equal(parsePageMessage("nope"), null);
  });
});
