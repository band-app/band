// `hosts.list` derives the local host's `gh` capability from `gh --version`. The hub runs that
// probe once per host and keeps the answer, so repeated `hosts.list` calls (the UI makes one on
// every load) start no `gh` process. Real hub (production bundle, random port, auth on, temp
// dirs only) with the fake `gh` (`fixtures/gh-stub.ts`) recording each invocation.

import { afterAll, beforeAll, expect, it } from "vitest";
import { type GhStub, ghStub } from "./fixtures/gh-stub";
import { seedSettings } from "./helpers/seed-state";
import { createTmpHome, type ServerHandle, startServer, trpcQuery } from "./helpers/server";
import { removeTmpHome } from "./helpers/tmp-home";
import { waitFor } from "./helpers/wait-for";

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
  stub.requests.filter((r) => r.args.length === 1 && r.args[0] === "--version");

it("probes gh --version once, however many times hosts.list is called", async () => {
  for (let i = 0; i < 3; i++) {
    const res = await trpcQuery(server.url, "hosts.list", undefined, TOKEN);
    expect(res.status).toBe(200);
  }
  await waitFor(async () => versionProbes().length >= 1);
  expect(versionProbes()).toHaveLength(1);
  expect(stub.requests).toHaveLength(1);
});

it("answers 401 to hosts.list without a token and starts no gh process", async () => {
  const before = stub.requests.length;
  const res = await trpcQuery(server.url, "hosts.list", undefined);
  expect(res.status).toBe(401);
  expect(stub.requests).toHaveLength(before);
});
