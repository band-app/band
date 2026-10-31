/**
 * The "Stalled" marker: a chat whose turn runs but whose agent has sent nothing for
 * `BAND_TURN_QUIET_STALL_MS` shows a marker, and the turn keeps running (issue #1039).
 *
 * REAL `dist/start-server.mjs` against a fresh home, the scripted ACP stub agent holding a turn
 * open, and the UI driven through `ChatPanePage`. No tRPC mocking.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import { acpStubEnv } from "./helpers/acp-stub";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { trpcMutate, trpcQuery } from "./helpers/trpc";
import { ChatPanePage } from "./pages/ChatPanePage";

const TOKEN = "e2e-chat-stalled-token";
const REPO = "stalledproj";
const WORKTREE = toWorktreeId(REPO, "main", "local");
const CHAT_ID = "chat-stalled";

test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

interface ListedChat {
  id: string;
  stalled: boolean;
  status: string;
}

const listChats = async () =>
  (
    await trpcQuery<{ chats: ListedChat[] }>(server.url, TOKEN, "chats.list", {
      worktreeId: WORKTREE,
    })
  ).chats;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repoDir = join(tmpHome, "repo");
  mkdirSync(repoDir, { recursive: true });
  seedState(tmpHome, {
    repos: [
      {
        name: REPO,
        path: repoDir,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: repoDir }],
      },
    ],
  });
  seedSettings(tmpHome, {
    tokenSecret: TOKEN,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
  });
  server = await startServer({
    tmpHome,
    env: {
      ...acpStubEnv(tmpHome, {
        turns: [{ steps: [{ say: "Started a subagent." }, { waitForCancel: true }] }],
      }),
      BAND_TURN_QUIET_STALL_MS: "1500",
    },
  });
  await trpcMutate(server.url, TOKEN, "chats.create", {
    worktreeId: WORKTREE,
    id: CHAT_ID,
    agent: "claude-code",
  });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  if (server) await server.close();
  cleanupTmpHome(tmpHome);
});

test("a turn held open with no updates shows the Stalled marker and keeps running", async ({
  page,
}) => {
  const chatPane = new ChatPanePage(page, server.url, TOKEN);
  await chatPane.goto(WORKTREE);
  await chatPane.waitForReady();
  await expect(chatPane.stalledPill).toHaveCount(0);

  await chatPane.typeMessage("hold the turn open");
  await page.keyboard.press("Enter");

  await expect
    .poll(async () => (await listChats()).find((c) => c.id === CHAT_ID)?.stalled, {
      timeout: 20_000,
    })
    .toBe(true);

  // The pill reads the list on mount and every 30 s, so a reload shows it at once.
  await chatPane.reload();
  await chatPane.waitForReady();
  await expect(chatPane.stalledPill).toBeVisible();
  expect((await listChats()).find((c) => c.id === CHAT_ID)?.status).toBe("running");
});
