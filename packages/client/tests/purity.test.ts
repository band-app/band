/**
 * `@band-app/client` runs in React Native as well as the browser, so its
 * sources and dependencies must not reach for a DOM, React or a platform
 * global. The test fails when one is added.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const ROOT = join(import.meta.dirname, "..");
const BANNED_DEPENDENCIES = /^(react|react-dom|react-native|expo|dockview)(\/|$)/;
const BANNED_GLOBALS = /\b(window|document|localStorage|sessionStorage|EventSource)\b/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

/** Source text with comments removed, so prose may mention a banned word. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("@band-app/client purity", () => {
  it("lists no UI or platform package as a dependency", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const names = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ];
    assert.deepEqual(
      names.filter((n) => BANNED_DEPENDENCIES.test(n)),
      [],
    );
  });

  it("imports no UI or platform package and names no DOM global in src/", () => {
    const offenders: string[] = [];
    for (const file of sources(join(ROOT, "src"))) {
      const text = code(file);
      for (const m of text.matchAll(/from\s+["']([^"']+)["']/g)) {
        if (BANNED_DEPENDENCIES.test(m[1] ?? "")) offenders.push(`${file}: imports ${m[1]}`);
      }
      const global = BANNED_GLOBALS.exec(text);
      if (global) offenders.push(`${file}: uses ${global[0]}`);
    }
    assert.deepEqual(offenders, []);
  });

  it("takes only the router type from the hub", () => {
    const offenders: string[] = [];
    for (const file of sources(join(ROOT, "src"))) {
      for (const m of code(file).matchAll(
        /(?:^|\n)\s*import(\s+type)?[^;]*?from\s+["'](@band-app\/server[^"']*)["']/g,
      )) {
        if (!m[1]) offenders.push(`${file}: value import of ${m[2]}`);
      }
    }
    assert.deepEqual(offenders, []);
  });
});
