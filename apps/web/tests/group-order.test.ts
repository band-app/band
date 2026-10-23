import { describe, expect, it } from "vitest";
import { moveGroupBy, moveGroupTo } from "../src/dashboard/lib/group-order";

describe("moveGroupBy", () => {
  it("swaps a group with its neighbour", () => {
    expect(moveGroupBy(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveGroupBy(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
  });

  it("returns null at the ends and for an unknown id", () => {
    expect(moveGroupBy(["a", "b"], "a", -1)).toBeNull();
    expect(moveGroupBy(["a", "b"], "b", 1)).toBeNull();
    expect(moveGroupBy(["a", "b"], "x", 1)).toBeNull();
  });
});

describe("moveGroupTo", () => {
  it("puts a group at the place of another", () => {
    expect(moveGroupTo(["a", "b", "c"], "a", "c")).toEqual(["b", "c", "a"]);
    expect(moveGroupTo(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
  });

  it("returns null when nothing moves", () => {
    expect(moveGroupTo(["a", "b"], "a", "a")).toBeNull();
    expect(moveGroupTo(["a", "b"], "a", "x")).toBeNull();
  });
});
