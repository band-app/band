/**
 * Backend integration test for the models tRPC router (`models.list`,
 * `models.listAll`, `models.refresh`).
 *
 * Boots the real production server bundle against a fresh `$HOME` with a
 * pre-seeded `~/.band/settings.json`. Over ACP (issue #648) a refresh
 * probes the agent: Band starts it, opens a scratch session and caches the
 * choices of the session's `model` config option in
 * `settings.codingAgents[].cachedModels`.
 *
 * Each agent here is an OpenCode or Gemini CLI definition whose `command`
 * is a small shell wrapper that execs the scripted stub ACP agent
 * (`fixtures/acp-stub-agent.mjs`), which offers the models `stub-small`
 * and `stub-large`. Going through each agent's own `command` (rather than
 * `BAND_TEST_ACP_AGENT`, which redirects every agent at once) lets one
 * agent be healthy while another points at a missing binary. No real
 * agent install or network is involved.
 */

import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { STUB_AGENT_PATH } from "./helpers/acp-chat";
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

/** The models the stub ACP agent offers, as Band caches them. */
const STUB_MODELS = [
  { id: "stub-small", name: "Stub Small" },
  { id: "stub-large", name: "Stub Large" },
];

/**
 * Writes an executable wrapper that runs the stub ACP agent, for use as an
 * agent definition's `command`. OpenCode and Gemini CLI launch their
 * `command` directly (with `acp` / `--acp`, which the stub ignores).
 */
function writeStubAgentCommand(tmpHome: string): string {
  const binPath = join(tmpHome, "stub-acp-agent.sh");
  writeFileSync(
    binPath,
    `#!/bin/sh\nexec '${process.execPath}' '${STUB_AGENT_PATH}' "$@"\n`,
    "utf-8",
  );
  chmodSync(binPath, 0o755);
  return binPath;
}

/**
 * Boot the production server bundle with the given settings.json. The
 * boot-time fire-and-forget refresh runs unconditionally; callers that
 * need to assert on the cache should `waitForCachedModels` afterwards.
 *
 * `prepare` is called AFTER the tmp home is created but BEFORE settings
 * are seeded and the server starts — use it to create stub binaries that
 * need a real on-disk path so the seeded settings can reference them
 * directly. This avoids the cross-process race that bites when settings
 * are seeded with a `PLACEHOLDER` `command` and then rewritten from the
 * parent process after `startServer` — the child's boot-refresh can
 * (and does, on CI) fire against the placeholder before the second
 * write lands.
 */
async function bootWithSettings(
  settings: object | ((home: string) => object),
  prepare?: (home: string) => void,
): Promise<{ server: ServerHandle; home: string }> {
  const tmpHome = createTmpHome("band-models-router-");
  prepare?.(tmpHome);
  const resolved = typeof settings === "function" ? settings(tmpHome) : settings;
  seedSettings(tmpHome, resolved);
  // vitest.config.ts sets BAND_TEST_ACP_AGENT for every server; clear it
  // here so each agent's own `command` decides what launches.
  const server = await startServer({ tmpHome, env: { BAND_TEST_ACP_AGENT: "" } });
  return { server, home: tmpHome };
}

/**
 * Poll `~/.band/settings.json` until every named agent's `cachedModels`
 * is non-empty (boot-time refresh has landed for them). Each tick is
 * 100 ms; 150 ticks = 15 s ceiling. A probe waits ~1.5 s after
 * `session/new` for the agent's commands and agents are probed one after
 * another, so two agents need ~3.5 s.
 */
async function waitForCachedModels(home: string, agentIds: string[]): Promise<void> {
  for (let i = 0; i < 150; i++) {
    const settings = readSettingsFile(home);
    const ready = agentIds.every((id) => {
      const a = settings.codingAgents?.find((x) => x.id === id);
      return (a?.cachedModels?.length ?? 0) > 0;
    });
    if (ready) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `boot refresh did not populate cachedModels for ${agentIds.join(", ")} within 15 s`,
  );
}

/** Two healthy agents, both backed by the stub ACP agent. */
function healthyAgents(stub: string) {
  return [
    { id: "opencode", type: "opencode", label: "OpenCode", command: stub },
    { id: "gemini-cli", type: "gemini-cli", label: "Gemini CLI", command: stub },
  ];
}

describe("models router — read path (boot-refresh-populated cache)", () => {
  // Read-only block (list / listAll never mutate settings.json) so a
  // single shared server boot is safe — beforeAll/afterAll instead of a
  // per-test boot.
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    let stub = "";
    const booted = await bootWithSettings(
      () => ({
        tokenSecret: TOKEN,
        // No preseeded cachedModels — the boot refresh populates them by
        // probing the stub agent.
        codingAgents: healthyAgents(stub),
        defaultCodingAgent: "opencode",
      }),
      (home) => {
        stub = writeStubAgentCommand(home);
      },
    );
    server = booted.server;
    tmpHome = booted.home;
    await waitForCachedModels(tmpHome, ["opencode", "gemini-cli"]);
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("models.list returns the cached models for an agent", async () => {
    const res = await trpcQuery(server.url, "models.list", { agentId: "opencode" }, TOKEN);
    expect(res.status).toBe(200);
    const data = await trpcData<{
      models: { id: string; name: string }[];
      updatedAt?: number;
    }>(res);
    expect(data.models).toEqual(STUB_MODELS);
    expect(data.updatedAt).toBeGreaterThan(0);
  });

  it("models.list without agentId falls back to the default agent", async () => {
    const res = await trpcQuery(server.url, "models.list", {}, TOKEN);
    expect(res.status).toBe(200);
    const data = await trpcData<{ models: { id: string }[] }>(res);
    expect(data.models).toEqual(STUB_MODELS);
  });

  it("models.listAll returns every configured agent in order", async () => {
    const res = await trpcQuery(server.url, "models.listAll", undefined, TOKEN);
    expect(res.status).toBe(200);
    const data = await trpcData<{
      agents: { agentId: string; agentType: string; models: { id: string }[] }[];
      defaultAgentId: string;
    }>(res);
    expect(data.defaultAgentId).toBe("opencode");
    expect(data.agents.map((a) => [a.agentId, a.agentType])).toEqual([
      ["opencode", "opencode"],
      ["gemini-cli", "gemini-cli"],
    ]);
    for (const agent of data.agents) {
      expect(agent.models.map((m) => m.id)).toEqual(["stub-small", "stub-large"]);
    }
  });
});

describe("models router — explicit refresh", () => {
  // Write-path: each test boots its own server so cache writes between
  // tests don't bleed.
  let server: ServerHandle;
  let tmpHome: string;

  beforeEach(async () => {
    let stub = "";
    const booted = await bootWithSettings(
      () => ({
        tokenSecret: TOKEN,
        codingAgents: healthyAgents(stub),
        defaultCodingAgent: "opencode",
      }),
      (home) => {
        stub = writeStubAgentCommand(home);
      },
    );
    server = booted.server;
    tmpHome = booted.home;
    await waitForCachedModels(tmpHome, ["opencode", "gemini-cli"]);
  });

  afterEach(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("models.refresh writes a fresh list to settings.json and leaves other agents untouched", async () => {
    // Capture the pre-refresh cachedModelsUpdatedAt so we can confirm the
    // explicit refresh produced a fresh write.
    const before = readSettingsFile(tmpHome);
    const geminiBeforeTs =
      before.codingAgents?.find((a) => a.id === "gemini-cli")?.cachedModelsUpdatedAt ?? 0;
    const opencodeBeforeTs =
      before.codingAgents?.find((a) => a.id === "opencode")?.cachedModelsUpdatedAt ?? 0;

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
    expect(result.models).toEqual(STUB_MODELS);

    const persisted = readSettingsFile(tmpHome);
    const gemini = persisted.codingAgents?.find((a) => a.id === "gemini-cli");
    expect(gemini?.cachedModels).toEqual(STUB_MODELS);
    expect(gemini?.cachedModelsUpdatedAt ?? 0).toBeGreaterThan(geminiBeforeTs);
    // OpenCode was NOT refreshed — its timestamp is unchanged.
    const opencode = persisted.codingAgents?.find((a) => a.id === "opencode");
    expect(opencode?.cachedModelsUpdatedAt).toBe(opencodeBeforeTs);
    expect(opencode?.cachedModels).toEqual(STUB_MODELS);
  });

  it("models.refresh without agentId refreshes every configured agent", async () => {
    const res = await trpcMutate(server.url, "models.refresh", {}, TOKEN);
    expect(res.status).toBe(200);
    const data = await trpcData<{
      results: { agentId: string; error?: string }[];
    }>(res);
    expect(data.results.map((r) => r.agentId).sort()).toEqual(["gemini-cli", "opencode"]);
    expect(data.results.every((r) => !r.error)).toBe(true);
  });

  it("models.refresh with an unknown agentId reports it without probing another agent", async () => {
    const res = await trpcMutate(server.url, "models.refresh", { agentId: "nope" }, TOKEN);
    expect(res.status).toBe(200);
    const data = await trpcData<{ results: unknown[] }>(res);
    expect(data.results).toEqual([
      { agentId: "nope", models: [], updatedAt: 0, error: "agent not found" },
    ]);
  });
});

describe("models router — authentication", () => {
  // Read-only block. No agents are configured: the 401s come from the
  // HTTP auth middleware before any procedure runs.
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    const booted = await bootWithSettings({ tokenSecret: TOKEN, codingAgents: [] });
    server = booted.server;
    tmpHome = booted.home;
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
// pointing an agent's `command` at a path that doesn't exist: starting it
// fails with ENOENT, which the service maps to the sanitised "agent binary
// not found" classification.
// ---------------------------------------------------------------------------

const MISSING_AGENT = "/nonexistent/band-test-agent-binary";

/** A healthy stub-backed agent plus one whose binary is missing. */
function mixedSettings(stub: string) {
  return {
    tokenSecret: TOKEN,
    codingAgents: [
      // The healthy agent anchors the "boot refresh produced a cache
      // write" wait; the broken one's cache must stay empty.
      { id: "opencode", type: "opencode", label: "OpenCode", command: stub },
      { id: "gemini-cli", type: "gemini-cli", label: "Gemini CLI", command: MISSING_AGENT },
    ],
  };
}

describe("models router — refresh failure preserves the prior cache", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeEach(async () => {
    let stub = "";
    const booted = await bootWithSettings(
      () => mixedSettings(stub),
      (home) => {
        stub = writeStubAgentCommand(home);
      },
    );
    server = booted.server;
    tmpHome = booted.home;
    await waitForCachedModels(tmpHome, ["opencode"]);
  });

  afterEach(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns a sanitised error and leaves the cached list empty", async () => {
    const res = await trpcMutate(server.url, "models.refresh", { agentId: "gemini-cli" }, TOKEN);
    expect(res.status).toBe(200);
    const data = await trpcData<{
      results: { agentId: string; models: { id: string }[]; updatedAt: number; error?: string }[];
    }>(res);
    expect(data.results).toEqual([
      { agentId: "gemini-cli", models: [], updatedAt: 0, error: "agent binary not found" },
    ]);

    // settings.json on disk: the broken agent still has no cached models
    // (the boot refresh failed the same way the explicit refresh just
    // did), the healthy one keeps its list.
    const persisted = readSettingsFile(tmpHome);
    const broken = persisted.codingAgents?.find((a) => a.id === "gemini-cli");
    expect(broken?.cachedModels).toBeUndefined();
    expect(broken?.cachedModelsUpdatedAt).toBeUndefined();
    const healthy = persisted.codingAgents?.find((a) => a.id === "opencode");
    expect(healthy?.cachedModels).toEqual(STUB_MODELS);
  });
});

describe("models router — refresh-all isolates per-agent failures", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeEach(async () => {
    let stub = "";
    const booted = await bootWithSettings(
      () => mixedSettings(stub),
      (home) => {
        stub = writeStubAgentCommand(home);
      },
    );
    server = booted.server;
    tmpHome = booted.home;
    await waitForCachedModels(tmpHome, ["opencode"]);
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
    expect(data.results.map((r) => r.agentId).sort()).toEqual(["gemini-cli", "opencode"]);

    const healthy = data.results.find((r) => r.agentId === "opencode");
    expect(healthy?.error).toBeUndefined();

    const broken = data.results.find((r) => r.agentId === "gemini-cli");
    expect(broken?.error).toBe("agent binary not found");

    const persisted = readSettingsFile(tmpHome);
    expect(persisted.codingAgents?.find((a) => a.id === "opencode")?.cachedModels).toEqual(
      STUB_MODELS,
    );
    expect(
      persisted.codingAgents?.find((a) => a.id === "gemini-cli")?.cachedModels,
    ).toBeUndefined();
  });
});
