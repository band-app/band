#!/usr/bin/env node
// Builds native/build/band-native.node for arm64 and x64 and joins them with lipo. macOS only.
// The addon is optional at runtime, so a missing toolchain is a skipped build, not a failed one.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "build");
const skip = (why) => {
  console.log(`[band-native] skipped: ${why}`);
  process.exit(0);
};

if (process.platform !== "darwin") skip("not macOS");
try {
  execFileSync("clang++", ["--version"], { stdio: "ignore" });
} catch {
  skip("clang++ not found (install the Xcode command line tools)");
}

const require = createRequire(import.meta.url);
let napiDir;
let headers;
try {
  napiDir = dirname(require.resolve("node-addon-api/package.json"));
  headers = join(dirname(require.resolve("node-api-headers/package.json")), "include");
} catch {
  skip("node-addon-api or node-api-headers is not installed");
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const parts = [];
for (const arch of ["arm64", "x86_64"]) {
  const file = join(out, `band-native-${arch}.node`);
  execFileSync(
    "clang++",
    [
      "-std=c++17", "-fobjc-arc", "-fexceptions", "-O2", "-shared",
      "-arch", arch, "-mmacosx-version-min=12.0", "-undefined", "dynamic_lookup",
      "-DNAPI_VERSION=8", "-DNAPI_CPP_EXCEPTIONS",
      `-I${napiDir}`, `-I${headers}`,
      "-framework", "AppKit", "-framework", "QuartzCore",
      "-o", file, join(here, "band-native.mm"),
    ],
    { stdio: "inherit" },
  );
  parts.push(file);
}
const final = join(out, "band-native.node");
execFileSync("lipo", ["-create", ...parts, "-output", final], { stdio: "inherit" });
for (const p of parts) rmSync(p);
console.log(`[band-native] built ${final} (${existsSync(final) ? "ok" : "missing"})`);
