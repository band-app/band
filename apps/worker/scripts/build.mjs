// Bundles the worker into dist/band-worker.mjs. The workspace packages
// (@band-app/*) are bundled; every third-party package stays external and is a
// dependency of the published package, so native modules (node-pty, ripgrep)
// install for the machine the worker runs on.
import { readFileSync } from "node:fs";
import { build } from "esbuild";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const external = Object.keys(pkg.dependencies ?? {});

await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "dist/band-worker.mjs",
  external,
  banner: {
    js: "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);",
  },
  logLevel: "info",
});
