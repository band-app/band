import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { RotatingFile } from "@band-app/logger";

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "band-log-"));
  dirs.push(dir);
  return dir;
}

describe("worker log rotation", () => {
  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("rotates a file that is over the limit when the writer opens, keeping 3 files", () => {
    const dir = tmp();
    const log = join(dir, "worker.log");
    writeFileSync(log, "x".repeat(2000));
    const file = new RotatingFile(log, 1000, 3);
    file.write("fresh\n");
    file.close();
    assert.equal(statSync(`${log}.1`).size, 2000);
    assert.equal(statSync(log).size, "fresh\n".length);
  });

  it("rotates while running and never keeps more than 3 files", () => {
    const dir = tmp();
    const log = join(dir, "worker.log");
    const file = new RotatingFile(log, 100, 3);
    for (let i = 0; i < 50; i++) file.write(`${String(i).padStart(2, "0")}${"y".repeat(28)}\n`);
    file.close();
    assert.deepEqual(readdirSync(dir).sort(), ["worker.log", "worker.log.1", "worker.log.2"]);
    for (const f of readdirSync(dir)) assert.ok(statSync(join(dir, f)).size <= 100);
    assert.ok(!existsSync(`${log}.3`));
  });

  it("makes the logger write and rotate a file when BAND_LOG_FILE is set", () => {
    const dir = tmp();
    const log = join(dir, "worker.log");
    writeFileSync(log, "old".repeat(1000));
    const logger = fileURLToPath(new URL("../../../packages/logger/src/index.ts", import.meta.url));
    const script = `import { createLogger } from ${JSON.stringify(logger)};
      const l = createLogger("t");
      for (let i = 0; i < 200; i++) l.info({ i }, "line " + "z".repeat(40));
      process.stdout.write("plain stdout\\n");`;
    const res = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
        env: { ...process.env, BAND_LOG_FILE: log, BAND_LOG_MAX_BYTES: "4000", BAND_LOG_KEEP: "3" },
        encoding: "utf8",
        cwd: fileURLToPath(new URL("..", import.meta.url)),
      },
    );
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, "", "nothing reaches stdout, so launchd has nothing to keep");
    const files = readdirSync(dir).sort();
    assert.deepEqual(files, ["worker.log", "worker.log.1", "worker.log.2"]);
    for (const f of files) assert.ok(statSync(join(dir, f)).size <= 4000);
  });
});
