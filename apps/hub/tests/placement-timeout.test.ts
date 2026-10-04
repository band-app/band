// A host request nobody fulfils fails with a reason once BAND_PLACEMENT_TIMEOUT_MS
// passes (plan step 3.3, S4). Real hub, temp BAND_HOME, no worker.

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";
import { waitFor } from "./helpers/wait-for";

const TOKEN = "placement-timeout-secret";

interface HostRequest {
  id: string;
  status: string;
  error: string | null;
}

let home: string;
let repo: string;
let server: ServerHandle;

const q = async <T>(procedure: string) =>
  trpcData<T>(await trpcQuery(server.url, procedure, undefined, TOKEN));
const m = async <T>(procedure: string, input: unknown) =>
  trpcData<T>(await trpcMutate(server.url, procedure, input, TOKEN));
const requests = async () => (await q<{ requests: HostRequest[] }>("hostRequests.list")).requests;

beforeAll(async () => {
  home = createTmpHome("band-place-timeout-");
  repo = join(home, "proj");
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
    });
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  seedSettings(home, { tokenSecret: TOKEN });
  seedState(home, {
    projects: [
      {
        name: "proj",
        path: repo,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: repo }],
      },
    ],
  });
  server = await startServer({ tmpHome: home, env: { BAND_PLACEMENT_TIMEOUT_MS: "1500" } });
}, 120_000);

afterAll(async () => {
  await server?.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 10 });
});

describe("a host request that nobody meets", () => {
  it("fails with a reason after the timeout, and can be dismissed (S4)", async () => {
    const created = await m<{ provisioning: { requestId: string } }>("workspaces.create", {
      project: "proj",
      branch: "stuck",
      placement: { labels: { zone: "moon" } },
    });
    const { requestId } = created.provisioning;
    expect((await requests()).find((r) => r.id === requestId)?.status).toBe("pending");

    const failed = await waitFor(
      async () => {
        const r = (await requests()).find((x) => x.id === requestId);
        return r?.status === "failed" ? r : undefined;
      },
      { label: "request times out", timeoutMs: 15_000 },
    );
    expect(failed.error).toMatch(/No host matched the placement within \d+s/);

    // A failed request can no longer be leased, and dismissing it removes it from the list.
    const lease = await m<{ request: unknown }>("hostRequests.lease", { runnerId: "r" });
    expect(lease.request).toBeNull();
    await m("hostRequests.cancel", { requestId });
    expect((await requests()).find((r) => r.id === requestId)).toBeUndefined();

    // The workspace was never created, so the branch can be asked for again.
    const again = await m<{ provisioning?: { requestId: string } }>("workspaces.create", {
      project: "proj",
      branch: "stuck",
      placement: { labels: { zone: "moon" } },
    });
    expect(again.provisioning?.requestId).not.toBe(requestId);
  });
});
