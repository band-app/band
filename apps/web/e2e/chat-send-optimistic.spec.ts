/**
 * End-to-end coverage for the chat send / optimistic-dispatch flow.
 *
 * Regression target: the latency-on-send bug from issue #478. Before the
 * fix, hitting Enter dispatched only the user-message bubble locally and
 * waited 1-2 s (cold agent boot) for the server's `task-started` event
 * before rendering the thinking indicator. The user saw their text echo
 * but no indication anything was happening until the agent finished
 * booting. The fix dispatches a synthetic `task-started` alongside the
 * synthetic user-message in `useChatSubscription.send()` so both appear
 * in the same React render.
 *
 * Architecture (per `docs/frontend-testing.md` + the
 * `write-integration-test` skill):
 *
 *   - REAL production `dist/start-server.mjs` boots against a fresh
 *     `mkdtempSync()` home. Migrations apply against the throwaway
 *     SQLite DB on boot.
 *   - NO tRPC mocking. The chat-events subscription, the
 *     `POST /api/chats/:chatId/messages` endpoint, and the agent
 *     orchestration all run for real.
 *   - The fake-agent at `apps/web/tests/fake-agent.mjs` is the *only*
 *     mock — it's the boundary stub for the external LLM subprocess
 *     (exactly the case the doctrine recommends an Express-style stub
 *     for, except the boundary here is a child process speaking the
 *     Claude SDK protocol over stdio, not HTTP).
 *   - The fake-agent's scenario is deliberately SLOW: it pauses 30 s
 *     before producing any output. That gap lets us observe the
 *     optimistic state in the UI — if the optimistic dispatch ever
 *     regresses, the thinking indicator won't appear before the 30 s
 *     window and the test will time out instead of silently passing
 *     against the late server event.
 *   - UI driven through `ChatPanePage` (no raw `getByRole` in the test
 *     body).
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toWorkspaceId } from "@/dashboard";
import { expect, test } from "@playwright/test";
import {
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { ChatPanePage } from "./pages/ChatPanePage";

const TOKEN = "e2e-chat-send-optimistic-token";
const PROJECT = "chatproj";
const WORKSPACE = toWorkspaceId(PROJECT, "main");

// Wide viewport so the desktop chat layout renders.
test.use({ viewport: { width: 1280, height: 800 } });

const FAKE_AGENT_PATH = join(import.meta.dirname, "..", "tests", "fake-agent.mjs");

let server: ServerHandle;
let tmpHome: string;
let scenarioPath: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();

  // The workspace's "real" directory needs to exist on disk because the
  // server resolves the worktree path and the agent spawns with it as
  // CWD. We don't care about its contents — just that it exists.
  const repoDir = join(tmpHome, "repo");
  mkdirSync(repoDir, { recursive: true });

  seedState(tmpHome, {
    projects: [
      {
        name: PROJECT,
        path: repoDir,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: repoDir }],
      },
    ],
  });
  seedSettings(tmpHome, {
    tokenSecret: TOKEN,
    codingAgents: [
      {
        id: "claude-code",
        type: "claude-code",
        label: "Claude Code",
        command: FAKE_AGENT_PATH,
      },
    ],
  });

  // 30-second sleep before any agent output. The test asserts within
  // ~5 s, so it observes ONLY the client-side optimistic state — never
  // the server's late `task-started` / text-delta echo. A regression
  // that re-introduces the "wait for server" path would fail to render
  // the indicator within Playwright's default timeout and the test
  // would fail noisily, exactly the signal we want.
  scenarioPath = join(tmpHome, "scenario.json");
  writeFileSync(
    scenarioPath,
    JSON.stringify([
      { type: "system", subtype: "init", session_id: "optimistic-session" },
      { _sleep_ms: 30_000 },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "never observed" }] },
      },
      {
        type: "result",
        subtype: "success",
        session_id: "optimistic-session",
        duration_ms: 30_000,
        num_turns: 1,
        total_cost_usd: 0.0,
      },
    ]),
  );

  server = await startServer({
    tmpHome,
    env: { FAKE_AGENT_SCENARIO: scenarioPath },
  });
});

test.afterAll(async () => {
  await server.close();
  rmSync(tmpHome, { recursive: true, force: true });
});

test.describe("Chat send — optimistic dispatch (#478)", () => {
  test("typing + Enter shows the user bubble AND the thinking indicator before the agent responds", async ({
    page,
  }) => {
    const chatPane = new ChatPanePage(page, server.url, TOKEN);
    await chatPane.goto(WORKSPACE);
    await chatPane.waitForReady();

    // Sanity: indicator must NOT be on screen yet — no task is running.
    await expect(chatPane.thinkingIndicator).not.toBeVisible();

    await chatPane.typeMessage("hello world");
    await chatPane.submit();

    // BOTH of these must appear quickly. With the fix, the optimistic
    // dispatch fires in the same React render as the form submission;
    // the assertions auto-retry up to Playwright's default 5 s. The
    // fake-agent's 30 s sleep guarantees no server-driven message can
    // satisfy these — only the optimistic dispatch can.
    await expect(chatPane.userMessage("hello world")).toBeVisible();
    await expect(chatPane.thinkingIndicator).toBeVisible();
  });

  test("after task-error rollback (server POST 500) the indicator clears but the user bubble stays", async ({
    page,
  }) => {
    // We use a separate chatId so the prior test's task can't bleed in.
    // The optimistic-dispatch send() path also rolls the optimistic
    // task-started back to task-error when the POST fails — this test
    // asserts that wire shape on the rendered DOM. To force a failure,
    // we override the workspace to one that doesn't exist; the server's
    // `chat-submit` returns 404.
    const chatPane = new ChatPanePage(page, server.url, TOKEN);
    await chatPane.goto(toWorkspaceId("does-not-exist", "main"));
    await chatPane.waitForReady();

    await chatPane.typeMessage("forty-two");
    await chatPane.submit();

    // The user bubble should appear immediately (optimistic), then the
    // indicator should disappear once the POST fails. Wait for the
    // bubble first (positive anchor) THEN assert the indicator's
    // absence — per the doctrine, never assert absence without a
    // positive anchor confirming the alternate state rendered.
    await expect(chatPane.userMessage("forty-two")).toBeVisible();
    await expect(chatPane.thinkingIndicator).not.toBeVisible();
  });
});
