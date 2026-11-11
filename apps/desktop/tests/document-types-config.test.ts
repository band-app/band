/**
 * Finder's "Open With" menu lists Band for text and source files because the packaged Info.plist
 * declares document types. The menu itself is a LaunchServices UI that cannot be automated, so
 * this checks the packaging config that decides whether the entry appears and that Band never
 * becomes the default app.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const builder = readFileSync(join(root, "electron-builder.yml"), "utf8");
const macBlock = builder.slice(builder.search(/^mac:/m));

describe("macOS document types", () => {
  test("Info.plist declares an Editor document type with Alternate rank, under mac.extendInfo", () => {
    assert.match(macBlock, /extendInfo:/);
    assert.match(macBlock, /CFBundleDocumentTypes:/);
    assert.match(macBlock, /CFBundleTypeRole: Editor/);
    assert.match(macBlock, /LSHandlerRank: Alternate/);
  });

  test("it never claims a higher rank, so Band cannot become a default app", () => {
    assert.doesNotMatch(macBlock, /LSHandlerRank: (Owner|Default)/);
  });

  test("it lists the text and source types", () => {
    for (const uti of [
      "public.text",
      "public.source-code",
      "public.json",
      "public.xml",
      "public.shell-script",
      "net.daringfireball.markdown",
    ]) {
      assert.match(macBlock, new RegExp(`- ${uti.replace(/\./g, "\\.")}\\s*$`, "m"), uti);
    }
  });
});

describe("band:// URL scheme", () => {
  test("electron-builder registers the band scheme in Info.plist", () => {
    assert.match(builder, /^protocols:/m);
    assert.match(builder, /^\s+- band\s*$/m);
  });
});
