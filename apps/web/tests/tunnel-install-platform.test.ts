// Integration test for the platform-guarded cloudflared installer (issue
// #594, Linux standalone). Black-box against the production server bundle
// (`dist/start-server.mjs`) over real HTTP tRPC. No mocks.
//
// The dashboard's "Install Tunnel" button hits `prereqs.installTunnel`,
// which shells out to Homebrew (`brew install cloudflared`). Homebrew is
// macOS-only, so on a stock Linux host the old code would fail with an
// opaque `brew` ENOENT. The service now guards on `process.platform` and
// throws a distro-appropriate hint on every non-darwin platform, which the
// dashboard surfaces as a normal error instead of crashing.
//
// Only the platform-hint assertion is skipped on macOS: on darwin the
// procedure would actually invoke `brew install cloudflared`, which must
// never run from a test. The auth (401) assertion is platform-independent and
// runs everywhere. CI runs on Linux, where the hint path is exercised.

import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings } from "./helpers/seed-state";
import { createTmpHome, type ServerHandle, startServer, trpcMutate } from "./helpers/server";

const TOKEN = "tunnel-install-platform-token";

describe("prereqs.installTunnel", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome("band-tunnel-install-platform-");
    seedSettings(tmpHome, { tokenSecret: TOKEN });
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    if (server) await server.close();
    if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
  });

  // Skipped on darwin only — the assertion body reaches the brew shell-out on
  // macOS. Everywhere else it exercises the non-darwin platform hint.
  it.skipIf(process.platform === "darwin")(
    "fails with a package-manager hint instead of shelling out to brew",
    async () => {
      const res = await trpcMutate(server.url, "prereqs.installTunnel", undefined, TOKEN);

      // A plain thrown Error maps to tRPC INTERNAL_SERVER_ERROR → HTTP 500.
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toContain("only supported on macOS");
      expect(body.error.message).toMatch(/apt install cloudflared|dnf install cloudflared/);
      expect(body.error.message).toContain(
        "developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads",
      );
    },
  );

  it("returns 401 for prereqs.installTunnel without an auth token", async () => {
    // Raw fetch with no `band_token` cookie — the shared `trpcMutate` helper
    // always attaches one, so we bypass it to exercise the unauthenticated
    // path. The auth gate must reject before any platform/brew logic runs.
    // Platform-independent, so this runs on every OS (unlike the hint above).
    const res = await fetch(`${server.url}/trpc/prereqs.installTunnel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });
});
