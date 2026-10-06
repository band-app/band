// `hosts.list` derives the local host's `gh` capability from `gh --version`. The hub runs that
// probe once per host and keeps the answer, so repeated `hosts.list` calls (the UI makes one on
// every load) start no `gh` process. Real hub (production bundle, random port, auth on, temp
// dirs only) with the fake `gh` (`fixtures/gh-stub.ts`) recording each invocation.

import { afterAll, beforeAll, expect, it } from "vitest";
import { type GhStub, ghStub } from "./fixtures/gh-stub";
import { seedSettings } from "./helpers/seed-state";
import { createTmpHome, type ServerHandle, startServer, trpcQuery } from "./helpers/server";
import { removeTmpHome } from "./helpers/tmp-home";

const TOKEN = "host-info-probe-cache-secret";

let tmpHome: string;
let server: ServerHandle;
let stub: GhStub;

beforeAll(async () => {
  tmpHome = createTmpHome("host-info-probe-cache-");
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  stub = await ghStub.start();
  server = await startServer({ tmpHome, env: stub.env });
});

afterAll(async () => {
  await server?.close();
  await stub?.stop();
  removeTmpHome(tmpHome);
});

const versionProbes = () =>
  stub.requests.filter((r) => r.args.length === 1 && r.args[0] === "--version").length;

const hostsList = async () => {
  const res = await trpcQuery(server.url, "hosts.list", undefined, TOKEN);
  expect(res.status).toBe(200);
};

it("probes gh --version once per host, however many hosts.list calls come, even at once", async () => {
  // Five concurrent first calls share one probe. The count includes any worker host that the
  // test mode (BAND_TEST_HOST=remote-loopback) runs, which probes on its own, so the check is
  // that more calls add none, not an absolute number.
  await Promise.all(Array.from({ length: 5 }, hostsList));
  const afterFirst = versionProbes();
  expect(afterFirst).toBeGreaterThanOrEqual(1);
  for (let i = 0; i < 3; i++) await hostsList();
  expect(versionProbes()).toBe(afterFirst);
  expect(stub.requests).toHaveLength(afterFirst);
});

it("answers 401 to hosts.list without a token and starts no gh process", async () => {
  const before = stub.requests.length;
  const res = await trpcQuery(server.url, "hosts.list", undefined);
  expect(res.status).toBe(401);
  expect(stub.requests).toHaveLength(before);
});
