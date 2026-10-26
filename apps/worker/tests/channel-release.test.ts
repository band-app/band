import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { RemoteHost } from "@band-app/host-remote";
import {
  cleanup,
  startHub,
  startWorker,
  type TestHub,
  type TestWorker,
  waitFor,
} from "./helpers.ts";

// Every channel kind a worker's link opens must leave both sessions' maps when its work ends. The
// worker has a 1024 channel cap, and a kind that leaks fills it in under an hour.
describe("link channels are released", () => {
  let hub: TestHub;
  let w: TestWorker;
  let host: RemoteHost;

  // Both sessions hold every channel until both sides finish, so the hub's count shows a leak on either.
  const count = () => w.session.openChannelCount;
  const settled = (baseline: number, what: string) =>
    waitFor(
      () => count() <= baseline,
      10_000,
      `${what}: channels to return to ${baseline}, now ${JSON.stringify(w.session.channelCounts())}`,
    );

  before(async () => {
    hub = await startHub();
    let workerId = "";
    host = new RemoteHost({ id: "release", session: () => hub.server.getSession(workerId) });
    hub.server.on("session", (session) => host.attachSession(session));
    w = await startWorker(hub);
    workerId = w.worker.workerId;
  });
  after(async () => {
    await w.worker.stop();
    await hub.close();
    cleanup(w.root, w.stateDir);
  });

  it("releases a terminal channel whose viewer detaches while output is flowing", async () => {
    await host.pty.spawn({
      worktreeId: "ws",
      terminalId: "busy",
      worktreeRoot: w.root,
      options: { command: "while true; do echo tick; sleep 0.01; done" },
    } as never);
    const baseline = count();
    for (let i = 0; i < 2000; i++) {
      const attachment = await host.pty.attach("busy", { cols: 80, rows: 24 });
      assert.ok(attachment);
      attachment.start(() => undefined);
      // Detach while the shell is still writing, so a chunk is in flight.
      if (i % 3 === 0) await new Promise((r) => setTimeout(r, 15));
      attachment.detach();
    }
    await settled(baseline, "pty attach and detach");
    await host.pty.kill("busy");
  });

  it("releases result, read, write, watch and search channels", async () => {
    const big = join(w.root, "big.bin");
    writeFileSync(big, Buffer.alloc(300 * 1024, "x"));
    writeFileSync(join(w.root, "a.txt"), "needle\n");
    const baseline = count();
    for (let i = 0; i < 300; i++) {
      // a result channel, read to the end
      await host.fs.readFile(big);
      // a read stream the consumer abandons after one chunk
      for await (const _chunk of host.fs.readStream(big)) break;
      // a write channel
      await host.fs.writeFile(join(w.root, "out.bin"), Buffer.alloc(100 * 1024, "y"));
      // a watch that is aborted
      const abort = new AbortController();
      const watch = host.fs.watch(w.root, { recursive: true, signal: abort.signal });
      const next = watch[Symbol.asyncIterator]().next();
      writeFileSync(join(w.root, `w${i}.txt`), "x");
      await Promise.race([next, new Promise((r) => setTimeout(r, 50))]);
      abort.abort();
      await next.catch(() => undefined);
      // a search consumer that leaves early
      for await (const _m of host.search.stream({ query: "needle" }, w.root)) break;
    }
    await settled(baseline, "fs and search channels");
  });

  it("releases the stdio and stderr channels of an agent that is spawned and killed", async () => {
    const launch = await host.acp.resolveLaunch({ type: "claude-code" });
    assert.notEqual(typeof launch, "string", "the suite needs an agent it can start");
    if (typeof launch === "string") return;
    const baseline = count();
    for (let i = 0; i < 300; i++) {
      const agent = await host.acp.spawn(launch, w.root);
      agent.stdin.write("{}\n");
      for (const stream of [agent.stdout, agent.stderr]) {
        void (async () => {
          for await (const _chunk of stream) {
            // drain
          }
        })().catch(() => undefined);
      }
      agent.kill();
      await agent.exit;
    }
    await settled(baseline, "agent spawn and kill");
  });

  it("releases a language server connection opened and closed", async () => {
    const baseline = count();
    for (let i = 0; i < 100; i++) {
      const connection = await host.lsp.connect({
        worktreeId: "release-lsp",
        lang: "typescript",
        root: w.root,
      });
      connection.close();
    }
    await host.lsp.killWorktree("release-lsp");
    await settled(baseline, "lsp connect and close");
  });
});
