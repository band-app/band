import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Hello } from "../src/index.ts";
import { makeClient, nextSession, startServer, waitFor } from "./helpers.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe("a resumed session the hub keeps dropping (issue #994, S3)", () => {
  it("starts a fresh session after two short resumed sessions and stays up", async () => {
    const hellos: Hello[] = [];
    const { server, url } = await startServer({
      authenticate: (hello) => {
        hellos.push(hello);
        return { ok: true };
      },
    });
    // The hub drops every resumed session as soon as it is up, the way the loop in #994 looked.
    server.on("connected", (session, resumed: boolean) => {
      if (resumed) session.dropConnection();
    });
    const client = makeClient(url, { stableMs: 2000 });
    cleanups.push(
      () => client.close(),
      () => server.close(),
    );
    const fresh = new Promise<void>((resolve) => client.once("freshSession", resolve));
    const first = nextSession(server);
    await client.connect();
    await first;
    // Cut the first, healthy session once: every hello after it is a resume until the fallback.
    server.getSession("w1")?.dropConnection();
    await fresh;
    await waitFor(
      () => client.session.attached && server.getSession("w1")?.attached === true,
      5000,
      "a fresh session to come up",
    );
    const resumes = hellos.map((h) => h.resume !== undefined);
    // first hello: fresh; then the resumes the hub dropped; the last hello: fresh again.
    assert.equal(resumes[0], false);
    assert.equal(resumes.at(-1), false);
    assert.ok(resumes.slice(1, -1).length >= 2, `resumed ${resumes.slice(1, -1).length} times`);
    assert.ok(resumes.slice(1, -1).every(Boolean));
  });

  it("backs off between redials while sessions keep ending quickly", async () => {
    const { server, url } = await startServer();
    const times: number[] = [];
    server.on("connected", (session) => {
      times.push(Date.now());
      session.dropConnection();
    });
    const client = makeClient(url, {
      reconnect: { minMs: 40, maxMs: 400 },
      stableMs: 5000,
      freshAfterShortResumes: 100,
    });
    cleanups.push(
      () => client.close(),
      () => server.close(),
    );
    await client.connect();
    await waitFor(() => times.length >= 7, 8000, "seven connects");
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    assert.ok(gaps[5] >= 250, `the sixth gap was ${gaps[5]} ms, gaps ${gaps}`);
  });

  it("keeps the link up when a notification handler throws", async () => {
    const { server, url } = await startServer();
    const client = makeClient(url);
    cleanups.push(
      () => client.close(),
      () => server.close(),
    );
    const serverSession = nextSession(server);
    await client.connect();
    const hub = await serverSession;
    const faults: string[] = [];
    hub.on("fault", (r: string) => faults.push(r));
    hub.onNotification("boom", () => {
      throw new Error("bad state");
    });
    client.session.notify("boom", {});
    await waitFor(() => faults.length === 1, 2000, "the fault");
    assert.match(faults[0], /boom handler threw: bad state/);
    assert.equal(hub.attached, true);
    assert.equal(client.session.attached, true);
  });

  it("reports why a dial failed", async () => {
    const { server, url } = await startServer();
    await server.close();
    const client = makeClient(url);
    cleanups.push(() => client.close());
    const reasons: string[] = [];
    client.on("dialFailed", (r: string) => reasons.push(r));
    void client.connect().catch(() => undefined);
    await waitFor(() => reasons.length >= 2, 5000, "two failed dials");
    assert.match(reasons[0], /ECONNREFUSED/);
  });
});
