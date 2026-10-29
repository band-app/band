import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { slugifyBranchName } from "../src/branch-name.ts";

function isValidRef(name: string): boolean {
  try {
    execFileSync("git", ["check-ref-format", "--branch", name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("keeps the case and the characters git allows", () => {
  for (const name of [
    "feature/EPCNTR-4055",
    "fix/some_thing",
    "release/1.2.3",
    "main",
    "Feat/A-b_c.d",
  ]) {
    assert.equal(slugifyBranchName(name), name);
  }
});

test("turns whitespace into hyphens and removes forbidden characters", () => {
  const cases: Array<[string, string]> = [
    ["Fix Login  redirect!", "Fix-Login-redirect!"],
    ["feat/a..b", "feat/a.b"],
    ["a~b^c:d?e*f[g\\h", "abcdefgh"],
    ["a@{b", "ab"],
    ["name.lock", "name"],
    ["feat/name.lock/x", "feat/name/x"],
    ["/lead/trail/", "lead/trail"],
    [".hidden/.dot.", "hidden/dot"],
    ["a//b", "a/b"],
    ["a\u0001b\u007fc", "abc"],
    ["-dash", "dash"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(slugifyBranchName(input), expected, input);
  }
});

test("every non-empty result passes git check-ref-format", () => {
  for (const input of [
    "Fix Login  redirect!",
    "feat/a..b",
    "a.lock.lock",
    "x/.lock",
    "a.@{.b",
    "@",
    "a/./b",
    "a...b",
    "--weird--",
    "Ünï/cödé",
    "tab\tname",
    "end.",
    "a/b.lock/",
  ]) {
    const out = slugifyBranchName(input);
    if (out) assert.ok(isValidRef(out), `${JSON.stringify(input)} -> ${JSON.stringify(out)}`);
  }
});

test("returns an empty string when nothing is left", () => {
  assert.equal(slugifyBranchName("~^:"), "");
  assert.equal(slugifyBranchName("  "), "");
});
