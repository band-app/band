/**
 * Backend integration test for the models tRPC router (`models.list`,
 * `models.listAll`, `models.refresh`).
 *
 * Boots the real production server bundle against a fresh `$HOME` with a
 * pre-seeded `~/.band/settings.json`. Codex's `refreshModels()` shells
 * out to `<command> debug models` and parses JSON from stdout, so we
 * point its `command` at a tiny stub shell script that prints the JSON
 * we want — this makes every refresh path (boot-time, explicit
 * `models.refresh`, and the per-test 401/agent-not-found branches)
 * deterministic on any CI host without depending on a real `codex`
 * install. Gemini CLI's `refreshModels()` returns a hardcoded list from
 * the adapter so it needs no stub.
 */

import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedSettings } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";

const TOKEN = "models-router-token";

/**
 * Just the slice of `~/.band/settings.json` these tests assert on,
 * described locally so the test isn't coupled to the production
 * `Settings` shape and survives refactors of the internal type.
 */
interface PersistedSettings {
  codingAgents?: {
    id: string;
    cachedModels?: { id: string; name?: string; description?: string; contextWindow?: number }[];
    cachedModelsUpdatedAt?: number;
  }[];
}

function readSettingsFile(home: string): PersistedSettings {
  return JSON.parse(
    readFileSync(join(home, ".band", "settings.json"), "utf-8"),
  ) as PersistedSettings;
}

/**
 * Write a stub shell script that, when invoked as `<stub> debug models`,
 * prints the JSON Codex's adapter expects (`{"models":[{slug, …}, …]}`).
 * The stub also handles being invoked WITHOUT `debug models` — it
 * exits 0 with empty stdout — so the boot path (which only ever calls
 * `debug models`) and any accidental other invocation are both safe.
 */
function writeStubCodexCli(
  tmpHome: string,
  name: string,
  models: { slug: string; display_name?: string; description?: string; context_window?: number }[],
): string {
  const binPath = join(tmpHome, name);
  const json = JSON.stringify({ models });
  // Single-quote inside the script body to keep shell escaping trivial.
  writeFileSync(
    binPath,
    `#!/bin/sh\nif [ "$1" = "debug" ] && [ "$2" = "models" ]; then\n  printf '%s\\n' '${json}'\nfi\n`,
    "utf-8",
  );
  chmodSync(binPath, 0o755);
  return binPath;
}

/**
 * Boot the production server bundle with the given settings.json. The
 * boot-time fire-and-forget refresh runs unconditionally; callers that
 * need to assert on the cache should `waitForCachedModels` afterwards.
 */
async function bootWithSettings(settings: object): Promise<{ server: ServerHandle; home: string }> {
  const tmpHome = createTmpHome("band-models-router-");
  seedSettings(tmpHome, settings);
  const server = await startServer({ tmpHome });
  return { server, home: tmpHome };
}

/**
 * Poll `~/.band/settings.json` until every named agent's `cachedModels`
 * is non-empty (boot-time refresh has landed for them). Each tick is
 * 100 ms; 50 ticks = 5 s ceiling, which is well above what the boot
 * refresh actually needs on any of these tests' stub binaries (<200 ms
 * in practice on a warm CI runner).
 */
async function waitForCachedModels(home: string, agentIds: string[]): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const settings = readSettingsFile(home);
    const ready = agentIds.every((id) => {
      const a = settings.codingAgents?.find((x) => x.id === id);
      return (a?.cachedModels?.length ?? 0) > 0;
    });
    if (ready) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `boot refresh did not populate cachedModels for ${agentIds.join(", ")} within 5 s`,
  );
}

describe("models router — read path (boot-refresh-populated cache)", () => {
  // Read-only block (list / listAll never mutate settings.json) so a
  // single shared server boot is safe — beforeAll/afterAll instead of a
  // per-test boot.
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    const booted = await bootWithSettings({
      tokenSecret: TOKEN,
      codingAgents: [
        // Note: no preseeded cachedModels — we let the boot refresh
        // populate them deterministically via the stub binary below.
        {
          id: "codex",
          type: "codex",
          label: "Codex",
          command: "PLACEHOLDER", // overwritten below after createTmpHome
        },
        { id: "gemini-cli", type: "gemini-cli", label: "Gemini CLI" },
      ],
      defaultCodingAgent: "codex",
    });
    server = booted.server;
    tmpHome = booted.home;
    // Re-seed with a real stub-codex path now that tmpHome exists.
    const stubCodex = writeStubCodexCli(tmpHome, "stub-codex.sh", [
      { slug: "stub-codex", display_name: "Stub Codex", description: "stub", priority: 1 },
    ]);
    seedSettings(tmpHome, {
      tokenSecret: TOKEN,
      codingAgents: [
        { id: "codex", type: "codex", label: "Codex", command: stubCodex },
        { id: "gemini-cli", type: "gemini-cli", label: "Gemini CLI" },
      ],
      defaultCodingAgent: "codex",
    });
    await waitForCachedModels(tmpHome, ["codex", "gemini-cli"]);
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("models.list returns the cached models for an agent", async () => {
    const res = await trpcQuery(server.url, "models.list", { agentId: "codex" }, TOKEN);
    expect(res.status).toBe(200);
    const data = await trpcData<{
      models: { id: string; name: string }[];
      updatedAt?: number;
    }>(res);
    expect(data.models).toEqual([
      { id: "stub-codex", name: "Stub Codex", description: "stub", contextWindow: undefined },
    ]);
    expect(data.updatedAt).toBeGreaterThan(0);
  });

  it("models.list returns the cached gemini-cli list", async () => {
    const res = await trpcQuery(server.url, "models.list", { agentId: "gemini-cli" }, TOKEN);
    expect(res.status).toBe(200);
    const data = await trpcData<{
      models: { id: string; name: string; contextWindow?: number }[];
      updatedAt?: number;
    }>(res);
    expect(data.models).toEqual([
      {
        id: "gemini-2.5-pro",
        name: "Gemini 2.5 Pro",
        description: "Most capable",
        contextWindow: 1_000_000,
      },
      {
        id: "gemini-2.5-flash",
        name: "Gemini 2.5 Flash",
        description: "Fast and efficient",
        contextWindow: 1_000_000,
      },
    ]);
    expect(data.updatedAt).toBeGreaterThan(0);
  });

  it("models.listAll returns every configured agent in order", async () => {
    const res = await trpcQuery(server.url, "models.listAll", undefined, TOKEN);
    expect(res.status).toBe(200);
    const data = await trpcData<{
      agents: { agentId: string; agentType: string; models: { id: string }[] }[];
      defaultAgentId: string;
    }>(res);
    expect(data.defaultAgentId).toBe("codex");
    expect(data.agents.map((a) => a.agentId)).toEqual(["codex", "gemini-cli"]);
    expect(data.agents.find((a) => a.agentId === "codex")?.models.map((m) => m.id)).toEqual([
      "stub-codex",
    ]);
    expect(data.agents.find((a) => a.agentId === "gemini-cli")?.models.map((m) => m.id)).toEqual([
      "gemini-2.5-pro",
      "gemini-2.5-flash",
    ]);
  });
});

describe("models router — explicit refresh", () => {
  // Write-path: each test boots its own server so cache writes between
  // tests don't bleed.
  let server: ServerHandle;
  let tmpHome: string;

  beforeEach(async () => {
    const booted = await bootWithSettings({
      tokenSecret: TOKEN,
      codingAgents: [
        { id: "codex", type: "codex", label: "Codex", command: "PLACEHOLDER" },
        { id: "gemini-cli", type: "gemini-cli", label: "Gemini CLI" },
      ],
      defaultCodingAgent: "codex",
    });
    server = booted.server;
    tmpHome = booted.home;
    const stubCodex = writeStubCodexCli(tmpHome, "stub-codex.sh", [
      { slug: "stub-codex", display_name: "Stub Codex", priority: 1 },
    ]);
    seedSettings(tmpHome, {
      tokenSecret: TOKEN,
      codingAgents: [
        { id: "codex", type: "codex", label: "Codex", command: stubCodex },
        { id: "gemini-cli", type: "gemini-cli", label: "Gemini CLI" },
      ],
      defaultCodingAgent: "codex",
    });
    await waitForCachedModels(tmpHome, ["codex", "gemini-cli"]);
  });

  afterEach(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("models.refresh writes a fresh list to settings.json and leaves other agents untouched", async () => {
    // Capture the pre-click cachedModelsUpdatedAt so we can confirm the
    // explicit refresh produced a fresh write.
    const before = readSettingsFile(tmpHome);
    const geminiBeforeTs =
      before.codingAgents?.find((a) => a.id === "gemini-cli")?.cachedModelsUpdatedAt ?? 0;
    const codexBeforeTs =
      before.codingAgents?.find((a) => a.id === "codex")?.cachedModelsUpdatedAt ?? 0;

    // Sleep 5 ms so a sub-millisecond refresh produces a strictly newer
    // timestamp (Date.now() granularity).
    await new Promise((r) => setTimeout(r, 5));

    const res = await trpcMutate(server.url, "models.refresh", { agentId: "gemini-cli" }, TOKEN);
    expect(res.status).toBe(200);
    const data = await trpcData<{
      results: {
        agentId: string;
        models: { id: string }[];
        updatedAt: number;
        error?: string;
      }[];
    }>(res);
    expect(data.results).toHaveLength(1);
    const result = data.results[0];
    expect(result.agentId).toBe("gemini-cli");
    expect(result.error).toBeUndefined();
    expect(result.models.map((m) => m.id)).toEqual(["gemini-2.5-pro", "gemini-2.5-flash"]);

    const persisted = readSettingsFile(tmpHome);
    const gemini = persisted.codingAgents?.find((a) => a.id === "gemini-cli");
    expect(gemini?.cachedModels?.map((m) => m.id)).toEqual(["gemini-2.5-pro", "gemini-2.5-flash"]);
    expect(gemini?.cachedModelsUpdatedAt ?? 0).toBeGreaterThan(geminiBeforeTs);
    // Codex was NOT refreshed — its timestamp is unchanged.
    const codex = persisted.codingAgents?.find((a) => a.id === "codex");
    expect(codex?.cachedModelsUpdatedAt).toBe(codexBeforeTs);
    expect(codex?.cachedModels?.map((m) => m.id)).toEqual(["stub-codex"]);
  });

  it("models.refresh without agentId refreshes every configured agent", async () => {
    const res = await trpcMutate(server.url, "models.refresh", {}, TOKEN);
    expect(res.status).toBe(200);
    const data = await trpcData<{
      results: { agentId: string; error?: string }[];
    }>(res);
    expect(data.results.map((r) => r.agentId).sort()).toEqual(["codex", "gemini-cli"]);
    expect(data.results.every((r) => !r.error)).toBe(true);
  });
});

describe("models router — authentication", () => {
  // Read-only block.
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    const booted = await bootWithSettings({
      tokenSecret: TOKEN,
      codingAgents: [{ id: "gemini-cli", type: "gemini-cli", label: "Gemini CLI" }],
    });
    server = booted.server;
    tmpHome = booted.home;
    await waitForCachedModels(tmpHome, ["gemini-cli"]);
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("models.list rejects unauthenticated requests with 401", async () => {
    const res = await fetch(
      `${server.url}/trpc/models.list?input=${encodeURIComponent(
        JSON.stringify({ agentId: "gemini-cli" }),
      )}`,
    );
    expect(res.status).toBe(401);
  });

  it("models.listAll rejects unauthenticated requests with 401", async () => {
    const res = await fetch(`${server.url}/trpc/models.listAll`);
    expect(res.status).toBe(401);
  });

  it("models.refresh rejects unauthenticated requests with 401", async () => {
    const res = await fetch(`${server.url}/trpc/models.refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: "gemini-cli" }),
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Refresh-FAILURE branches. We make a refresh fail deterministically by
// pointing the codex agent's `command` at a path that doesn't exist:
// `codex debug models` then fails with ENOENT, which the service maps to
// the sanitised "agent binary not found" classification.
// ---------------------------------------------------------------------------

const MISSING_CODEX = "/nonexistent/band-test-codex-binary";

describe("models router — refresh failure preserves the prior cache", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeEach(async () => {
    const booted = await bootWithSettings({
      tokenSecret: TOKEN,
      codingAgents: [
        // gemini-cli's refresh always succeeds → we use it to anchor the
        // "boot refresh produced a cache write" wait, then assert that
        // the broken-codex refresh below leaves codex's cache empty.
        { id: "gemini-cli", type: "gemini-cli", label: "Gemini CLI" },
        {
          id: "codex",
          type: "codex",
          label: "Codex",
          command: MISSING_CODEX,
        },
      ],
    });
    server = booted.server;
    tmpHome = booted.home;
    await waitForCachedModels(tmpHome, ["gemini-cli"]);
  });

  afterEach(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns a sanitised error and leaves the cached list empty", async () => {
    const res = await trpcMutate(server.url, "models.refresh", { agentId: "codex" }, TOKEN);
    expect(res.status).toBe(200);
    const data = await trpcData<{
      results: { agentId: string; models: { id: string }[]; updatedAt: number; error?: string }[];
    }>(res);
    expect(data.results).toHaveLength(1);
    const result = data.results[0];
    expect(result.agentId).toBe("codex");
    expect(result.error).toBe("agent binary not found");
    expect(result.models).toEqual([]);
    expect(result.updatedAt).toBe(0);

    // settings.json on disk: codex still has no cached models (the boot
    // refresh failed the same way the explicit refresh just did), gemini
    // still has its hardcoded list.
    const persisted = readSettingsFile(tmpHome);
    const codex = persisted.codingAgents?.find((a) => a.id === "codex");
    expect(codex?.cachedModels).toBeUndefined();
    expect(codex?.cachedModelsUpdatedAt).toBeUndefined();
    const gemini = persisted.codingAgents?.find((a) => a.id === "gemini-cli");
    expect(gemini?.cachedModels?.length).toBeGreaterThan(0);
  });
});

describe("models router — refresh-all isolates per-agent failures", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeEach(async () => {
    const booted = await bootWithSettings({
      tokenSecret: TOKEN,
      codingAgents: [
        { id: "gemini-cli", type: "gemini-cli", label: "Gemini CLI" },
        { id: "codex", type: "codex", label: "Codex", command: MISSING_CODEX },
      ],
    });
    server = booted.server;
    tmpHome = booted.home;
    await waitForCachedModels(tmpHome, ["gemini-cli"]);
  });

  afterEach(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("persists the healthy agent and reports the broken one without aborting the batch", async () => {
    const res = await trpcMutate(server.url, "models.refresh", {}, TOKEN);
    expect(res.status).toBe(200);
    const data = await trpcData<{
      results: { agentId: string; error?: string }[];
    }>(res);
    expect(data.results.map((r) => r.agentId).sort()).toEqual(["codex", "gemini-cli"]);

    const gemini = data.results.find((r) => r.agentId === "gemini-cli");
    expect(gemini?.error).toBeUndefined();

    const codex = data.results.find((r) => r.agentId === "codex");
    expect(codex?.error).toBe("agent binary not found");

    const persisted = readSettingsFile(tmpHome);
    expect(
      persisted.codingAgents?.find((a) => a.id === "gemini-cli")?.cachedModels?.length,
    ).toBeGreaterThan(0);
    expect(persisted.codingAgents?.find((a) => a.id === "codex")?.cachedModels).toBeUndefined();
  });
});
