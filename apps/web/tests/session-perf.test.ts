/**
 * Workspace-switch performance: `sessions.list` with many past sessions.
 *
 * Opening a chat's history dropdown lists the agent's past sessions for the
 * workspace. Under ACP (issue #648) that is the agent's `session/list`, with
 * titles filled in from Band's log. The stub ACP agent here starts with
 * SESSION_COUNT saved sessions (seeded into its state directory, as if made
 * by earlier runs), and the list must come back complete and fast.
 *
 * Real server bundle, real ACP subprocess, tRPC over HTTP. No mocks.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  seedAcpHome,
  startAcpServer,
  stubRequests,
  TEST_TOKEN,
  trpc,
  WORKSPACE_ID,
} from "./helpers/acp-chat";
import type { ServerHandle } from "./helpers/server";

const SESSION_COUNT = 50;

let server: ServerHandle;
let home: string;

/** Saves sessions the way the stub agent persists them (one JSON file each). */
function seedStubSessions(home: string, count: number): void {
  const dir = join(home, "acp-stub-state");
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i++) {
    const history = [];
    // The first session is long; the rest are short.
    const turns = i === 0 ? 250 : 5;
    for (let t = 0; t < turns; t++) {
      history.push({
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: `prompt #${t}` },
      });
      history.push({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `reply #${t}` },
      });
    }
    writeFileSync(
      join(dir, `perf-session-${String(i).padStart(3, "0")}.json`),
      JSON.stringify({
        cwd: join(home, "repo"),
        title: `session ${i}`,
        updatedAt: new Date(Date.UTC(2026, 2, 12, 8, i)).toISOString(),
        model: "stub-small",
        mode: "default",
        history,
      }),
    );
  }
}

beforeAll(async () => {
  home = seedAcpHome("band-session-perf-");
  seedStubSessions(home, SESSION_COUNT);
  server = await startAcpServer({ home });
}, 30_000);

afterAll(async () => {
  await server?.close();
  rmSync(home, { recursive: true, force: true });
});

describe("workspace-switch perf — sessions.list", () => {
  it(`sessions.list returns all ${SESSION_COUNT} sessions within 5s`, async () => {
    const start = Date.now();
    const data = await trpc<{
      sessions: Array<{ sessionId: string; summary: string; lastModified: number }>;
      supported: boolean;
    }>(server.url, "sessions.list", { workspaceId: WORKSPACE_ID }, "query");
    const elapsedMs = Date.now() - start;

    expect(data.supported).toBe(true);
    expect(data.sessions).toHaveLength(SESSION_COUNT);
    expect(data.sessions.find((s) => s.sessionId === "perf-session-007")).toEqual({
      sessionId: "perf-session-007",
      summary: "session 7",
      lastModified: Date.UTC(2026, 2, 12, 8, 7),
    });
    // Generous bound: this includes starting the agent process.
    expect(elapsedMs).toBeLessThan(5000);
    // Exactly one `session/list`, scoped to the workspace, answered it (the
    // boot-time model probe never lists), and no session was loaded to
    // read titles.
    expect(stubRequests(home, "session/list").map((r) => r.params.cwd)).toEqual([
      join(home, "repo"),
    ]);
    expect(stubRequests(home, "session/load")).toHaveLength(0);
  });

  it("rejects sessions.list without the band_token cookie (401)", async () => {
    const res = await fetch(
      `${server.url}/trpc/sessions.list?input=${encodeURIComponent(
        JSON.stringify({ workspaceId: WORKSPACE_ID }),
      )}`,
    );
    expect(res.status).toBe(401);
    const ok = await fetch(
      `${server.url}/trpc/sessions.list?input=${encodeURIComponent(
        JSON.stringify({ workspaceId: WORKSPACE_ID }),
      )}`,
      { headers: { Cookie: `band_token=${TEST_TOKEN}` } },
    );
    expect(ok.status).toBe(200);
  });
});
