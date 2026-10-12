import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCollapsed, toggleCollapsed } from "../src/lib/collapsed-repos.ts";

describe("collapsed repos", () => {
  it("reads a stored list and ignores a damaged one", () => {
    assert.deepEqual([...parseCollapsed('["a","b"]')], ["a", "b"]);
    assert.equal(parseCollapsed("not json").size, 0);
    assert.equal(parseCollapsed('{"a":1}').size, 0);
    assert.equal(parseCollapsed(null).size, 0);
  });

  it("toggles a repo and stores nothing once none is collapsed", () => {
    const one = toggleCollapsed(null, "b");
    assert.equal(one, '["b"]');
    const two = toggleCollapsed(one, "a");
    assert.equal(two, '["a","b"]');
    assert.equal(toggleCollapsed(toggleCollapsed(two, "a"), "b"), null);
  });
});
