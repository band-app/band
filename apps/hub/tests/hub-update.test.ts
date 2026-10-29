// Integration tests for the Update hub button (hub-update S2 to S4): an admin-set command runs
// detached on the hub's machine with the target version in its env, the status follows it, and
// only an admin token can set or start it. The command is a stub script that records its env.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

const TOKEN = "hub-update-token";

interface Status {
  updateAvailable: boolean;
  hubUpdate: { configured: boolean; state: string; target: string | null; error: string | null };
}

let server: ServerHandle | undefined;
let stub: ReleasesStub | undefined;
let home: string | undefined;

async function boot(command: string | null, env: Record<string, string> = {}): Promise<string> {
  stub = await startReleasesStub("v9.0.0");
  home = createTmpHome("band-hub-update-");
  const record = join(home, "ran.json");
  const script = join(home, "update.sh");
  writeFileSync(script, command ?? "", { mode: 0o755 });
  seedSettings(home, {
    tokenSecret: TOKEN,
    ...(command === null ? {} : { hubUpdate: { command: `sh ${script} ${record}` } }),
  });
  // No loopback worker: the one the remote-loopback CI job adds runs this checkout's version,
  // which a hub told to report 0.50.0 correctly refuses.
  server = await startServer({
    tmpHome: home,
    env: { BAND_GITHUB_API_URL: stub.url, BAND_HUB_VERSION: "0.50.0", ...env },
    remoteHost: false,
  });
  await waitFor(async () => ((await status()).updateAvailable ? true : undefined), {
    label: "the release check",
  });
  return record;
}

async function status(token = TOKEN): Promise<Status> {
  return trpcData<Status>(
    await trpcQuery(server?.url ?? "", "workers.updateStatus", undefined, token),
  );
}

const mutate = (proc: string, input: unknown = {}, token = TOKEN) =>
  trpcMutate(server?.url ?? "", proc, input, token);

afterEach(async () => {
  await server?.close();
  await stub?.close();
  if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10 });
  server = undefined;
  stub = undefined;
  home = undefined;
});

const RECORD_ENV = 'printf "%s %s" "$1" "$BAND_HUB_TARGET_VERSION" > "$1"';

describe("hub update", () => {
  it("runs the command detached, with the target in its env, and answers at once", async () => {
    const record = await boot(RECORD_ENV);
    const res = await mutate("workers.updateHub");
    expect(res.status).toBe(200);
    expect((await trpcData<{ target: string }>(res)).target).toBe("9.0.0");
    await waitFor(() => (existsSync(record) ? true : undefined), { label: "the command" });
    expect(readFileSync(record, "utf8")).toBe(`${record} 9.0.0`);
    expect(existsSync(join(home ?? "", ".band", "hub-update.log"))).toBe(true);
    // The command exited 0 but the hub still runs the old version: it is waiting for the restart.
    expect((await status()).hubUpdate).toMatchObject({ state: "updating", target: "9.0.0" });
  });

  it("fails with the log tail when the hub does not come back in time", async () => {
    await boot(`echo installing; ${RECORD_ENV}`, { BAND_HUB_UPDATE_TIMEOUT_MS: "300" });
    await mutate("workers.updateHub");
    const failed = await waitFor(
      async () => {
        const s = await status();
        return s.hubUpdate.state === "failed" ? s : undefined;
      },
      { label: "the timeout" },
    );
    expect(failed.hubUpdate.error).toContain("did not come back on 9.0.0");
    expect(failed.hubUpdate.error).toContain("installing");
    // A signed-in device that is not an admin does not see the log.
    const device = await trpcData<{ token: string }>(
      await mutate("tokens.createDevice", { label: "viewer", admin: false }),
    );
    expect((await status(device.token)).hubUpdate.error).toBe("The hub update failed.");
    await mutate("workers.dismissHubUpdate");
    expect((await status()).hubUpdate.state).toBe("idle");
  });

  it("update all runs the hub command last and reports the hub", async () => {
    const record = await boot(RECORD_ENV);
    const res = await mutate("workers.updateAll", { includeHub: true });
    expect(res.status).toBe(200);
    await waitFor(() => (existsSync(record) ? true : undefined), { label: "the command" });
    const st = (await status()) as Status & {
      updateAll: { results: { hostId: string; state: string }[] };
    };
    expect(st.updateAll.results).toMatchObject([{ hostId: "hub", state: "updating" }]);
    expect(readFileSync(record, "utf8")).toBe(`${record} 9.0.0`);
  });

  it("fails at once when the command exits non-zero", async () => {
    await boot("echo boom; exit 3");
    await mutate("workers.updateHub");
    const failed = await waitFor(
      async () => {
        const s = await status();
        return s.hubUpdate.state === "failed" ? s : undefined;
      },
      { label: "the failure" },
    );
    expect(failed.hubUpdate.error).toContain("exited with code 3");
    expect(failed.hubUpdate.error).toContain("boom");
  });

  it("refuses without a command, and for a device that is not an admin", async () => {
    await boot(null);
    expect((await status()).hubUpdate.configured).toBe(false);
    expect((await mutate("workers.updateHub")).status).toBe(412);
    const device = await trpcData<{ token: string }>(
      await mutate("tokens.createDevice", { label: "viewer", admin: false }),
    );
    expect((await mutate("workers.updateHub", {}, device.token)).status).toBe(403);
    expect((await mutate("workers.updateAll", {}, device.token)).status).toBe(403);
    const set = await mutate(
      "settings.update",
      { hubUpdate: { command: "touch /tmp/x" } },
      device.token,
    );
    expect(set.status).toBe(403);
    const read = await trpcData<{ hubUpdate?: unknown }>(
      await trpcQuery(server?.url ?? "", "settings.get", undefined, device.token),
    );
    expect(read.hubUpdate).toBeUndefined();
  });
});
