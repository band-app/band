import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  REPO_AVATAR_COLOR_COUNT,
  repoAvatarColorIndex,
  repoAvatarInitial,
} from "../src/repo-avatar.ts";

describe("repoAvatarInitial", () => {
  it("is the upper-cased first letter", () => {
    assert.equal(repoAvatarInitial("band"), "B");
    assert.equal(repoAvatarInitial("épic"), "É");
  });

  it("skips leading punctuation and falls back to ? for none", () => {
    assert.equal(repoAvatarInitial("-_.dots"), "D");
    assert.equal(repoAvatarInitial("42-things"), "4");
    assert.equal(repoAvatarInitial("---"), "?");
    assert.equal(repoAvatarInitial(""), "?");
  });
});

describe("repoAvatarColorIndex", () => {
  it("is stable and in range", () => {
    for (const name of ["band", "notes-kb", "borko", "x", "", "日本語"]) {
      const index = repoAvatarColorIndex(name);
      assert.equal(index, repoAvatarColorIndex(name));
      assert.ok(Number.isInteger(index) && index >= 0 && index < REPO_AVATAR_COLOR_COUNT);
    }
  });

  it("pins known values so web and mobile never drift", () => {
    assert.equal(repoAvatarColorIndex("band"), 3);
    assert.equal(repoAvatarColorIndex("borko"), 1);
  });

  it("spreads different names over more than one colour", () => {
    const seen = new Set(["a", "b", "c", "d", "e", "f", "g"].map(repoAvatarColorIndex));
    assert.ok(seen.size > 1);
  });
});
