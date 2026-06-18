/**
 * Service-level tests for `ModelRefreshService` — the file-backed cache
 * for each coding agent's model list (see
 * `apps/web/src/server/services/model-refresh-service.ts`).
 *
 * Drives the service through its public surface against a real
 * `~/.band/settings.json` in a sandboxed `$HOME`, asserts on the
 * resulting on-disk JSON. The only stub is the coding-agent pool —
 * `createMetadataAgent` is replaced through the constructor's
 * `ModelRefreshPool` seam with a function that returns a fake
 * `CodingAgent` whose `refreshModels()` / `listModels()` we control.
 *
 * Scope split with `model-refresh-router.test.ts`:
 *
 *   • The router test boots the production server bundle and exercises
 *     the happy paths through real HTTP — `models.list`,
 *     `models.listAll`, `models.refresh` — using the real adapters
 *     (codex / gemini-cli), which always succeed.
 *
 *   • THIS file covers the SDK-failure branches that the real adapters
 *     cannot surface: the refresh-error path (the prior cache is
 *     preserved, no write happens), the "agent not in settings"
 *     persist-no-op, and the per-agent failure isolation inside
 *     `refreshAll`. Reaching those paths through HTTP would require
 *     temporarily replacing a real adapter with a failing one, which
 *     would be more invasive than the constructor-injection seam used
 *     here. Same shape as existing service-level tests
 *     (`state.test.ts`, `usage-events-retention.test.ts`,
 *     `sync-service.test.ts`).
 */

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentModel, CodingAgent } from "@band-app/coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Settings } from "../src/server/infra/db/queries/settings";
import { SettingsQueries } from "../src/server/infra/db/queries/settings";
import {
  type ModelRefreshPool,
  ModelRefreshService,
} from "../src/server/services/model-refresh-service";
import { createTmpHome } from "./helpers/server";

function readSettingsFile(tmpHome: string): Settings {
  const raw = readFileSync(join(tmpHome, ".band", "settings.json"), "utf-8");
  return JSON.parse(raw) as Settings;
}

function writeSettings(tmpHome: string, settings: Settings): void {
  // `createTmpHome` (from ./helpers/server) already mkdir'd
  // `tmpHome/.band`; we only need to write the JSON file here.
  writeFileSync(
    join(tmpHome, ".band", "settings.json"),
    `${JSON.stringify(settings, null, 2)}\n`,
    "utf-8",
  );
}

/**
 * Minimal `CodingAgent` test double. The refresh service only touches
 * `listModels()` and `refreshModels()`, so the rest of the interface is
 * stubbed with `runSession` that yields nothing.
 */
function makeFakeAgent(opts: {
  listed: AgentModel[];
  refreshed?: AgentModel[];
  refreshError?: Error;
}): CodingAgent {
  return {
    name: "Fake",
    supportedFeatures: { costTracking: false, sessionListing: false },
    async *runSession(): ReturnType<CodingAgent["runSession"]> {},
    listModels() {
      return opts.listed;
    },
    async refreshModels() {
      if (opts.refreshError) throw opts.refreshError;
      return opts.refreshed ?? opts.listed;
    },
  };
}

describe("ModelRefreshService", () => {
  let tmp: string;
  let originalBandHome: string | undefined;

  beforeEach(() => {
    tmp = createTmpHome("band-model-refresh-");
    // The service reads `~/.band/settings.json` via `SettingsQueries`,
    // which composes the path from `$BAND_HOME` (preferred) or
    // `$HOME/.band`. Override `BAND_HOME` directly so the seam matches
    // sibling vitest suites (`state.test.ts`).
    originalBandHome = process.env.BAND_HOME;
    process.env.BAND_HOME = join(tmp, ".band");
  });

  afterEach(() => {
    if (originalBandHome !== undefined) {
      process.env.BAND_HOME = originalBandHome;
    } else {
      delete process.env.BAND_HOME;
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it("persists the refreshed model list into settings.codingAgents", async () => {
    writeSettings(tmp, {
      codingAgents: [
        { id: "claude-code", type: "claude-code", label: "Claude Code" },
        { id: "codex", type: "codex", label: "Codex" },
      ],
    });

    const pool: ModelRefreshPool = {
      async createMetadataAgent(agentId?: string) {
        if (agentId === "claude-code") {
          return makeFakeAgent({
            listed: [{ id: "sonnet-old", name: "Sonnet (old)" }],
            refreshed: [
              { id: "opus-4-8", name: "Opus 4.8", contextWindow: 200_000 },
              { id: "sonnet-4-6", name: "Sonnet 4.6" },
            ],
          });
        }
        return makeFakeAgent({ listed: [], refreshed: [] });
      },
    };
    const service = new ModelRefreshService(new SettingsQueries(), pool);

    const result = await service.refresh("claude-code");

    expect(result.error).toBeUndefined();
    expect(result.models.map((m) => m.id)).toEqual(["opus-4-8", "sonnet-4-6"]);
    expect(result.updatedAt).toBeGreaterThan(0);

    const persisted = readSettingsFile(tmp);
    const claude = persisted.codingAgents?.find((a) => a.id === "claude-code");
    expect(claude?.cachedModels).toEqual([
      { id: "opus-4-8", name: "Opus 4.8", contextWindow: 200_000 },
      { id: "sonnet-4-6", name: "Sonnet 4.6" },
    ]);
    expect(claude?.cachedModelsUpdatedAt).toBeGreaterThan(0);

    // Codex is untouched.
    const codex = persisted.codingAgents?.find((a) => a.id === "codex");
    expect(codex?.cachedModels).toBeUndefined();
  });

  it("keeps the prior cached list when refresh throws", async () => {
    const priorTime = Date.now() - 60_000;
    writeSettings(tmp, {
      codingAgents: [
        {
          id: "claude-code",
          type: "claude-code",
          label: "Claude Code",
          cachedModels: [{ id: "cached-1", name: "Cached 1" }],
          cachedModelsUpdatedAt: priorTime,
        },
      ],
    });

    const pool: ModelRefreshPool = {
      async createMetadataAgent() {
        return makeFakeAgent({
          listed: [{ id: "fallback", name: "Fallback" }],
          refreshError: new Error("network down"),
        });
      },
    };
    const service = new ModelRefreshService(new SettingsQueries(), pool);

    const result = await service.refresh("claude-code");

    // Service classifies the raw SDK error through
    // `classifyRefreshError`. "network down" doesn't match any pattern
    // → falls through to the generic classification.
    expect(result.error).toBe("refresh failed");
    expect(result.models).toEqual([{ id: "cached-1", name: "Cached 1" }]);
    expect(result.updatedAt).toBe(priorTime);

    // The on-disk cache is preserved verbatim.
    const persisted = readSettingsFile(tmp);
    const claude = persisted.codingAgents?.find((a) => a.id === "claude-code");
    expect(claude?.cachedModels).toEqual([{ id: "cached-1", name: "Cached 1" }]);
    expect(claude?.cachedModelsUpdatedAt).toBe(priorTime);
  });

  it("falls back to the adapter's listModels() when no cache exists", async () => {
    writeSettings(tmp, {
      codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
    });

    const pool: ModelRefreshPool = {
      async createMetadataAgent() {
        return makeFakeAgent({
          listed: [
            { id: "default-a", name: "Default A" },
            { id: "default-b", name: "Default B" },
          ],
        });
      },
    };
    const service = new ModelRefreshService(new SettingsQueries(), pool);

    const models = await service.getCachedOrDefaults("claude-code");
    expect(models.map((m) => m.id)).toEqual(["default-a", "default-b"]);

    // Reading must NOT have written to settings.json — fallback is a
    // pure read path; refresh is the only writer.
    const persisted = readSettingsFile(tmp);
    expect(persisted.codingAgents?.[0]?.cachedModels).toBeUndefined();
  });

  it("prefers the cached list over the adapter defaults", async () => {
    writeSettings(tmp, {
      codingAgents: [
        {
          id: "claude-code",
          type: "claude-code",
          label: "Claude Code",
          cachedModels: [{ id: "from-cache", name: "From Cache" }],
          cachedModelsUpdatedAt: Date.now(),
        },
      ],
    });
    const pool: ModelRefreshPool = {
      async createMetadataAgent() {
        return makeFakeAgent({
          listed: [{ id: "default-only", name: "Default Only" }],
        });
      },
    };
    const service = new ModelRefreshService(new SettingsQueries(), pool);

    const models = await service.getCachedOrDefaults("claude-code");
    expect(models.map((m) => m.id)).toEqual(["from-cache"]);
  });

  it("refreshAll iterates every agent and isolates per-agent failures", async () => {
    writeSettings(tmp, {
      codingAgents: [
        { id: "claude-code", type: "claude-code", label: "Claude Code" },
        { id: "codex", type: "codex", label: "Codex" },
        { id: "opencode", type: "opencode", label: "OpenCode" },
      ],
    });

    const pool: ModelRefreshPool = {
      async createMetadataAgent(agentId?: string) {
        if (agentId === "codex") {
          return makeFakeAgent({
            listed: [],
            refreshError: new Error("codex binary not found"),
          });
        }
        return makeFakeAgent({
          listed: [],
          refreshed: [{ id: `${agentId}-model`, name: `${agentId} model` }],
        });
      },
    };
    const service = new ModelRefreshService(new SettingsQueries(), pool);

    const results = await service.refreshAll();
    expect(results.map((r) => r.agentId)).toEqual(["claude-code", "codex", "opencode"]);

    const codexResult = results.find((r) => r.agentId === "codex");
    // "codex binary not found" matches the ENOENT/not-found pattern.
    expect(codexResult?.error).toBe("agent binary not found");

    const claudeResult = results.find((r) => r.agentId === "claude-code");
    expect(claudeResult?.error).toBeUndefined();
    expect(claudeResult?.models.map((m) => m.id)).toEqual(["claude-code-model"]);

    const persisted = readSettingsFile(tmp);
    expect(persisted.codingAgents?.find((a) => a.id === "claude-code")?.cachedModels).toHaveLength(
      1,
    );
    expect(persisted.codingAgents?.find((a) => a.id === "codex")?.cachedModels).toBeUndefined();
    expect(persisted.codingAgents?.find((a) => a.id === "opencode")?.cachedModels).toHaveLength(1);
  });

  it("getAllCachedOrDefaults returns one entry per configured agent", async () => {
    writeSettings(tmp, {
      codingAgents: [
        {
          id: "claude-code",
          type: "claude-code",
          label: "Claude Code",
          cachedModels: [{ id: "from-cache", name: "From Cache" }],
          cachedModelsUpdatedAt: 1_700_000_000_000,
        },
        { id: "codex", type: "codex", label: "Codex" },
      ],
    });

    const pool: ModelRefreshPool = {
      async createMetadataAgent(agentId?: string) {
        if (agentId === "codex") {
          return makeFakeAgent({ listed: [{ id: "codex-default", name: "Codex Default" }] });
        }
        return makeFakeAgent({ listed: [] });
      },
    };
    const service = new ModelRefreshService(new SettingsQueries(), pool);

    const all = await service.getAllCachedOrDefaults();
    expect(all.map((a) => a.agentId)).toEqual(["claude-code", "codex"]);
    expect(all.find((a) => a.agentId === "claude-code")?.models.map((m) => m.id)).toEqual([
      "from-cache",
    ]);
    expect(all.find((a) => a.agentId === "claude-code")?.updatedAt).toBe(1_700_000_000_000);
    expect(all.find((a) => a.agentId === "codex")?.models.map((m) => m.id)).toEqual([
      "codex-default",
    ]);
    expect(all.find((a) => a.agentId === "codex")?.updatedAt).toBeUndefined();
  });

  it("refreshAll on an empty codingAgents list is a no-op", async () => {
    writeSettings(tmp, { codingAgents: [] });

    const pool: ModelRefreshPool = {
      async createMetadataAgent() {
        throw new Error("should not be called");
      },
    };
    const service = new ModelRefreshService(new SettingsQueries(), pool);

    const results = await service.refreshAll();
    expect(results).toEqual([]);

    const persisted = readSettingsFile(tmp);
    expect(persisted.codingAgents).toEqual([]);
  });
});
