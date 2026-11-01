// Integration tests for "check for updates now" (`workers.checkForUpdates`): an admin asks GitHub
// (an Express stub through BAND_GITHUB_API_URL) at once instead of waiting for the daily check.

import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { type ReleasesStub, startReleasesStub } from "./fixtures/github-releases-stub";
import { seedSettings } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";
import { waitFor } from "./helpers/wait-for";

const ADMIN = "check-now-admin";

interface CheckResult {
  enabled: boolean;
  latest: string | null;
  updateAvailable: boolean;
  checkedAt: number | null;
  error: string | null;
}

let server: ServerHandle | undefined;
let stub: ReleasesStub | undefined;
let home: string | undefined;

async function boot(tag: string, env: Record<string, string> = {}): Promise<ReleasesStub> {
  stub = await startReleasesStub(tag);
  home = createTmpHome("band-release-check-now-");
  seedSettings(home, { tokenSecret: ADMIN });
  server = await startServer({
    tmpHome: home,
    env: { BAND_GITHUB_API_URL: stub.url, ...env },
  });
  return stub;
}

const checkNow = async (token = ADMIN) =>
  trpcData<CheckResult>(await trpcMutate(server?.url ?? "", "workers.checkForUpdates", {}, token));

afterEach(async () => {
  await server?.close();
  await stub?.close();
  if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10 });
  server = undefined;
  stub = undefined;
  home = undefined;
});

describe("check for updates now", () => {
  it("returns a release published after the hub's own check", async () => {
    const s = await boot("v0.55.0");
    await waitFor(() => (s.requests() >= 1 ? true : undefined), { label: "the startup check" });
    s.setLatest("v0.56.0");

    const before = Date.now();
    const result = await checkNow();
    expect(result).toMatchObject({ latest: "0.56.0", updateAvailable: true, error: null });
    expect(result.checkedAt).toBeGreaterThanOrEqual(before);

    // The sidebar badge reads the same answer.
    const status = await trpcData<{ latest: string; updateAvailable: boolean }>(
      await trpcQuery(server?.url ?? "", "workers.updateStatus", undefined, ADMIN),
    );
    expect(status).toMatchObject({ latest: "0.56.0", updateAvailable: true });
  });

  it("sends one GitHub request for two calls within 30 seconds", async () => {
    const s = await boot("v0.56.0");
    await waitFor(() => (s.requests() >= 1 ? true : undefined), { label: "the startup check" });
    const before = s.requests();
    const first = await checkNow();
    const second = await checkNow();
    expect(s.requests()).toBe(before + 1);
    expect(second.checkedAt).toBe(first.checkedAt);
  });

  it("reports a GitHub failure and keeps the earlier answer", async () => {
    const s = await boot("v0.56.0");
    await waitFor(() => (s.requests() >= 1 ? true : undefined), { label: "the startup check" });
    s.failWith(500);
    const result = await checkNow();
    expect(result.error).toContain("500");
    expect(result).toMatchObject({ latest: "0.56.0", updateAvailable: true });
  });

  it("is turned down when the check is off", async () => {
    const s = await boot("v0.56.0", { BAND_UPDATE_CHECK: "off" });
    const result = await checkNow();
    expect(result).toMatchObject({ enabled: false, latest: null, error: null });
    expect(s.requests()).toBe(0);
  });

  it("answers 403 to a non-admin device token", async () => {
    await boot("v0.56.0");
    const created = await trpcData<{ token: string }>(
      await trpcMutate(server?.url ?? "", "tokens.createDevice", { label: "phone" }, ADMIN),
    );
    const res = await trpcMutate(server?.url ?? "", "workers.checkForUpdates", {}, created.token);
    expect(res.status).toBe(403);
  });
});
