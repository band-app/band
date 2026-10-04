import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { RpcError, RpcTimeoutError } from "../src/index.ts";
import { makeClient, nextSession, startServer, waitFor } from "./helpers.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function connected() {
  const { server, url } = await startServer();
  const client = makeClient(url);
  cleanups.push(
    () => client.close(),
    () => server.close(),
  );
  const serverSession = nextSession(server);
  await client.connect();
  return { server, client, hub: await serverSession, worker: client.session };
}

describe("JSON-RPC (S2)", () => {
  it("returns results in both directions", async () => {
    const { hub, worker } = await connected();
    hub.handle("fs.read", (p) => ({ echoed: p }));
    worker.handle("git.status", async () => "clean");
    assert.deepEqual(await worker.request("fs.read", { path: "/a" }), { echoed: { path: "/a" } });
    assert.equal(await hub.request("git.status"), "clean");
  });

  it("carries errors, including unknown methods", async () => {
    const { hub, worker } = await connected();
    hub.handle("boom", () => {
      throw new RpcError(4001, "nope", { why: "test" });
    });
    hub.handle("crash", () => {
      throw new Error("kaput");
    });
    await assert.rejects(
      worker.request("boom"),
      (e: RpcError) =>
        e.code === 4001 && e.message === "nope" && (e.data as { why: string }).why === "test",
    );
    await assert.rejects(
      worker.request("crash"),
      (e: RpcError) => e.code === -32603 && e.message === "kaput",
    );
    await assert.rejects(worker.request("missing"), (e: RpcError) => e.code === -32601);
  });

  it("times out, tells the callee to stop, and ignores the late answer", async () => {
    const { hub, worker } = await connected();
    let aborted = false;
    hub.handle("slow", (_p, { signal }) => {
      return new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          resolve("late");
        });
      });
    });
    await assert.rejects(worker.request("slow", undefined, { timeoutMs: 50 }), RpcTimeoutError);
    await waitFor(() => aborted, 2000, "callee abort");
    hub.handle("ok", () => 1);
    assert.equal(await worker.request("ok"), 1);
  });

  it("cancels through an AbortSignal", async () => {
    const { hub, worker } = await connected();
    let aborted = false;
    hub.handle(
      "slow",
      (_p, { signal }) =>
        new Promise(() => signal.addEventListener("abort", () => (aborted = true))),
    );
    const ac = new AbortController();
    const call = worker.request("slow", undefined, { signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    await assert.rejects(call, (e: RpcError) => e.code === -32800);
    await waitFor(() => aborted, 2000, "callee abort");
    await assert.rejects(
      worker.request("slow", undefined, { signal: AbortSignal.abort() }),
      (e: RpcError) => e.code === -32800,
    );
  });

  it("delivers notifications", async () => {
    const { hub, worker } = await connected();
    const got: unknown[] = [];
    hub.onNotification("worker.event", (p) => got.push(p));
    worker.notify("worker.event", { n: 1 });
    await waitFor(() => got.length === 1);
    assert.deepEqual(got, [{ n: 1 }]);
  });

  it("fails pending calls when the socket drops", async () => {
    const { hub, worker } = await connected();
    hub.handle("hang", () => new Promise(() => {}));
    const call = worker.request("hang");
    await new Promise((r) => setTimeout(r, 30));
    hub.dropConnection();
    await assert.rejects(call, /link dropped/);
  });
});
