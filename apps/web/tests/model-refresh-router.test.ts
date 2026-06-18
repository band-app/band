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
 *
 * See: docs/integration-testing.md, .claude/skills/write-integration-test/SKILL.md.
 */

import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Settings } from "../src/server/infra/db/queries/settings";
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

function readSettingsFile(home: string): Settings {
  return JSON.parse(readFileSync(join(home, ".band", "settings.json"), "utf-8")) as Settings;
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
    expect(gemini?.models.length).toBeGreaterThan(0);
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
      // Binary missing — preseeded cache stays put. Pin the error
      // message at least loosely (must mention codex / ENOENT) so the
      // branch doesn't silently accept unrelated failures from
      // `refreshModels()`.
      expect(codexResult.error).toMatch(/codex|ENOENT|not found/i);
      expect(codex?.cachedModels).toEqual([{ id: "preseeded-codex", name: "Preseeded Codex" }]);
      expect(codex?.cachedModelsUpdatedAt).toBe(1_700_000_000_000);
    } else {
      // Binary available — preseeded cache is replaced by the live list.
      expect(codex?.cachedModels?.length).toBeGreaterThan(0);
      expect(codex?.cachedModels?.[0]?.id?.startsWith("gpt-")).toBe(true);
      expect(codex?.cachedModelsUpdatedAt).toBeGreaterThan(1_700_000_000_000);
    }
  });
});

describe("models router — fallback when no cache exists", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeEach(async () => {
    const booted = await bootWithSettings({
      tokenSecret: TOKEN,
      codingAgents: [{ id: "gemini-cli", type: "gemini-cli", label: "Gemini CLI" }],
    });
    server = booted.server;
    tmpHome = booted.home;
  });

  afterEach(async () => {
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
  let server: ServerHandle;
  let tmpHome: string;

  beforeEach(async () => {
    const booted = await bootWithSettings({
      tokenSecret: TOKEN,
      codingAgents: [{ id: "gemini-cli", type: "gemini-cli", label: "Gemini CLI" }],
    });
    server = booted.server;
    tmpHome = booted.home;
  });

  afterEach(async () => {
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
