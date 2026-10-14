// The branch-status poller follows what the connected UIs report through `services.setActivity`:
// the most active live client wins, a client that goes quiet for BAND_ACTIVITY_TTL_MS drops out,
// and with no live client the level is `idle`. A real hub with a status stream open (that starts
// the poller); the UIs are plain tRPC callers with their own client ids.

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";
import { StatusStream } from "./helpers/status-stream";
import { waitFor } from "./helpers/wait-for";

const TOKEN = "client-activity-token";
const TTL_MS = 2_000;

type Level = "active" | "idle" | "background";

describe("client activity drives the poller cadence", () => {
  let tmpHome: string;
  let server: ServerHandle;
  let stream: StatusStream;

  const report = async (clientId: string, activity: Level) => {
    const res = await trpcMutate(server.url, "services.setActivity", { activity, clientId }, TOKEN);
    expect(res.status).toBe(200);
  };
  const release = async (clientId: string) => {
    const res = await trpcMutate(server.url, "services.releaseActivity", { clientId }, TOKEN);
    expect(res.status).toBe(200);
  };
  const levels = async () => {
    const res = await trpcQuery(server.url, "services.getActivity", undefined, TOKEN);
    return trpcData<{ activity: Level; poller: Level }>(res);
  };
  const expectLevel = (level: Level, timeoutMs = 5_000) =>
    waitFor(
      async () => {
        const now = await levels();
        return now.activity === level && now.poller === level ? now : undefined;
      },
      { timeoutMs, label: `poller at ${level}` },
    );

  beforeAll(async () => {
    tmpHome = createTmpHome("band-client-activity-");
    const repo = join(tmpHome, "proj");
    mkdirSync(repo);
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    };
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env });
    writeFileSync(join(repo, "a.txt"), "a\n");
    execFileSync("git", ["add", "."], { cwd: repo, env });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo, env });
    seedState(tmpHome, {
      repos: [
        {
          name: "proj",
          path: repo,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: repo }],
        },
      ],
    });
    seedSettings(tmpHome, { tokenSecret: TOKEN });
    server = await startServer({
      tmpHome,
      env: { BAND_ACTIVITY_DEFAULT: "idle", BAND_ACTIVITY_TTL_MS: String(TTL_MS) },
    });
    stream = await StatusStream.open(server.url, TOKEN);
  }, 30_000);

  afterAll(async () => {
    stream?.close();
    await server?.close();
    rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("uses idle, not active, while no client has reported", async () => {
    await expectLevel("idle");
  });

  it("follows a client that reports background, then active", async () => {
    await report("laptop", "background");
    await expectLevel("background");
    await report("laptop", "active");
    await expectLevel("active");
  });

  it("uses the most active client, and falls back when it is released", async () => {
    await report("laptop", "active");
    await report("phone", "background");
    await expectLevel("active");
    // The phone cannot lower the laptop's state.
    await report("phone", "idle");
    await expectLevel("active");
    await release("laptop");
    await expectLevel("idle");
    await release("phone");
    await expectLevel("idle");
  });

  it("drops a client that stops reporting after the expiry", async () => {
    await report("quiet", "background");
    await report("chatty", "active");
    await expectLevel("active");
    // `chatty` keeps reporting; `quiet` does not.
    const keepAlive = setInterval(() => void report("chatty", "idle"), 500);
    try {
      await expectLevel("idle", TTL_MS + 5_000);
    } finally {
      clearInterval(keepAlive);
    }
    // Once everyone is silent for the expiry, the level is the fallback: idle.
    await release("chatty");
    await report("gone", "background");
    await expectLevel("background");
    await expectLevel("idle", TTL_MS + 5_000);
  });

  it("refuses a caller without a token", async () => {
    for (const [procedure, input] of [
      ["services.setActivity", { activity: "active", clientId: "anon" }],
      ["services.releaseActivity", { clientId: "anon" }],
    ] as const) {
      const res = await fetch(`${server.url}/trpc/${procedure}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      expect(res.status, procedure).toBe(401);
    }
    const query = await fetch(`${server.url}/trpc/services.getActivity`);
    expect(query.status).toBe(401);
  });

  it("keeps an active client when other clients flood the cap with background ids", async () => {
    await report("watcher", "active");
    for (let i = 0; i < 70; i++) await report(`flood-${i}`, "background");
    await expectLevel("active");
    await release("watcher");
    for (let i = 0; i < 70; i++) await release(`flood-${i}`);
  });

  it("refuses an unknown level and an oversized client id", async () => {
    const bad = await trpcMutate(
      server.url,
      "services.setActivity",
      { activity: "turbo", clientId: "x" },
      TOKEN,
    );
    expect(bad.status).toBe(400);
    const long = await trpcMutate(
      server.url,
      "services.setActivity",
      { activity: "active", clientId: "x".repeat(65) },
      TOKEN,
    );
    expect(long.status).toBe(400);
  });
});
