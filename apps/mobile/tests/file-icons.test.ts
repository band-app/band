import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { agentIconFor } from "@band-app/shared/agent-icons";
import { fileIconSvg, folderIconSvg } from "../src/lib/files/file-icon.ts";
import { FILE_ICON_MAPS, FILE_ICON_SVG } from "../src/lib/files/file-icons.generated.ts";

const generic = FILE_ICON_SVG[FILE_ICON_MAPS.file];
const genericFolder = FILE_ICON_SVG[FILE_ICON_MAPS.folder];

describe("file icons", () => {
  it("gives common names their own icon and an unknown extension the generic file icon", () => {
    for (const name of ["a.tsx", "a.json", "a.md", "package.json", "Dockerfile", "a.png"]) {
      assert.notEqual(fileIconSvg(name), generic, name);
    }
    assert.equal(fileIconSvg("data.zzzunknown"), generic);
    assert.notEqual(fileIconSvg("a.tsx"), fileIconSvg("a.json"));
    assert.notEqual(fileIconSvg("package.json"), fileIconSvg("a.json"));
  });

  it("draws an open folder differently from a closed one", () => {
    assert.notEqual(folderIconSvg("src", true), folderIconSvg("src", false));
    assert.equal(folderIconSvg("zzz-unknown", false), genericFolder);
    assert.notEqual(folderIconSvg("zzz-unknown", true), genericFolder);
  });

  it("ships valid svg strings", () => {
    for (const svg of Object.values(FILE_ICON_SVG)) {
      assert.match(svg, /^<svg[\s\S]*<\/svg>$/);
      assert.doesNotMatch(svg, /<\?xml|<!--/);
      assert.match(svg, /<(path|g|rect|circle|polygon|ellipse)\b/);
    }
  });
});

describe("agent icons", () => {
  it("has a mark for each known agent type and none for others", () => {
    for (const type of ["claude-code", "codex", "opencode", "gemini-cli", "cursor-cli"]) {
      assert.ok(agentIconFor(type)?.paths.length, type);
    }
    assert.equal(agentIconFor("my-custom"), null);
    assert.equal(agentIconFor(undefined), null);
    assert.equal(agentIconFor("constructor"), null);
  });
});
