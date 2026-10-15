import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { filterSkills, getCommandContext, getMentionContext, toWireFile } from "../src/composer.ts";

const skills = [
  { name: "review", description: "Review the diff" },
  { name: "init", description: "Set up the project" },
  { name: "$tdd", description: "Red green refactor" },
  { name: "compact", description: "Free up context by summarizing" },
];

describe("getTriggerContext", () => {
  it("finds a command at the start or after a space", () => {
    assert.deepEqual(getCommandContext("/rev"), { prefix: "", query: "rev" });
    assert.deepEqual(getCommandContext("fix it /re"), { prefix: "fix it ", query: "re" });
  });

  it("ends the token at a space and ignores a slash inside a word", () => {
    assert.equal(getCommandContext("/review now"), null);
    assert.equal(getCommandContext("src/app"), null);
    assert.equal(getCommandContext("no trigger"), null);
  });

  it("finds a file mention", () => {
    assert.deepEqual(getMentionContext("look at @src/ap"), { prefix: "look at ", query: "src/ap" });
    assert.equal(getMentionContext("mail a@b.c"), null);
  });
});

describe("filterSkills", () => {
  it("returns every command for an empty query", () => {
    assert.equal(filterSkills(skills, "").length, 4);
  });

  it("ranks exact, prefix, substring, then description", () => {
    assert.deepEqual(
      filterSkills(skills, "tdd").map((s) => s.name),
      ["$tdd"],
    );
    assert.deepEqual(
      filterSkills(skills, "i").map((s) => s.name),
      ["init", "review"],
    );
    assert.deepEqual(
      filterSkills(skills, "summar").map((s) => s.name),
      ["compact"],
    );
  });
});

describe("toWireFile", () => {
  it("builds the data URL the hub takes", () => {
    assert.deepEqual(toWireFile("image/png", "AAAA", "a.png"), {
      mediaType: "image/png",
      url: "data:image/png;base64,AAAA",
      filename: "a.png",
    });
    assert.equal("filename" in toWireFile("image/png", "AAAA"), false);
  });
});
