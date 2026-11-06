/**
 * Events a chat's former worker logged after the chat continued elsewhere: the notice above the
 * chat says how many were not merged, View reads them, Discard deletes them (plan step 2.2).
 *
 * REAL `dist/start-server.mjs` against a fresh home. The hub keeps such rows in `chat_event_holds`,
 * which only a worker's replication fills, and a real replication needs a worker whose lease ran
 * out (covered by `apps/hub/tests/chat-ownership-takeover.test.ts`). Here the rows are written to
 * the hub's SQLite file, the same way the migration tests seed an old install. Every assertion
 * goes through the UI and the real `follow.*` procedures. No tRPC mocking.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
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
import { HeldEventsPage } from "./pages/HeldEventsPage";

const TOKEN = "e2e-chat-held-events-token";
const REPO = "heldproj";
const WORKTREE = toWorktreeId(REPO, "main", "local");
const CHAT_ID = "chat-held";
const OLD_WORKER = "h-oldworker0001";

test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

function holdRows(): void {
  const db = new DatabaseSync(join(tmpHome, ".band", "band.db"));
  try {
    const at = Date.now();
    const rows = [
      {
        id: 900001,
        kind: "prompt",
        event: { type: "prompt", taskId: "t1", text: "typed on the old worker" },
      },
      {
        id: 900002,
        kind: "update",
        event: {
          type: "update",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "answered on the old worker" },
          },
        },
      },
    ];
    for (const r of rows) {
      const wire = {
        id: r.id,
        chatId: CHAT_ID,
        sessionId: "s1",
        revision: 1,
        turnStart: false,
        createdAt: at + r.id,
        event: r.event,
      };
      db.prepare(
        "INSERT INTO chat_event_holds (id, host_id, chat_id, row, received_at) VALUES (?, ?, ?, ?, ?)",
      ).run(r.id, OLD_WORKER, CHAT_ID, JSON.stringify(wire), at);
    }
  } finally {
    db.close();
  }
}

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
  server = await startServer({ tmpHome });
  await trpcMutate(server.url, TOKEN, "chats.create", {
    worktreeId: WORKTREE,
    id: CHAT_ID,
    agent: "claude-code",
  });
  holdRows();
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  if (server) await server.close();
  cleanupTmpHome(tmpHome);
});

test("the notice counts the held events, View shows them read-only, Discard removes them", async ({
  page,
}) => {
  const chatPane = new ChatPanePage(page, server.url, TOKEN);
  const held = new HeldEventsPage(page);
  await chatPane.goto(WORKTREE);
  await chatPane.waitForReady();

  await expect(held.notice).toBeVisible();
  await expect(held.notice).toHaveAttribute("data-count", "2");
  await expect(held.text).toContainText("This chat continued on This hub; 2 events from");
  await expect(held.text).toContainText("were not merged");

  await held.view();
  await expect(held.transcriptLines).toHaveCount(2);
  await expect(held.transcriptLines.nth(0)).toContainText("typed on the old worker");
  await expect(held.transcriptLines.nth(1)).toContainText("answered on the old worker");
  await held.closeView();

  await held.discard();
  await expect(held.notice).toHaveCount(0);
  const after = await trpcQuery<unknown>(server.url, TOKEN, "follow.heldEvents", {
    chatId: CHAT_ID,
  });
  expect(after).toBeNull();
});
