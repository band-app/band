import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

// `--pin` rewrites the optionalDependencies of the worker and the hub. The script finds both by
// its own location, so the test copies it into a throwaway layout.
describe("cli-packages --pin", () => {
  const root = mkdtempSync(join(tmpdir(), "band-cli-packages-"));
  after(() => rmSync(root, { recursive: true, force: true }));

  it("pins every platform package in the worker and hub package.json", () => {
    mkdirSync(join(root, "apps", "worker", "scripts"), { recursive: true });
    mkdirSync(join(root, "apps", "hub"), { recursive: true });
    copyFileSync(
      join(import.meta.dirname, "..", "scripts", "cli-packages.mjs"),
      join(root, "apps", "worker", "scripts", "cli-packages.mjs"),
    );
    writeFileSync(join(root, "apps", "worker", "package.json"), '{"name":"w"}');
    writeFileSync(join(root, "apps", "hub", "package.json"), '{"name":"h"}');
    const bin = join(root, "band");
    writeFileSync(bin, "#!/bin/sh\n");
    const args = ["--version", "1.2.3", "--out", join(root, "out"), "--pin"];
    for (const key of ["darwin-arm64", "linux-x64", "linux-arm64"])
      args.push("--binary", `${key}=${bin}`);
    execFileSync(process.execPath, [
      join(root, "apps", "worker", "scripts", "cli-packages.mjs"),
      ...args,
    ]);
    for (const app of ["worker", "hub"]) {
      const pkg = JSON.parse(readFileSync(join(root, "apps", app, "package.json"), "utf8"));
      assert.deepEqual(pkg.optionalDependencies, {
        "@band-app/worker-cli-darwin-arm64": "1.2.3",
        "@band-app/worker-cli-linux-x64": "1.2.3",
        "@band-app/worker-cli-linux-arm64": "1.2.3",
      });
    }
  });
});
