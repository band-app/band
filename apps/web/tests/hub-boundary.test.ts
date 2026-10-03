// The UI and the hub ship separately, so the UI may take only the router's
// type from the hub (for the tRPC client). A value import would pull hub
// code, and its native modules, into the browser bundle.
//
// Scans the UI sources (`src/`) and `vite.config.ts` for any import of
// `@band-app/server`, or a relative path into `apps/hub`, that isn't
// `import type`. Playwright specs in `e2e/` are not scanned: they run in
// Node and reuse the hub's Express stubs and server helpers from
// `apps/hub/tests/`.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const WEB_ROOT = join(import.meta.dirname, "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

/** Specifier of every static, dynamic or re-export that isn't `import type`. */
function valueImportsOfHub(source: string): string[] {
  const found: string[] = [];
  const statement =
    /(?:^|\n)\s*(import|export)(\s+type\b)?[^;]*?\bfrom\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)|(?:^|\n)\s*import\s+["']([^"']+)["']/g;
  for (const match of source.matchAll(statement)) {
    const isTypeOnly = Boolean(match[2]);
    const specifier = match[3] ?? match[4] ?? match[5];
    if (isTypeOnly || !specifier) continue;
    if (specifier === "@band-app/server" || specifier.startsWith("@band-app/server/")) {
      found.push(specifier);
    } else if (/(^|\/)hub\/(src|start-server|auth|terminal-daemon)/.test(specifier)) {
      found.push(specifier);
    }
  }
  return found;
}

describe("UI to hub boundary", () => {
  it("imports nothing at runtime from the hub", () => {
    const files = [...sourceFiles(join(WEB_ROOT, "src")), join(WEB_ROOT, "vite.config.ts")];
    const offenders = files.flatMap((file) =>
      valueImportsOfHub(readFileSync(file, "utf8")).map(
        (specifier) => `${file.slice(WEB_ROOT.length + 1)} imports ${specifier}`,
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("flags a value import and lets a type import through", () => {
    expect(valueImportsOfHub('import { appRouter } from "@band-app/server";')).toEqual([
      "@band-app/server",
    ]);
    expect(valueImportsOfHub('import type { AppRouter } from "@band-app/server";')).toEqual([]);
    expect(valueImportsOfHub('export { x } from "../../hub/src/server/x";')).toEqual([
      "../../hub/src/server/x",
    ]);
    expect(valueImportsOfHub('const m = await import("@band-app/server");')).toEqual([
      "@band-app/server",
    ]);
  });
});
