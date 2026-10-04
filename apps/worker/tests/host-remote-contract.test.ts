import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { runHostContract } from "@band-app/host-api/contract";
import { RemoteHost } from "@band-app/host-remote";
import { cleanup, startHub, startWorker, type TestHub, type TestWorker } from "./helpers.ts";

// The host contract suite that LocalHost passes, run against RemoteHost over a
// loopback link to a real in-process worker (plan step 2.3). Every call goes
// through the worker's path policy, so the suite also shows the policy admits
// everything a workspace needs inside the root.
let hub: TestHub;
let w: TestWorker;

runHostContract("RemoteHost over a loopback link", {
  api: { describe, it, beforeAll: before, afterAll: after },
  async create() {
    hub = await startHub();
    let workerId = "";
    const host = new RemoteHost({
      id: "remote-loopback",
      session: () => hub.server.getSession(workerId),
    });
    hub.server.on("session", (session) => host.attachSession(session));
    w = await startWorker(hub);
    workerId = w.worker.workerId;
    const workDir = join(w.root, "contract");
    await mkdir(workDir);
    return {
      host,
      workDir,
      async dispose() {
        await w.worker.stop();
        await hub.close();
        cleanup(w.root, w.stateDir);
      },
    };
  },
});
