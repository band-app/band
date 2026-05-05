#!/usr/bin/env node

/**
 * Post-build step: drop a `dist/preload/package.json` marker so Node-style
 * loaders treat the compiled preload as CommonJS.
 *
 * Why both this AND the `.cts → .cjs` source extension:
 *   - The `.cjs` file extension is the unambiguous CommonJS marker for
 *     every loader (Node, Electron sandbox bundle resolver). The preload
 *     source is `.cts` so `tsc` emits `.cjs` natively — no rename needed,
 *     which means watch mode (`tsc -w`) keeps working without a postbuild.
 *   - The `package.json` `"type": "commonjs"` is belt-and-suspenders for
 *     any tool (e.g. `node ./dist/preload/preload/index.cjs` directly)
 *     that resolves nearby `package.json` settings.
 */

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distPreload = resolve(__dirname, "..", "dist", "preload");
const pkgPath = resolve(distPreload, "package.json");
writeFileSync(pkgPath, `${JSON.stringify({ type: "commonjs" }, null, 2)}\n`);
