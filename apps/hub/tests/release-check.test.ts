// Integration tests for the release check (version-updates S2, S4): the hub asks GitHub's
// "latest release" endpoint (an Express stub, through BAND_GITHUB_API_URL) at startup and then on
// an interval, reports whether a newer release exists, and says how to update the hub for the way
// it was installed.

import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { type ReleasesStub, startReleasesStub } from "./fixtures/github-releases-stub";
import { seedSettings } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcQuery,
} from "./helpers/server";
import { waitFor } from "./helpers/wait-for";

const TOKEN = "release-check-token";

interface UpdateStatus {
  hubVersion: string;
  latest: string | null;
  updateAvailable: boolean;
  checkEnabled: boolean;
  installMethod: string | null;
  hubCommand: string;
}

let server: ServerHandle | undefined;
let stub: ReleasesStub | undefined;
let home: string | undefined;

async function boot(
  env: Record<string, string>,
  tag = "v9.0.0",
  failWith: number | null = null,
): Promise<void> {
  stub = await startReleasesStub(tag);
  stub.failWith(failWith);
  home = createTmpHome("band-release-check-");
  seedSettings(home, { tokenSecret: TOKEN });
  server = await startServer({
    tmpHome: home,
    env: { BAND_GITHUB_API_URL: stub.url, ...env },
  });
}

async function status(): Promise<UpdateStatus> {
  const res = await trpcQuery(server?.url ?? "", "hosts.updateStatus", undefined, TOKEN);
  return trpcData<UpdateStatus>(res);
}

afterEach(async () => {
  await server?.close();
  await stub?.close();
  if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10 });
  server = undefined;
  stub = undefined;
  home = undefined;
});

describe("release check", () => {
  it("answers the update status only to a signed-in caller", async () => {
    await boot({});
    const res = await fetch(`${server?.url}/trpc/hosts.updateStatus`);
    expect(res.status).toBe(401);
  });

  it("reports a newer release and the compose update command", async () => {
    await boot({ BAND_INSTALL_METHOD: "compose" });
    await waitFor(async () => ((await status()).latest === "9.0.0" ? true : undefined), {
      label: "the release check",
    });
    const s = await status();
    expect(s).toMatchObject({ updateAvailable: true, latest: "9.0.0", installMethod: "compose" });
    expect(s.hubCommand).toContain("docker compose pull");
    expect(s.hubCommand).toContain("BAND_VERSION=9.0.0");
  });

  it("shows no update when the latest release is not newer than the hub", async () => {
    await boot({}, "v0.0.1");
    await waitFor(async () => ((await status()).latest === "0.0.1" ? true : undefined), {
      label: "the release check",
    });
    const s = await status();
    expect(s.updateAvailable).toBe(false);
    // An install that declared nothing gets the generic text.
    expect(s.installMethod).toBeNull();
    expect(s.hubCommand).toMatch(
      /^Pull ghcr\.io\/band-app\/band-hub:.* and recreate the container\.$/,
    );
  });

  it("maps a helm install to its command", async () => {
    await boot({ BAND_INSTALL_METHOD: "helm" });
    await waitFor(async () => ((await status()).latest === "9.0.0" ? true : undefined), {
      label: "the release check",
    });
    expect((await status()).hubCommand).toMatch(/helm upgrade .*--set image\.tag=9\.0\.0/);
  });

  it("stays quiet when GitHub cannot be reached, and keeps the last answer when it fails later", async () => {
    await boot({ BAND_UPDATE_CHECK_INTERVAL_MS: "300" });
    await waitFor(async () => ((await status()).updateAvailable ? true : undefined), {
      label: "the first answer",
    });
    stub?.failWith(503);
    const seen = stub?.requests() ?? 0;
    await waitFor(() => ((stub?.requests() ?? 0) >= seen + 2 ? true : undefined), {
      label: "two failing checks",
    });
    // The failures cost nothing: no error, and the badge from the earlier answer stays.
    const s = await status();
    expect(s).toMatchObject({ updateAvailable: true, latest: "9.0.0" });
  });

  it("shows nothing when the very first check fails", async () => {
    // A hub that starts while GitHub answers 503.
    await boot({}, "v9.0.0", 503);
    await waitFor(() => ((stub?.requests() ?? 0) >= 1 ? true : undefined), { label: "a check" });
    expect(await status()).toMatchObject({ updateAvailable: false, latest: null });
  });

  it("does not ask GitHub when BAND_UPDATE_CHECK=off", async () => {
    await boot({ BAND_UPDATE_CHECK: "off" });
    // The check runs at startup when it is on, before the server listens.
    await waitFor(async () => ((await status()).checkEnabled === false ? true : undefined), {
      label: "the status",
    });
    expect(stub?.requests()).toBe(0);
    expect(await status()).toMatchObject({
      checkEnabled: false,
      updateAvailable: false,
      latest: null,
    });
  });
});
