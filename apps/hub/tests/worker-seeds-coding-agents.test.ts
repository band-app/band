// A hub on a server has no agent CLIs of its own, so boot detection leaves
// `codingAgents` empty and the UI lists no agents. The first worker that
// reports agents fills the list in. A real `band-worker` dials a real hub.

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import { waitFor } from "./helpers/wait-for";

const TOKEN = "seed-agents-shared-secret";
const WORKER_BIN = join(import.meta.dirname, "../../worker/bin/band-worker.mjs");

const scratch: string[] = [];
let server: ServerHandle;
let worker: ChildProcess | undefined;

const tmp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};

beforeAll(async () => {
  const hubHome = createTmpHome("band-seed-agents-hub-");
  scratch.push(hubHome);
  seedSettings(hubHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome: hubHome });
}, 120_000);

afterAll(async () => {
  worker?.kill("SIGKILL");
  await server?.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

describe("coding agents on a hub with none of its own", () => {
  it("lists the agents a connected worker offers, with a default", async () => {
    const getSettings = async () =>
      trpcData<{
        codingAgents?: { id: string; type: string; label: string }[];
        defaultCodingAgent?: string;
      }>(await trpcQuery(server.url, "settings.get", undefined, TOKEN));
    expect((await getSettings()).codingAgents ?? []).toEqual([]);

    const issued = trpcData<{ token: string }>(
      await trpcMutate(server.url, "tokens.issueWorkerBootstrap", { hostName: "W" }, TOKEN),
    );
    worker = spawn(
      process.execPath,
      [
        WORKER_BIN,
        "--hub",
        server.url,
        "--token",
        issued.token,
        "--root",
        tmp("band-seed-agents-root-"),
        "--state-dir",
        tmp("band-seed-agents-state-"),
      ],
      {
        env: {
          ...process.env,
          HOME: tmp("band-seed-agents-whome-"),
          BAND_TEST_ACP_AGENT: STUB_AGENT_PATH,
        },
        stdio: "ignore",
      },
    );

    const settings = await waitFor(
      async () => {
        const s = await getSettings();
        return s.codingAgents?.length ? s : undefined;
      },
      { label: "coding agents seeded", timeoutMs: 20_000 },
    );
    expect(settings.defaultCodingAgent).toBe("claude-code");
    expect(settings.codingAgents?.map((a) => a.id)).toContain("claude-code");
    expect(settings.codingAgents?.find((a) => a.id === "claude-code")).toMatchObject({
      type: "claude-code",
      label: "Claude Code",
    });
  });
});
