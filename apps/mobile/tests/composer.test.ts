import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  makeAttachment,
  rejectionFor,
  resolveMediaType,
  toWireFiles,
} from "../src/lib/composer/attachments.ts";
import { moveItem, queueSetPayload } from "../src/lib/composer/queue.ts";

describe("attachments", () => {
  it("reads the type from the extension when the picker reports none", () => {
    assert.equal(resolveMediaType(undefined, "notes.md"), "text/markdown");
    assert.equal(resolveMediaType("application/octet-stream", "data.JSON"), "application/json");
    assert.equal(resolveMediaType("image/heic", "a.heic"), "image/heic");
  });

  it("refuses unsupported and oversized files", () => {
    assert.equal(rejectionFor("image/png", 1000), null);
    assert.equal(rejectionFor("image/heic", 1000), "unsupported");
    assert.equal(rejectionFor("image/png", 11 * 1024 * 1024), "too-large");
  });

  it("sends nothing for an empty list and data URLs otherwise", () => {
    assert.equal(toWireFiles([]), undefined);
    const files = toWireFiles([makeAttachment("a.png", "image/png", "QUJD", 3)]);
    assert.equal(files?.[0]?.url, "data:image/png;base64,QUJD");
    assert.equal(files?.[0]?.filename, "a.png");
  });
});

describe("queue order", () => {
  it("moves an item and leaves bad indexes alone", () => {
    assert.deepEqual(moveItem(["a", "b", "c"], 2, 0), ["c", "a", "b"]);
    assert.deepEqual(moveItem(["a", "b", "c"], 0, 1), ["b", "a", "c"]);
    const same = ["a"];
    assert.equal(moveItem(same, 0, 3), same);
  });

  it("drops an empty files list from the payload", () => {
    assert.deepEqual(
      queueSetPayload([
        { id: "1", text: "a", files: [] },
        { id: "2", text: "b", files: [{ mediaType: "image/png", url: "data:x" }] },
      ]),
      [
        { id: "1", text: "a" },
        { id: "2", text: "b", files: [{ mediaType: "image/png", url: "data:x" }] },
      ],
    );
  });
});
