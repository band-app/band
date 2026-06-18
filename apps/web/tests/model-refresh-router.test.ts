/**
 * Backend integration test for the models tRPC router (`models.list`,
 * `models.listAll`, `models.refresh`).
 *
 * Boots the real production server bundle against a fresh `$HOME` with a
 * pre-seeded `~/.band/settings.json` containing two configured coding
 * agents. We assert on the HTTP responses for the read path
 * (`list` / `listAll`) and on the on-disk JSON document for the write
 * path (`refresh`). The real adapters are used — Gemini CLI returns a
 * fully hardcoded list from `refreshModels()`, so its branches are
 * deterministic; Codex's `refreshModels()` shells out to
 * `codex debug models` so the codex-refresh case is gated on whether
 * the `codex` binary is on PATH (see the load-bearing assertion in
 * "refresh without agentId" that handles both branches).
 */

import { readFileSync, rmSync } from "node:fs";
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
 * Just the slice of `~/.band/settings.json` these tests assert on —
 * described locally rather than importing the production `Settings`
 * type from `src/server/infra/**`, so the test isn't coupled to the
 * internal schema (TEST-2).
 */
interface PersistedSettings {
  codingAgents?: {
    id: string;
    cachedModels?: { id: string; name?: string }[];
    cachedModelsUpdatedAt?: number;
  }[];
}

function readSettingsFile(home: string): PersistedSettings {
  return JSON.parse(
    readFileSync(join(home, ".band", "settings.json"), "utf-8"),
  ) as PersistedSettings;
}

/**
 * Boot helper used by every describe block. Each block writes its own
 * settings.json shape and gets a fresh tmpHome so tests can't leak
 * cached-models writes into the next block's assertions. `bootRefresh`
 * is disabled because each block preseeds the cache it wants to assert
 * on; with the boot refresh enabled, that preseeded cache would be
 * overwritten before the first request lands.
 */
async function bootWithSettings(settings: object): Promise<{ server: ServerHandle; home: string }> {
  const tmpHome = createTmpHome("band-models-router-");
  seedSettings(tmpHome, settings);
  const server = await startServer({
    tmpHome,
    env: { BAND_DISABLE_BOOT_MODEL_REFRESH: "1" },
  });
  return { server, home: tmpHome };
}

describe("models router — read path (preseeded cache)", () => {
  // Read-only block (list / listAll never mutate settings.json), so a
  // single shared server boot is safe — beforeAll/afterAll instead of
  // per-test boot (TEST-11).
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    const booted = await bootWithSettings({
      tokenSecret: TOKEN,
      codingAgents: [
        {
          id: "codex",
          type: "codex",
          label: "Codex",
          cachedModels: [{ id: "preseeded-codex", name: "Preseeded Codex" }],
          cachedModelsUpdatedAt: 1_700_000_000_000,
        },
        { id: "gemini-cli", type: "gemini-cli", label: "Gemini CLI" },
      ],
      defaultCodingAgent: "codex",
    });
    server = booted.server;
    tmpHome = booted.home;
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
    expect(data.models).toEqual([{ id: "preseeded-codex", name: "Preseeded Codex" }]);
    expect(data.updatedAt).toBe(1_700_000_000_000);
  });

  it("models.list falls back to adapter defaults when no cache is present", async () => {
    const res = await trpcQuery(server.url, "models.list", { agentId: "gemini-cli" }, TOKEN);
    expect(res.status).toBe(200);
    const data = await trpcData<{
      models: { id: string; name: string; contextWindow?: number }[];
      updatedAt?: number;
    }>(res);
    // Gemini CLI ships the static `GEMINI_MODELS` list (deterministic,
    // in-repo). Pin the exact expected list so drift in the adapter
    // surfaces as a failure here rather than going unnoticed.
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
    expect(data.updatedAt).toBeUndefined();
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
    const codex = data.agents.find((a) => a.agentId === "codex");
    expect(codex?.models).toEqual([{ id: "preseeded-codex", name: "Preseeded Codex" }]);
    const gemini = data.agents.find((a) => a.agentId === "gemini-cli");
    // Pin the exact ids (consistent with the `models.list` assertion
    // above) so a silent add/remove in GEMINI_MODELS is caught here.
    expect(gemini?.models.map((m) => m.id)).toEqual(["gemini-2.5-pro", "gemini-2.5-flash"]);
  });
});

describe("models router — refresh persists the new list", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeEach(async () => {
    const booted = await bootWithSettings({
      tokenSecret: TOKEN,
      codingAgents: [
        {
          id: "codex",
          type: "codex",
          label: "Codex",
          cachedModels: [{ id: "preseeded-codex", name: "Preseeded Codex" }],
          cachedModelsUpdatedAt: 1_700_000_000_000,
        },
        { id: "gemini-cli", type: "gemini-cli", label: "Gemini CLI" },
      ],
      defaultCodingAgent: "codex",
    });
    server = booted.server;
    tmpHome = booted.home;
  });

  afterEach(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("models.refresh writes a fresh list to settings.json and leaves other agents untouched", async () => {
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
    expect(result.updatedAt).toBeGreaterThan(0);

    const persisted = readSettingsFile(tmpHome);
    const gemini = persisted.codingAgents?.find((a) => a.id === "gemini-cli");
    expect(gemini?.cachedModels?.map((m) => m.id)).toEqual(["gemini-2.5-pro", "gemini-2.5-flash"]);
    expect(gemini?.cachedModelsUpdatedAt).toBeGreaterThan(0);
    // Codex (preseeded) is untouched by a single-agent refresh of gemini-cli.
    const codex = persisted.codingAgents?.find((a) => a.id === "codex");
    expect(codex?.cachedModels).toEqual([{ id: "preseeded-codex", name: "Preseeded Codex" }]);
    expect(codex?.cachedModelsUpdatedAt).toBe(1_700_000_000_000);
  });

  it("models.refresh without agentId refreshes every configured agent", async () => {
    const res = await trpcMutate(server.url, "models.refresh", {}, TOKEN);
    expect(res.status).toBe(200);
    const data = await trpcData<{
      results: {
        agentId: string;
        models: { id: string }[];
        updatedAt: number;
        error?: string;
      }[];
    }>(res);
    expect(data.results.map((r) => r.agentId).sort()).toEqual(["codex", "gemini-cli"]);

    // gemini-cli's refresh is fully deterministic (hardcoded list in
    // the adapter, no binary spawn). Pin that.
    const geminiResult = data.results.find((r) => r.agentId === "gemini-cli");
    expect(geminiResult?.error).toBeUndefined();
    expect(geminiResult?.models.map((m) => m.id)).toEqual(["gemini-2.5-pro", "gemini-2.5-flash"]);

    // codex's refresh shells out to `codex debug models`. If the binary
    // is installed (dev machines), it returns the live catalog; if not
    // (CI nodes without codex on PATH), the service preserves the
    // prior cache and the result carries an `error` string. Both
    // outcomes are valid — assert the cache reflects the appropriate
    // branch.
    const codexResult = data.results.find((r) => r.agentId === "codex");
    const persisted = readSettingsFile(tmpHome);
    const codex = persisted.codingAgents?.find((a) => a.id === "codex");
    if (codexResult?.error) {
      // Binary missing — preseeded cache stays put. The service
      // sanitises raw SDK errors through `classifyRefreshError`, so
      // pin the exact classification rather than the underlying
      // ENOENT-flavoured message we used to see.
      expect(codexResult.error).toBe("agent binary not found");
      expect(codex?.cachedModels).toEqual([{ id: "preseeded-codex", name: "Preseeded Codex" }]);
      expect(codex?.cachedModelsUpdatedAt).toBe(1_700_000_000_000);
    } else {
      // Binary available — preseeded cache is replaced by the live list.
      // Don't pin the id prefix — Codex ships new model lines on its own
      // cadence (gpt-5.x today; o4/o5 or beyond tomorrow). The presence
      // of >0 entries with a fresh timestamp is enough to prove the
      // refresh did its job.
      expect(codex?.cachedModels?.length).toBeGreaterThan(0);
      expect(codex?.cachedModelsUpdatedAt).toBeGreaterThan(1_700_000_000_000);
    }
  });
});

describe("models router — fallback when no cache exists", () => {
  // Read-only block — shared server boot (TEST-11).
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    const booted = await bootWithSettings({
      tokenSecret: TOKEN,
      codingAgents: [{ id: "gemini-cli", type: "gemini-cli", label: "Gemini CLI" }],
    });
    server = booted.server;
    tmpHome = booted.home;
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("models.list returns adapter defaults without writing settings.json", async () => {
    const res = await trpcQuery(server.url, "models.list", { agentId: "gemini-cli" }, TOKEN);
    expect(res.status).toBe(200);
    const data = await trpcData<{ models: { id: string }[] }>(res);
    expect(data.models.map((m) => m.id)).toEqual(["gemini-2.5-pro", "gemini-2.5-flash"]);

    // The read path must NOT touch the cache — that's `refresh`'s job.
    const persisted = readSettingsFile(tmpHome);
    expect(persisted.codingAgents?.[0]?.cachedModels).toBeUndefined();
    expect(persisted.codingAgents?.[0]?.cachedModelsUpdatedAt).toBeUndefined();
  });
});

describe("models router — authentication", () => {
  // Read-only block (only 401 negative paths) — shared server boot (TEST-11).
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    const booted = await bootWithSettings({
      tokenSecret: TOKEN,
      codingAgents: [{ id: "gemini-cli", type: "gemini-cli", label: "Gemini CLI" }],
    });
    server = booted.server;
    tmpHome = booted.home;
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("models.list rejects unauthenticated requests with 401", async () => {
    // No band_token cookie — server should refuse to serve the procedure.
    const res = await fetch(
      `${server.url}/trpc/models.list?input=${encodeURIComponent(
        JSON.stringify({ agentId: "gemini-cli" }),
      )}`,
    );
    expect(res.status).toBe(401);
  });

  it("models.refresh rejects unauthenticated requests with 401", async () => {
    // Negative-path mutation: refresh is the only write surface this
    // router exposes, so it must enforce auth.
    const res = await fetch(`${server.url}/trpc/models.refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: "gemini-cli" }),
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Refresh-FAILURE branches, driven through the real server (no in-process
// service instantiation). We make a refresh fail deterministically by
// pointing the codex agent's `command` at a path that doesn't exist:
// `codex debug models` then fails with ENOENT, which the service maps to
// the sanitised "agent binary not found" classification. This exercises
// the "keep prior cache on failure" + "isolate per-agent failure" paths
// that used to live in the deleted service-level `model-refresh.test.ts`,
// but now through `models.refresh` over HTTP.
// ---------------------------------------------------------------------------

const MISSING_CODEX = "/nonexistent/band-test-codex-binary";

describe("models router — refresh failure preserves the prior cache", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeEach(async () => {
    const booted = await bootWithSettings({
      tokenSecret: TOKEN,
      codingAgents: [
        {
          id: "codex",
          type: "codex",
          label: "Codex",
          // Point at a binary that doesn't exist → `codex debug models`
          // fails with ENOENT on every refresh attempt.
          command: MISSING_CODEX,
          cachedModels: [{ id: "preseeded-codex", name: "Preseeded Codex" }],
          cachedModelsUpdatedAt: 1_700_000_000_000,
        },
      ],
      defaultCodingAgent: "codex",
    });
    server = booted.server;
    tmpHome = booted.home;
  });

  afterEach(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns a sanitised error and leaves the cached list + timestamp untouched", async () => {
    const res = await trpcMutate(server.url, "models.refresh", { agentId: "codex" }, TOKEN);
    expect(res.status).toBe(200);
    const data = await trpcData<{
      results: { agentId: string; models: { id: string }[]; updatedAt: number; error?: string }[];
    }>(res);
    expect(data.results).toHaveLength(1);
    const result = data.results[0];
    expect(result.agentId).toBe("codex");
    // The raw ENOENT is classified into a host-state-free string.
    expect(result.error).toBe("agent binary not found");
    // The prior cache is echoed back unchanged...
    expect(result.models).toEqual([{ id: "preseeded-codex", name: "Preseeded Codex" }]);
    expect(result.updatedAt).toBe(1_700_000_000_000);

    // ...and settings.json on disk is untouched by the failed refresh.
    const persisted = readSettingsFile(tmpHome);
    const codex = persisted.codingAgents?.find((a) => a.id === "codex");
    expect(codex?.cachedModels).toEqual([{ id: "preseeded-codex", name: "Preseeded Codex" }]);
    expect(codex?.cachedModelsUpdatedAt).toBe(1_700_000_000_000);
  });
});

describe("models router — refresh-all isolates per-agent failures", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeEach(async () => {
    const booted = await bootWithSettings({
      tokenSecret: TOKEN,
      codingAgents: [
        // Healthy agent: gemini-cli's refreshModels() returns a hardcoded
        // list, so it always succeeds.
        { id: "gemini-cli", type: "gemini-cli", label: "Gemini CLI" },
        // Broken agent: codex points at a missing binary.
        { id: "codex", type: "codex", label: "Codex", command: MISSING_CODEX },
      ],
    });
    server = booted.server;
    tmpHome = booted.home;
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

    // Healthy agent's cache was written; broken agent's stays absent.
    const persisted = readSettingsFile(tmpHome);
    expect(
      persisted.codingAgents?.find((a) => a.id === "gemini-cli")?.cachedModels?.length,
    ).toBeGreaterThan(0);
    expect(persisted.codingAgents?.find((a) => a.id === "codex")?.cachedModels).toBeUndefined();
  });
});
