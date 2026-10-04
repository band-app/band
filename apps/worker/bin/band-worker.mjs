#!/usr/bin/env node
// The published package ships the bundle in dist/. A repo checkout has src/
// and runs it through tsx like the other workspace packages, unless
// BAND_WORKER_USE_DIST=1 asks for the bundle.
import { existsSync } from "node:fs";

const bundle = new URL("../dist/band-worker.mjs", import.meta.url);
const hasSource = existsSync(new URL("../src/main.ts", import.meta.url));

if (existsSync(bundle) && (!hasSource || process.env.BAND_WORKER_USE_DIST === "1")) {
  await import(bundle.href);
} else {
  const { register } = await import("tsx/esm/api");
  register();
  await import("../src/main.ts");
}
