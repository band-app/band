/**
 * Custom module loader for `node --experimental-strip-types`.
 *
 * Source files use `.js` import suffixes so the compiled output (under
 * `dist/`) is valid Node ESM. When tests run against the source `.ts` files
 * directly, those `.js` paths don't exist on disk — this loader rewrites them
 * to `.ts` for relative imports inside our source tree.
 *
 * Same pattern as `packages/coding-agent/tests/mock-codex-loader.mjs`. Scoped
 * to `apps/desktop/` so it doesn't accidentally rewrite `.js` files in
 * node_modules or sibling packages.
 */

const SCOPE_PATH = "/apps/desktop/";

/**
 * @param {string} specifier
 * @param {{ parentURL?: string }} context
 * @param {Function} nextResolve
 */
export function resolve(specifier, context, nextResolve) {
  const parentUrl = context.parentURL || "";
  const inOurSource = parentUrl.includes(SCOPE_PATH) && !parentUrl.includes("node_modules");
  if (
    inOurSource &&
    specifier.endsWith(".js") &&
    (specifier.startsWith("./") || specifier.startsWith("../"))
  ) {
    const tsSpecifier = specifier.replace(/\.js$/, ".ts");
    try {
      return nextResolve(tsSpecifier, context);
    } catch {
      // Fall through to original resolution.
    }
  }
  return nextResolve(specifier, context);
}
