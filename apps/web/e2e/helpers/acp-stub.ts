/**
 * Helpers for driving the scripted ACP stub agent from Playwright specs
 * (issue #648).
 *
 * Every coding agent runs as an Agent Client Protocol subprocess. When the
 * server boots with `BAND_TEST_ACP_AGENT` set, every agent launches
 * `apps/web/tests/fixtures/acp-stub-agent.mjs` instead, which replies from a
 * scenario file with no network and no login. `startServer` in
 * `./server.ts` sets that variable by default, so a spec only calls
 * `acpStubEnv()` when it needs a scenario, persisted sessions, the request
 * log or capability overrides. See the stub's header for the step format.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Absolute path to `apps/web/tests/fixtures/acp-stub-agent.mjs`. */
export const ACP_STUB_AGENT_PATH = join(
  import.meta.dirname,
  "..",
  "..",
  "tests",
  "fixtures",
  "acp-stub-agent.mjs",
);

/** One scripted turn. The first turn whose `match` regex matches the
 *  prompt text (or that has no `match`) runs. */
export interface StubTurn {
  match?: string;
  steps: object[];
}

export interface AcpStubOptions {
  turns?: StubTurn[];
  caps?: { loadSession?: boolean; list?: boolean; resume?: boolean; image?: boolean };
}

/** Where the stub saves sessions, so a restarted server (or `session/load`)
 *  can read them back. */
export function stubStateDir(home: string): string {
  return join(home, "acp-stub-state");
}

function stubLogPath(home: string): string {
  return join(home, "acp-stub-log.jsonl");
}

/**
 * Environment for `startServer({ env })` that points every agent at the
 * stub, writes the scenario into `home`, and keeps the stub's sessions and
 * request log in `home`.
 */
export function acpStubEnv(home: string, opts: AcpStubOptions = {}): Record<string, string> {
  const env: Record<string, string> = {
    BAND_TEST_ACP_AGENT: ACP_STUB_AGENT_PATH,
    BAND_TEST_ACP_STATE: stubStateDir(home),
    BAND_TEST_ACP_LOG: stubLogPath(home),
  };
  if (opts.turns) {
    const scenarioPath = join(home, "acp-scenario.json");
    writeFileSync(scenarioPath, JSON.stringify({ turns: opts.turns }));
    env.BAND_TEST_ACP_SCENARIO = scenarioPath;
  }
  if (opts.caps) env.BAND_TEST_ACP_CAPS = JSON.stringify(opts.caps);
  return env;
}

export interface StubRequest {
  method: string;
  params: Record<string, unknown>;
}

/** Every request and notification the stub received, in order. */
export function stubRequests(home: string, method?: string): StubRequest[] {
  const path = stubLogPath(home);
  if (!existsSync(path)) return [];
  const all = readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StubRequest);
  return method ? all.filter((r) => r.method === method) : all;
}

/** One user prompt and the agent's text reply, for a seeded session. */
export interface SeededTurn {
  user: string;
  agent: string;
}

/**
 * Writes a session into the stub's state dir as if an earlier agent process
 * had recorded it. `session/list` then reports it and `session/load` replays
 * it as `user_message_chunk` + `agent_message_chunk` updates, which is how
 * Band imports a session it never recorded itself.
 */
export function seedStubSession(
  home: string,
  session: { sessionId: string; cwd: string; title?: string; turns: SeededTurn[] },
): void {
  const dir = stubStateDir(home);
  mkdirSync(dir, { recursive: true });
  const history = session.turns.flatMap((turn, i) => [
    { sessionUpdate: "user_message_chunk", content: { type: "text", text: turn.user } },
    {
      sessionUpdate: "agent_message_chunk",
      messageId: `seeded-${i}`,
      content: { type: "text", text: turn.agent },
    },
  ]);
  writeFileSync(
    join(dir, `${session.sessionId.replace(/[^\w-]/g, "_")}.json`),
    JSON.stringify({
      cwd: session.cwd,
      title: session.title ?? session.turns[0]?.user ?? null,
      updatedAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
      model: "stub-small",
      mode: "default",
      history,
    }),
  );
}
