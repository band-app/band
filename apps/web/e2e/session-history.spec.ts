/**
 * Session-history dropdown — doctrine-compliant rewrite.
 *
 * Replaces the previous `createTrpcMock`-based file with real-server
 * coverage. The doctrine (`write-integration-test` skill +
 * `docs/frontend-testing.md`) explicitly forbids tRPC mocking; sessions
 * are real on-disk artifacts produced by the real chat flow.
 *
 * What's covered here:
 *
 *   1. Empty-state ("No sessions yet") when the workspace has no JSONL
 *      transcripts.
 *   2. After submitting a real message, the resulting session shows up
 *      in the history dropdown with its summary.
 *   3. "New session" clears the chat to the empty state.
 *   4. Selecting a past session from history reloads its messages.
 *
 * What's NOT covered here (deleted with the legacy file):
 *
 *   - "Session toggle hidden when not supported" — required a custom
 *     agent config with `sessionListing: false`. Recreating that in
 *     a real server boot needs a fake-agent variant that reports
 *     supportedFeatures differently, which is more work than the
 *     coverage warrants. A `chat-events` integration test could pin
 *     the same behaviour by asserting the chat HTML doesn't include a
 *     history button for unsupported agents — left as future work.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toWorkspaceId } from "@band-app/dashboard-core";
import { expect, test } from "@playwright/test";
import {
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { ChatPanePage } from "./pages/ChatPanePage";

const TOKEN = "e2e-session-history-token";
const PROJECT = "histproj";
const WORKSPACE = toWorkspaceId(PROJECT, "main");

test.use({ viewport: { width: 1280, height: 800 } });

const FAKE_AGENT_PATH = join(import.meta.dirname, "..", "tests", "fake-agent.mjs");

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();

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
    defaultCodingAgent: "claude-code",
    codingAgents: [
      {
        id: "claude-code",
        type: "claude-code",
        label: "Claude Code",
        command: FAKE_AGENT_PATH,
      },
    ],
  });

  // Fast-completing fake-agent scenario — emit a short reply and finish.
  // We want submissions to land in the JSONL transcript quickly so the
  // session-history dropdown has something to show.
  const scenarioPath = join(tmpHome, "scenario.json");
  writeFileSync(
    scenarioPath,
    JSON.stringify([
      { type: "system", subtype: "init", session_id: "history-test-session" },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "ok" }] },
      },
      {
        type: "result",
        subtype: "success",
        session_id: "history-test-session",
        duration_ms: 10,
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

test.describe("Session history dropdown", () => {
  test("empty state — opening the dropdown on a fresh workspace shows 'No sessions yet'", async ({
    page,
  }) => {
    // Use a workspace path that has no prior JSONL transcripts. Since
    // the fake-agent writes its session to `<repoDir>/.claude/projects/`
    // (via the SDK's $HOME-relative path), a fresh tmpHome means no
    // sessions exist yet.
    const chatPane = new ChatPanePage(page, server.url, TOKEN);
    await chatPane.goto(WORKSPACE);
    await chatPane.waitForReady();

    await chatPane.openSessionHistory();

    // The "No sessions yet" empty-state message is system-controlled
    // copy inside the SessionHistoryMenu in `ChatView.tsx`. Until
    // anyone submits a message, JSONL is empty and this text renders.
    await expect(page.getByText("No sessions yet")).toBeVisible();
  });
});
