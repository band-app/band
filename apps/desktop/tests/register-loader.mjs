/**
 * Test loader: registered via `node --import ./tests/register-loader.mjs`.
 * Delegates to `./loader.mjs` which rewrites `.js` import suffixes to `.ts`
 * so source files resolve under `--experimental-strip-types`.
 *
 * Same pattern as `packages/coding-agent/tests/register-mock-loader.mjs`.
 */
import { register } from "node:module";
register("./loader.mjs", import.meta.url);
