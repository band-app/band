import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { HostInfo } from "@band-app/host-api";
import { PROTOCOL_VERSION } from "@band-app/link";
import { call, cleanup, startHub, startWorker, type TestHub, type TestWorker } from "./helpers.ts";

// S1: the worker dials a real link server, says hello with what it has, and gets ready.
describe("handshake", () => {
  let hub: TestHub;
  let w: TestWorker;

  before(async () => {
    hub = await startHub();
    w = await startWorker(hub, { args: ["--name", "box", "--labels", "gpu=1,zone=home"] });
  });
  after(async () => {
    await w.worker.stop();
    await hub.close();
    cleanup(w.root, w.stateDir);
  });

  it("sends a hello with its roots, agents, capabilities and labels", () => {
    const { hello } = w.session;
    assert.equal(hello.protocol, PROTOCOL_VERSION);
    assert.equal(hello.mode, "attached");
    assert.equal(hello.workerId, w.worker.workerId);
    assert.match(hello.workerId, /^w-[0-9a-f]{12}$/);
    assert.deepEqual(hello.roots, [w.root]);
    assert.deepEqual(hello.labels, { gpu: "1", zone: "home", name: "box" });
    for (const cap of ["git", "pty", "acp", "search", "lsp", "fsWatch"]) {
      assert.ok(hello.capabilities.includes(cap), `capability ${cap}`);
    }
    // The scripted ACP stub resolves for every agent type.
    assert.deepEqual([...hello.agents].sort(), [
      "claude-code",
      "codex",
      "cursor-cli",
      "gemini-cli",
      "opencode",
    ]);
    assert.match(hello.buildId, /^band-worker@/);
  });

  it("answers host.info with the same roots and labels", async () => {
    const info = await call<HostInfo>(w.session, "host.info");
    assert.deepEqual(info.roots, [w.root]);
    assert.deepEqual([...info.labels].sort(), ["gpu=1", "name=box", "zone=home"]);
    assert.equal(info.os, process.platform);
    assert.equal(info.capabilities.pty, true);
  });

  it("keeps its worker id across restarts", async () => {
    const first = w.worker.workerId;
    await w.worker.stop();
    const again = await startWorker(hub, { root: w.root, stateDir: w.stateDir });
    try {
      assert.equal(again.worker.workerId, first);
      assert.equal(again.session.hello.workerId, first);
    } finally {
      await again.worker.stop();
    }
  });
});
