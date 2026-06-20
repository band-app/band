/**
 * Frontend integration test for chat message-list virtualization (issue
 * tracking renderer memory: live profiling found ~88% of the desktop
 * renderer's DOM was un-virtualized chat history; a 600-turn
 * conversation produced ~30k DOM nodes and held the renderer at ~1 GB
 * resident). The fix mounts only messages near the viewport via
 * `@tanstack/react-virtual` inside `<StickToBottom.Content>`.
 *
 * Doctrine references:
 *   - `docs/integration-testing.md` — the why behind real-server +
 *     Express-stub testing.
 *   - `.claude/skills/write-integration-test/SKILL.md` — the operational
 *     playbook this spec follows.
 *   - `.claude/testing-criteria.md` (TEST-1...TEST-35) — the
 *     reviewer-enforced rules.
 *
 * What this test proves:
 *
 *   1. **Windowing works.** A chat seeded with a 500-turn
 *      (1000-message) session renders only a handful of message rows
 *      in the DOM at any one time — well below the total.
 *
 *   2. **Stick-to-bottom still works.** On cold load with a long
 *      conversation, the last (most recent) message is the one visible
 *      in the viewport, not the first.
 *
 *   3. **Scrolling reveals earlier messages.** Scrolling the chat
 *      container to the top brings the first seeded message into the
 *      DOM (the virtualizer mounts it on demand).
 *
 * Architecture:
 *
 *   - REAL production `dist/start-server.mjs` against a fresh
 *     `mkdtempSync()` home. Migrations run on boot.
 *   - NO tRPC mocking; the chat-events SSE stream replays our
 *     seeded JSONL through the real Claude Code adapter
 *     (`getSessionMessages` reads the file from disk).
 *   - The chat row + chat dockview layout are seeded through real
 *     tRPC calls (`chats.create` + `chats.setActiveSession`) BEFORE
 *     the user navigates — that way the dashboard's saved layout
 *     reflects our chosen `chatId` and we don't fight with the
 *     `createDefaultPanel` fallback.
 *   - The fake-agent path is configured so the claude-code adapter
 *     resolves cleanly; the binary is never spawned (we don't submit
 *     a message in this test — replay is all we need).
 *   - UI driven through `ChatPanePage` (page-object pattern); no
 *     `page.getByTestId` / `page.getByText` / `page.evaluate`
 *     querySelector lookups in the test body.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { ChatPanePage } from "./pages/ChatPanePage";

const TOKEN = "e2e-chat-virtualization-token";
const PROJECT = "virtproj";
const WORKSPACE = toWorkspaceId(PROJECT, "main");
const CHAT_ID = "virt-chat-deterministic-id";
const SESSION_ID = "11111111-2222-3333-4444-555555555555";

// Total seeded turns. Each turn writes one user + one assistant message,
// so the rendered conversation is 2 × TURNS messages. 500 is large
// enough to make windowing measurable (renderer should ideally cap at
// a few dozen rows mounted) without ballooning test cost.
const TURNS = 500;

// Wide viewport so useIsDesktop() reports true and the shared dockview
// renders the chat pane in its desktop layout (mobile layout has a
// different DOM structure).
test.use({ viewport: { width: 1280, height: 800 } });

const FAKE_AGENT_PATH = join(import.meta.dirname, "..", "tests", "fake-agent.mjs");

let server: ServerHandle;
let tmpHome: string;
let repoDir: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();

  repoDir = join(tmpHome, "repo");
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
        // The binary path only matters if we spawn a task — we don't
        // here. Still required so the agent config validates.
        command: FAKE_AGENT_PATH,
      },
    ],
  });

  // Seed the session JSONL on disk in the Claude Code SDK's expected
  // layout: `<HOME>/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`.
  // The encoded path replaces every non-alphanumeric char with `-` —
  // matches the SDK's hashing in `getSessionMessages`.
  const encodedRepoDir = repoDir.replace(/[^a-zA-Z0-9]/g, "-");
  const projectDir = join(tmpHome, ".claude", "projects", encodedRepoDir);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, `${SESSION_ID}.jsonl`), buildLongSessionJsonl(SESSION_ID, TURNS));

  server = await startServer({
    tmpHome,
    env: {
      // Empty scenario — the agent binary isn't spawned in this test,
      // but the env var is still read on boot.
      FAKE_AGENT_SCENARIO: "",
    },
  });

  // Pre-create the chat with a deterministic id (so the dashboard's
  // saved-layout lookup finds it) and point it at our seeded session.
  // Hitting the real tRPC surface keeps the layout/active-session
  // bookkeeping consistent with the production code paths.
  await trpcMutate("chats.create", {
    workspaceId: WORKSPACE,
    id: CHAT_ID,
    agent: "claude-code",
  });
  // `chats.update` doesn't take sessionId — `setActiveSession` does, and
  // it also synchronously resolves the on-disk summary via the agent so
  // the chat row carries a valid `activeSessionSummary` before the
  // chat-events subscription opens.
  await trpcMutate("chats.setActiveSession", {
    workspaceId: WORKSPACE,
    chatId: CHAT_ID,
    sessionId: SESSION_ID,
  });
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test.describe("Chat message-list virtualization", () => {
  test("long conversation renders only a windowed slice of messages and stays scrolled to bottom", async ({
    page,
  }) => {
    const chatPane = new ChatPanePage(page, server.url, TOKEN);
    await chatPane.goto(WORKSPACE);
    await chatPane.waitForReady();

    // Wait for the virtualized list container to mount. Its appearance
    // means the chat-events subscription has resolved the seeded
    // session and the reducer has at least one message to render.
    await expect(chatPane.virtualList).toBeVisible({ timeout: 15_000 });

    // Wait for the LAST seeded message text to be present. That's how
    // we know JSONL replay completed AND stick-to-bottom did its
    // initial scroll — the bottom row mounts only when the viewport
    // is at the end of the list.
    const lastAssistantTag = assistantText(TURNS - 1);
    await expect(chatPane.assistantMessage(lastAssistantTag)).toBeVisible({
      timeout: 30_000,
    });

    // Windowing assertion — the number of mounted message rows must be
    // a small fraction of the total. A non-virtualized list would
    // mount all 1000 rows. The exact cap depends on viewport height
    // and overscan; well below 100 leaves plenty of headroom for
    // safe variation across CI runners and rules out the
    // un-virtualized regression cleanly. `expect.poll` lets the bound
    // itself auto-retry — the visibility wait above already proves at
    // least one row mounted, so we don't need a separate "> 0" check.
    await expect.poll(() => chatPane.messageRowCount()).toBeLessThan(100);

    // The very first seeded message must NOT be in the DOM right now —
    // the user is parked at the bottom of a 1000-message conversation,
    // there's no way the row at position 0 is mounted. This is the
    // dual of the bounded-row assertion: it pins *which* rows are
    // mounted, not just how many.
    const firstUserTag = userText(0);
    await expect(chatPane.userMessage(firstUserTag)).toHaveCount(0);

    // Scroll to the top of the chat container via the page-object
    // helper — drives the virtualizer's on-demand mount path so the
    // earliest rows enter the DOM.
    await chatPane.scrollToTop();
    await expect(chatPane.userMessage(firstUserTag)).toBeVisible({
      timeout: 10_000,
    });

    // After scrolling up, the bottom row is no longer mounted — the
    // window moved. This proves the renderer is genuinely swapping
    // rows in and out (not just rendering everything and scrolling).
    await expect(chatPane.assistantMessage(lastAssistantTag)).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Real tRPC mutation hitting the server's HTTP surface. Same shape as
 * the queue-ui spec — keeps the test's setup path identical to a real
 * client's so the chat row + layout end up in the same on-disk state
 * as a production user clicking the same buttons.
 */
async function trpcMutate(procedure: string, input: unknown): Promise<void> {
  const res = await fetch(`${server.url}/trpc/${procedure}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `band_token=${TOKEN}`,
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`trpcMutate(${procedure}) failed: ${res.status} ${text}`);
  }
}

/** Build a Claude Code session JSONL with `turns` user→assistant
 *  message pairs. Each prompt and reply carries a unique tag so the
 *  test can `page.getByText(tag)` against a specific message without
 *  matching the wrong row. */
function buildLongSessionJsonl(sessionId: string, turns: number): string {
  const lines: string[] = [];
  let parentUuid: string | null = null;
  for (let i = 0; i < turns; i++) {
    const userUuid = uuid(i * 2 + 1);
    const assistantUuid = uuid(i * 2 + 2);
    const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, i * 2)).toISOString();
    lines.push(
      JSON.stringify({
        type: "user",
        uuid: userUuid,
        parentUuid,
        sessionId,
        isSidechain: false,
        userType: "external",
        message: { role: "user", content: [{ type: "text", text: userText(i) }] },
        timestamp: ts,
      }),
    );
    lines.push(
      JSON.stringify({
        type: "assistant",
        uuid: assistantUuid,
        parentUuid: userUuid,
        sessionId,
        isSidechain: false,
        message: { role: "assistant", content: [{ type: "text", text: assistantText(i) }] },
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i * 2 + 1)).toISOString(),
      }),
    );
    parentUuid = assistantUuid;
  }
  // last-prompt record — surfaced as the session summary.
  lines.push(
    JSON.stringify({
      type: "last-prompt",
      sessionId,
      lastPrompt: userText(turns - 1),
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, turns * 2)).toISOString(),
      uuid: uuid(turns * 2 + 1),
      parentUuid: null,
    }),
  );
  return `${lines.join("\n")}\n`;
}

function uuid(n: number): string {
  return `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
}

/** Distinct, easily-matchable text per turn — index-bearing so we can
 *  query for a specific message without ambiguity. */
function userText(turn: number): string {
  return `virt-prompt-${turn}-marker`;
}

function assistantText(turn: number): string {
  return `virt-reply-${turn}-marker`;
}
