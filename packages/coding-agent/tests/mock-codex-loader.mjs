/**
 * Custom Node.js module loader hook for tests.
 *
 * 1. Redirects `@openai/codex-sdk` imports to the local mock module.
 * 2. Rewrites `.js` extensions to `.ts` so TypeScript sources resolve
 *    correctly when using --experimental-strip-types.
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const mockUrl = pathToFileURL(join(__dirname, "mocks", "codex-sdk.mjs")).href;

/**
 * @param {string} specifier
 * @param {object} context
 * @param {Function} nextResolve
 */
export function resolve(specifier, context, nextResolve) {
  // 1. Intercept @openai/codex-sdk
  if (specifier === "@openai/codex-sdk" || specifier.endsWith("codex-sdk")) {
    return { url: mockUrl, shortCircuit: true };
  }

  // 2. Rewrite .js → .ts for relative imports within our source tree only.
  //    Skip anything inside node_modules.
  const parentUrl = context.parentURL || "";
  const inOurSource = parentUrl.includes("/packages/coding-agent/") && !parentUrl.includes("node_modules");
  if (
    inOurSource &&
    specifier.endsWith(".js") &&
    (specifier.startsWith("./") || specifier.startsWith("../"))
  ) {
    const tsSpecifier = specifier.replace(/\.js$/, ".ts");
    try {
      return nextResolve(tsSpecifier, context);
    } catch {
      // Fall through to original resolution
    }
  }

  return nextResolve(specifier, context);
}
