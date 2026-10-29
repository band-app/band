/**
 * What the update dialog says about running chat agents. A worker that holds its agents in the
 * agent daemon keeps them through the restart, so the dialog (and "Update all workers") lists only
 * the agents that will be restarted: those on a worker with no agent daemon.
 *
 * Both workers are stand-ins on the real link protocol that run the scripted ACP agent; one says
 * its agents are held, the other does not. The hub, the chats and the update panel are real.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { expect, test } from "@playwright/test";
import {
  type ReleasesStub,
  startReleasesStub,
} from "../../hub/tests/fixtures/github-releases-stub";
import { connectStandInWorker, type StandInWorker } from "../../hub/tests/helpers/stand-in-worker";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedHostWorktree,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { trpcMutate, trpcQuery } from "./helpers/trpc";
import { UpdatePanelPage } from "./pages/UpdatePanelPage";

const TOKEN = "e2e-update-agents-token";
const HUB_VERSION = "0.50.0";
const REPO = "proj";

let releases: ReleasesStub;
let server: ServerHandle;
let tmpHome: string;
let held: StandInWorker;
let plain: StandInWorker;
const updated: string[] = [];

/** Starts a chat on `hostId`'s worktree and waits until the hub lists its agent as running there. */
async function runAgentOn(hostId: string, branch: string, expectedAgents: number): Promise<void> {
  const worktreeId = toWorktreeId(REPO, branch, hostId);
  const chatId = `chat-${branch}`;
  await trpcMutate(server.url, TOKEN, "chats.create", { worktreeId, id: chatId });
  const res = await fetch(`${server.url}/api/chats/${chatId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `band_token=${TOKEN}` },
    body: JSON.stringify({ worktreeId, text: "hello agent" }),
  });
  expect(res.ok).toBe(true);
  await expect
    .poll(
      async () => {
        const status = await trpcQuery<{ agents: unknown[] }>(
          server.url,
          TOKEN,
          "workers.interruptions",
          { hostId },
        );
        return status.agents.length;
      },
      { timeout: 30_000 },
    )
    .toBe(expectedAgents);
}

test.describe("agents and the update dialog", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    releases = await startReleasesStub("v9.0.0");
    tmpHome = createTmpHome();
    const hubRepo = join(tmpHome, "hub-repo");
    mkdirSync(hubRepo, { recursive: true });
    seedSettings(tmpHome, {
      tokenSecret: TOKEN,
      codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
      defaultCodingAgent: "claude-code",
    });
    seedState(tmpHome, {
      repos: [
        {
          name: REPO,
          path: hubRepo,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: hubRepo }],
        },
      ],
    });
    server = await startServer({
      tmpHome,
      env: {
        BAND_GITHUB_API_URL: releases.url,
        BAND_INSTALL_METHOD: "compose",
        BAND_HUB_VERSION: HUB_VERSION,
      },
    });
    const onUpdate = (name: string, worker: () => StandInWorker) => () => {
      updated.push(name);
      setTimeout(() => void worker().reconnect(HUB_VERSION), 200);
      return { ok: true };
    };
    held = await connectStandInWorker(
      {
        hubUrl: server.url,
        adminToken: TOKEN,
        name: "held-box",
        version: "0.49.0",
        serviceManager: "systemd",
        agents: { held: true },
      },
      onUpdate("held", () => held),
    );
    plain = await connectStandInWorker(
      {
        hubUrl: server.url,
        adminToken: TOKEN,
        name: "plain-box",
        version: "0.49.0",
        serviceManager: "systemd",
        agents: { held: false },
      },
      onUpdate("plain", () => plain),
    );
    for (const [worker, branch] of [
      [held, "on-held"],
      [plain, "on-plain"],
    ] as const) {
      const path = join(tmpHome, branch);
      mkdirSync(path, { recursive: true });
      seedHostWorktree(tmpHome, { repo: REPO, name: branch, branch, path, hostId: worker.hostId });
    }
    await runAgentOn(plain.hostId, "on-plain", 1);
    // The held agent is running too, but it is not one the restart will end.
    await runAgentOn(held.hostId, "on-held", 0);
  });

  test.beforeEach(() => resetClientState(tmpHome));

  test.afterAll(async () => {
    await held?.close();
    await plain?.close();
    await server?.close();
    await releases?.close();
    cleanupTmpHome(tmpHome);
  });

  test("the confirm dialog lists the agent that will be restarted and not the held one", async ({
    page,
  }) => {
    const update = new UpdatePanelPage(page, server.url, TOKEN);
    await update.goto();
    await update.openPanel();

    await update.clickUpdate(held.hostId);
    await expect(update.confirmAgents()).toHaveAttribute("data-state", "none");
    await update.cancelUpdate();

    await update.clickUpdate(plain.hostId);
    await expect(update.confirmAgents()).toHaveAttribute("data-state", "some");
    await expect(update.confirmAgents().getByTestId("update-worker__agent")).toHaveCount(1);
    await update.cancelUpdate();
    expect(updated).toEqual([]);
  });

  test("Update all workers goes through the worker with a held agent and skips the other", async ({
    page,
  }) => {
    const update = new UpdatePanelPage(page, server.url, TOKEN);
    await update.goto();
    await update.openPanel();
    await update.updateAllButton().click();

    await expect(update.updateAllResult(held.hostId)).toHaveAttribute("data-state", "updated", {
      timeout: 30_000,
    });
    await expect(update.updateAllResult(plain.hostId)).toHaveAttribute("data-state", "skipped");
    await expect(update.updateAllResult(plain.hostId)).toContainText("1 agent is running");
    expect(updated).toEqual(["held"]);
  });
});
