import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createRunTmp } from "../scripts/run-tmp.ts";

const helper = join(import.meta.dirname, "..", "scripts", "run-tmp.ts");

describe("run temp dir", () => {
  it("removes only its own dir and leaves a sibling run's alone", () => {
    const base = mkdtempSync(join(tmpdir(), "run-tmp-test-"));
    try {
      const a = createRunTmp(base);
      const b = createRunTmp(base);
      assert.notEqual(a.dir, b.dir);
      for (const t of [a, b]) {
        mkdirSync(join(t.dir, "maestro_xctestrunner_xcodebuild_output_1"));
        writeFileSync(join(t.dir, "maestro_xctestrunner_xcodebuild_output_1", "log"), "x");
      }
      a.remove();
      assert.equal(existsSync(a.dir), false);
      assert.equal(
        existsSync(join(b.dir, "maestro_xctestrunner_xcodebuild_output_1", "log")),
        true,
      );
      b.remove();
      assert.deepEqual(readdirSync(base), []);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    it(`removes the dir when the process gets ${signal}`, async () => {
      const base = mkdtempSync(join(tmpdir(), "run-tmp-test-"));
      try {
        const script = `import { createRunTmp, removeOnExit } from ${JSON.stringify(helper)};
const t = createRunTmp(${JSON.stringify(base)});
removeOnExit(t);
console.log(t.dir);
setInterval(() => {}, 1000);`;
        const child = spawn(
          process.execPath,
          ["--experimental-strip-types", "--input-type=module", "-e", script],
          {
            stdio: ["ignore", "pipe", "inherit"],
          },
        );
        const dir = await new Promise<string>((resolve) =>
          child.stdout.once("data", (d: Buffer) => resolve(String(d).trim())),
        );
        assert.equal(existsSync(dir), true);
        const exited = new Promise((resolve) => child.on("exit", resolve));
        child.kill(signal);
        await exited;
        assert.equal(existsSync(dir), false);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });
  }
});
