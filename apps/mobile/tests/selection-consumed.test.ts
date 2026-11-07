import assert from "node:assert/strict";
import { test } from "node:test";
import type { EditorSelectionInfo } from "../src/lib/extensions/selection.ts";
import {
  CONSUMED_TTL_MS,
  markConsumed,
  parseConsumed,
  unconsumed,
} from "../src/lib/extensions/selection-consumed.ts";

const sel = (updatedAt: number, address = "a"): EditorSelectionInfo => ({
  file: "t.docx",
  extensionId: "wordcraft",
  editorId: "document",
  selection: { address, kind: "text", label: "x" },
  updatedAt,
});

test("a sent or dismissed selection is not offered again, a new one is", () => {
  const map = markConsumed({}, "wt", sel(1), 1000);
  assert.equal(unconsumed(map, "wt", sel(1)), null);
  assert.equal(unconsumed(map, "other", sel(1))?.updatedAt, 1);
  assert.equal(unconsumed(map, "wt", sel(2))?.updatedAt, 2);
  assert.equal(unconsumed({}, "wt", null), null);
});

test("the state survives a restart within 30 minutes and expires after", () => {
  const map = markConsumed({}, "wt", sel(1), 1000);
  const raw = JSON.stringify(map);
  const back = parseConsumed(raw, 1000 + CONSUMED_TTL_MS);
  assert.equal(unconsumed(back, "wt", sel(1)), null);
  assert.equal(unconsumed(parseConsumed(raw, 1001 + CONSUMED_TTL_MS), "wt", sel(1))?.updatedAt, 1);
  assert.deepEqual(parseConsumed("not json", 0), {});
});
