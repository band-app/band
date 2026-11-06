import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseSelectionBlock,
  selectionBlockText,
  selectionLabel,
} from "../src/editor-selection-block.ts";

const info = {
  file: "dir/gridcraft-test.xlsx",
  extensionId: "gridcraft",
  editorId: "sheet",
  selection: { address: "Groceries!D6", label: "Groceries!D6", text: "40.46" },
};

test("round trips a block after the person's text", () => {
  const parsed = parseSelectionBlock(`do you see this\n\n${selectionBlockText(info)}`);
  assert.deepEqual(parsed, {
    body: "do you see this",
    file: "dir/gridcraft-test.xlsx",
    label: "Groceries!D6",
    address: "Groceries!D6",
    text: "40.46",
    chipLabel: "Groceries!D6 · gridcraft-test.xlsx",
  });
  assert.equal(selectionLabel(info.file, "x"), "x · gridcraft-test.xlsx");
});

test("a block alone, with multi-line text, and without text", () => {
  const multi = { ...info, selection: { ...info.selection, text: "a\nb" } };
  assert.equal(parseSelectionBlock(selectionBlockText(multi))?.text, "a\nb");
  assert.equal(parseSelectionBlock(selectionBlockText(multi))?.body, "");
  const bare = { ...info, selection: { address: "A1", label: "A1" } };
  const parsed = parseSelectionBlock(`hi\n\n${selectionBlockText(bare)}`);
  assert.equal(parsed?.text, undefined);
  assert.equal(parsed?.body, "hi");
});

test("an empty body from the web writer still parses", () => {
  assert.equal(parseSelectionBlock(`\n\n${selectionBlockText(info)}`)?.body, "");
});

test("text that only mentions Selected in stays plain", () => {
  assert.equal(parseSelectionBlock("Selected in the editor yesterday"), null);
  assert.equal(parseSelectionBlock("hi\n\nSelected in a.txt (x/y): l\nno address"), null);
  assert.equal(parseSelectionBlock("hi Selected in a.txt (x/y): l\nAddress: a"), null);
  assert.equal(parseSelectionBlock("hi\nSelected in a.txt (x/y): l\nAddress: a"), null);
});
