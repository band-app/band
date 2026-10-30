#!/usr/bin/env node
// Prints the macOS test subset for one package, as paths relative to that package.
//   node scripts/macos-tests.mjs hub|worker|host-local
// The list lives in scripts/macos-tests.json.
import { readFileSync } from "node:fs";

const dirs = { hub: "apps/hub/", worker: "apps/worker/", "host-local": "packages/host-local/" };
const prefix = dirs[process.argv[2] ?? ""];
if (!prefix) {
  console.error("usage: macos-tests.mjs hub|worker|host-local");
  process.exit(2);
}
const { subset } = JSON.parse(readFileSync(new URL("./macos-tests.json", import.meta.url), "utf8"));
for (const file of Object.keys(subset)) {
  if (file.startsWith(prefix)) console.log(file.slice(prefix.length));
}
