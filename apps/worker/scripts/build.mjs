// Bundles the worker into dist/band-worker.mjs. The workspace packages
// (@band-app/*) are bundled; every third-party package stays external and is a
// dependency of the published package, so native modules (node-pty, ripgrep)
// install for the machine the worker runs on.
import { readFileSync } from "node:fs";
import { build } from "esbuild";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const external = Object.keys(pkg.dependencies ?? {});

// The worker, and the terminal daemon it launches (a separate process, so a worker restart leaves the shells running).
for (const [entry, outfile] of [
  ["src/main.ts", "dist/band-worker.mjs"],
  ["src/terminal-daemon.ts", "dist/terminal-daemon.mjs"],
]) {
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile,
    external,
    banner: {
      js: "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);",
    },
    logLevel: "info",
  });
}
