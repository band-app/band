// Codex, Gemini CLI and OpenCode hook payloads through the real `band notify`
// to the hub's `statuses.notify`, one worktree per run. The payloads are the
// recorded fixtures of `packages/coding-agent/tests/fixtures/hooks`.

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcQuery,
} from "./helpers/server";
import { HOOK_HOST_ID, testWorktreeId } from "./helpers/test-host";
import { removeTmpHome } from "./helpers/tmp-home";

const TOKEN = "agent-hooks-notify-token";
const FIXTURES = join(import.meta.dirname, "../../../packages/coding-agent/tests/fixtures/hooks");

interface Fixture {
  payloads: { expect: string; payload: Record<string, unknown> }[];
  sessionEnd?: { payload: Record<string, unknown> };
}

function fixture(agent: string): Fixture {
  return JSON.parse(readFileSync(join(FIXTURES, `${agent}.json`), "utf-8"));
}

describe.each(["codex", "gemini-cli", "opencode"])("band notify --agent %s", (agent) => {
  let server: ServerHandle;
  let tmpHome: string;
  let repoPath: string;

  beforeAll(async () => {
    tmpHome = createTmpHome("band-agent-hooks-notify-");
    repoPath = join(tmpHome, "myrepo");
    execFileSync("git", ["init", "-q", "-b", "main", repoPath]);
    execFileSync("git", [
      "-C",
      repoPath,
      "-c",
      "user.email=a@b.c",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    ]);
    seedState(tmpHome, {
      repos: [
        {
          name: "myrepo",
          path: repoPath,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: repoPath }],
        },
      ],
    });
    seedSettings(tmpHome, {
      tokenSecret: TOKEN,
      worktreesDir: join(tmpHome, ".band", "worktrees"),
    });
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    removeTmpHome(tmpHome);
  });

  const status = async () => {
    const res = await trpcQuery(
      server.url,
      "statuses.get",
      {
        worktreeId: testWorktreeId("myrepo", "main"),
      },
      TOKEN,
    );
    return (await trpcData<{ agent?: { status: string } } | null>(res))?.agent?.status;
  };

  // Strips the session's BAND_* variables so the CLI reaches only this test's hub.
  function notify(payload: Record<string, unknown>): void {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !k.startsWith("BAND_") && !k.startsWith("GIT_CONFIG")) env[k] = v;
    }
    const result = spawnSync(process.env.BAND_CLI_PATH ?? "band", ["notify", "--agent", agent], {
      input: JSON.stringify({ ...payload, cwd: repoPath }),
      env: {
        ...env,
        HOME: tmpHome,
        BAND_HOME: join(tmpHome, ".band"),
        BAND_SERVER_URL: server.url,
        BAND_TOKEN: TOKEN,
        BAND_WORKER_ID: HOOK_HOST_ID,
      },
      encoding: "utf-8",
      timeout: 10_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  }

  it("maps each recorded payload to its status", async () => {
    const { payloads, sessionEnd } = fixture(agent);
    for (const { payload, expect: expected } of payloads) {
      notify(payload);
      await expect.poll(status, { timeout: 5000 }).toBe(expected);
    }
    if (sessionEnd) {
      // The ended session's source goes, so the worktree no longer reports its last status.
      notify(sessionEnd.payload);
      await expect.poll(status, { timeout: 5000 }).toBe("idle");
    }
  });
});
