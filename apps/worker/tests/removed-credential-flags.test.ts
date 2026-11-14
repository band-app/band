import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanup, spawnWorkerProcess, startHub, TOKEN, tmpDir, waitFor } from "./helpers.ts";

// The credential flags and variables a worker profile replaced: a worker that still gets them
// starts as usual and says once that it ignores them.

describe("removed credential flags", () => {
  const dirs: string[] = [];
  after(() => cleanup(...dirs));

  it("connects and logs one line naming what it ignores", async () => {
    const hub = await startHub();
    const root = tmpDir();
    const stateDir = tmpDir("band-worker-state-");
    dirs.push(root, stateDir);
    const connected = hub.nextSession();
    const proc = spawnWorkerProcess(
      [
        "--hub",
        hub.url,
        "--token",
        TOKEN,
        "--root",
        root,
        "--state-dir",
        stateDir,
        "--hub-git-credentials-only",
      ],
      { BAND_WORKER_GH_TOKEN: "hub", BAND_WORKER_HUB_GIT_CREDENTIALS_ONLY: "1" },
    );
    try {
      await connected;
      await waitFor(
        () => proc.output().includes("removed and are ignored"),
        10_000,
        "the log line",
      );
      const lines = proc
        .output()
        .split("\n")
        .filter((l) => l.includes("removed and are ignored"));
      assert.equal(lines.length, 1);
      for (const name of [
        "--hub-git-credentials-only",
        "BAND_WORKER_HUB_GIT_CREDENTIALS_ONLY",
        "BAND_WORKER_GH_TOKEN",
      ]) {
        assert.ok(lines[0].includes(name), `${name} is named`);
      }
    } finally {
      proc.child.kill("SIGTERM");
      await proc.exited;
      await hub.close();
    }
  });
});
