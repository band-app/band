/**
 * Voice dictation records with `getUserMedia` in the app's renderer, which macOS allows only when
 * the signed app has the audio-input entitlement and an `NSMicrophoneUsageDescription`. A TCC
 * prompt cannot be automated, so this checks the packaging config that decides whether it appears.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entitlements = readFileSync(join(root, "build", "entitlements.mac.plist"), "utf8");
const builder = readFileSync(join(root, "electron-builder.yml"), "utf8");

describe("macOS microphone access", () => {
  test("the entitlements allow audio input, for the app and its helper processes", () => {
    assert.match(entitlements, /<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\/>/);
    assert.match(builder, /^\s+entitlements: build\/entitlements\.mac\.plist$/m);
    assert.match(builder, /^\s+entitlementsInherit: build\/entitlements\.mac\.plist$/m);
  });

  test("Info.plist carries a usage description that names what the audio is for", () => {
    const match = builder.match(/^\s+NSMicrophoneUsageDescription: (.+)$/m);
    assert.ok(match, "mac.extendInfo must set NSMicrophoneUsageDescription");
    assert.ok(match[1].length > 20, "the usage description must explain the use");
    assert.match(match[1], /dictat/i);
    // It sits under the mac block, not at the top level where electron-builder ignores it.
    const macBlock = builder.slice(builder.search(/^mac:/m));
    assert.ok(macBlock.includes("NSMicrophoneUsageDescription"));
    assert.match(macBlock, /extendInfo:/);
  });
});
