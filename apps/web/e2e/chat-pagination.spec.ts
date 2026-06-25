/**
 * Frontend integration test for chat scroll-back pagination (issue #572).
 *
 * Builds on the virtualization work (#586): the DOM is already windowed to a
 * handful of rows. This spec proves the DATA layer is now windowed too — a cold
 * subscribe replays only the most recent `COLD_REPLAY_LIMIT` (50) messages, and
 * scrolling to the top fetches + prepends the previous page on demand, with no
 * visible scroll jump and without breaking stick-to-bottom.
 *
 * Boots the real production server, drives through Playwright + a page object,
 * no tRPC mocking. The chat-events SSE stream + the new
 * `GET /api/chats/:id/history` endpoint replay the seeded JSONL through the real
 * Claude Code adapter (`getSessionMessages` reads the file from disk). The spec
 * body never touches `page.goto` / `page.getByTestId` directly — locators live
 * on `ChatPanePage`.
 *
 * What this proves (the issue's acceptance criteria):
 *   1. Cold load fetches only the recent window — the first seeded message is
 *      not loaded at all initially.
 *   2. Scrolling to the top pages older history in, all the way back to the
 *      first message.
 *   3. No visible scroll jump when a page prepends (the anchor row's on-screen
 *      position stays put across the prepend).
 *   4. Stick-to-bottom still reaches the latest message after older pages load.
 *   5. The DOM stays virtualized throughout (no row-count blow-up).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import { fakeAgentPath } from "./helpers/fake-agent";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { trpcMutate } from "./helpers/trpc";
import { ChatPanePage } from "./pages/ChatPanePage";

const TOKEN = "e2e-chat-pagination-token";
const PROJECT = "pageproj";
const WORKSPACE = toWorkspaceId(PROJECT, "main");
const CHAT_ID = "page-chat-deterministic-id";
const SESSION_ID = "22222222-3333-4444-5555-666666666666";

// 200 turns = 400 messages. The cold window is 50 messages (25 turns), so
// reaching the first message requires paging back through several pages —
// enough to exercise repeated prepends without ballooning test cost.
const TURNS = 200;
// Oldest turn present in the initial 50-message window (50 messages = 25 turns).
// Mirrors `COLD_REPLAY_LIMIT` in `apps/web/src/api/chat-events.ts`.
const OLDEST_WINDOW_TURN = TURNS - 25;

test.use({ viewport: { width: 1280, height: 800 } });

const FAKE_AGENT_PATH = fakeAgentPath();

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
      { id: "claude-code", type: "claude-code", label: "Claude Code", command: FAKE_AGENT_PATH },
    ],
  });

  // Seed the session JSONL in the Claude Code SDK layout:
  // `<HOME>/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`.
  const encodedRepoDir = repoDir.replace(/[^a-zA-Z0-9]/g, "-");
  const projectDir = join(tmpHome, ".claude", "projects", encodedRepoDir);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, `${SESSION_ID}.jsonl`), buildLongSessionJsonl(SESSION_ID, TURNS));

  server = await startServer({ tmpHome, env: { FAKE_AGENT_SCENARIO: "" } });

  await trpcMutate(server.url, TOKEN, "chats.create", {
    workspaceId: WORKSPACE,
    id: CHAT_ID,
    agent: "claude-code",
  });
  await trpcMutate(server.url, TOKEN, "chats.setActiveSession", {
    workspaceId: WORKSPACE,
    chatId: CHAT_ID,
    sessionId: SESSION_ID,
  });
});

test.afterAll(async () => {
  if (server) await server.close();
  cleanupTmpHome(tmpHome);
});

test.describe("Chat scroll-back pagination", () => {
  test("cold load fetches only the recent window and scrolling up pages older history in", async ({
    page,
  }) => {
    const chatPane = new ChatPanePage(page, server.url, TOKEN);
    await chatPane.goto(WORKSPACE);
    await chatPane.waitForReady();
    await chatPane.waitForVirtualList(15_000);

    // Cold load lands at the bottom — the last seeded message is visible once
    // stick-to-bottom fires.
    await expect(chatPane.assistantMessage(assistantText(TURNS - 1))).toBeVisible({
      timeout: 30_000,
    });

    // The FIRST seeded message is far outside the 50-message window — it isn't
    // loaded into the reducer at all on cold subscribe (the windowing the
    // issue asks for). A non-windowed cold replay would have it in the data.
    await expect(chatPane.userMessage(userText(0))).toHaveCount(0);

    // Repeatedly scrolling to the top pages older history in. Each scroll-to-top
    // mounts the current oldest row and trips the sentinel's IntersectionObserver,
    // which fetches + prepends the previous page. We poll until the very first
    // message becomes reachable — proving pagination walks all the way back.
    //
    // `interval: 2000` gives each fetch + prepend cycle time to land before the
    // next scroll, so two `scrollToTop`s never race a mid-flight prepend. (The
    // hook's in-flight guard already dedupes concurrent loads, but the wider
    // interval keeps the poll's side effect from sampling the DOM mid-prepend.)
    await expect
      .poll(
        async () => {
          await chatPane.scrollToTop();
          return chatPane.userMessage(userText(0)).count();
        },
        { timeout: 60_000, interval: 2000 },
      )
      .toBeGreaterThan(0);

    // Even after paging in the entire history, the DOM stays windowed.
    expect(await chatPane.messageRowCount()).toBeLessThan(100);
  });

  test("prepending an older page does not jump the scroll position", async ({ page }) => {
    const chatPane = new ChatPanePage(page, server.url, TOKEN);
    await chatPane.goto(WORKSPACE);
    await chatPane.waitForReady();
    await chatPane.waitForVirtualList(15_000);
    await expect(chatPane.assistantMessage(assistantText(TURNS - 1))).toBeVisible({
      timeout: 30_000,
    });

    // Sample the on-screen position of a message that sits a few turns BELOW
    // the top of the initial window — solidly mid-viewport once we scroll up,
    // so it doesn't flicker at the fold like the exact top row would. The
    // "no jump" property applies to every visible row equally (they move
    // together), so any solidly-visible row is a valid witness. It isn't
    // mounted yet (we're at the bottom); the sampler starts recording once
    // `scrollToTop` brings it on screen.
    const anchorTag = userText(OLDEST_WINDOW_TURN + 5);
    await chatPane.installAnchorTopSampler(anchorTag);

    // Scroll to the top: this mounts the anchor row AND trips the sentinel, which
    // fetches + prepends the previous page. The scroll-anchor compensation must
    // keep the anchor row pinned — its screen position must not move as ~25 older
    // turns are inserted above it.
    await chatPane.scrollToTop();

    // Let the fetch + prepend + settle run for plenty of frames.
    await expect
      .poll(async () => (await chatPane.readAnchorTopSamples()).length, { timeout: 15_000 })
      .toBeGreaterThan(40);

    const samples = await chatPane.readAnchorTopSamples();
    // Each sample is the anchor row's on-screen `top`, once mounted. With a
    // correct anchor the row holds its position across the entire prepend; a
    // broken anchor either shoves it down by the inserted page height (it would
    // leave the viewport → the poll above never reaches 40 samples) or drifts
    // it to a different sustained position.
    //
    // We assert two things:
    //   1. NET stability — the row ends where it started (first ≈ last). This
    //      catches a sustained drift (the symptom of double-compensation) and a
    //      mis-anchored landing.
    //   2. Bulk stability — only a tiny number of frames may deviate. The
    //      prepend-commit frame can show a single sub-perceptible transient
    //      before the virtualizer settles; a real jump moves MANY frames.
    // Threshold derivation: a correctly anchored row only jitters by sub-pixel
    // measurement rounding (< a few px). The failure mode it must catch is the
    // inserted page (~25 turns × ~40px row ≈ 1000px, or up to 11000px at the
    // 220px estimate) shoving the row — orders of magnitude larger. 30px (net)
    // and 40px (per-frame) sit comfortably between real jitter and a real jump,
    // and ≤5 deviating frames tolerates the single prepend-commit transient
    // (one frame) while still failing a sustained multi-frame jump.
    // Baseline a few frames in, not samples[0]: the first frame the anchor row
    // mounts can be captured mid-layout while the virtualizer is still settling
    // initial heights, which would inflate the first-vs-last delta on a correct
    // implementation.
    const first = samples[Math.min(5, samples.length - 1)];
    const last = samples[samples.length - 1];
    expect(Math.abs(last - first)).toBeLessThan(30);

    const median = [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)];
    const deviating = samples.filter((s) => Math.abs(s - median) > 40).length;
    expect(deviating).toBeLessThanOrEqual(5);
  });

  test("stick-to-bottom still reaches the latest message after loading older pages", async ({
    page,
  }) => {
    const chatPane = new ChatPanePage(page, server.url, TOKEN);
    await chatPane.goto(WORKSPACE);
    await chatPane.waitForReady();
    await chatPane.waitForVirtualList(15_000);
    await expect(chatPane.assistantMessage(assistantText(TURNS - 1))).toBeVisible({
      timeout: 30_000,
    });

    // Page in some older history. Scrolling to the top swaps the bottom rows
    // out — proof we genuinely moved up and the window changed.
    await chatPane.scrollToTop();
    await expect
      .poll(() => chatPane.assistantMessage(assistantText(TURNS - 1)).count(), { timeout: 10_000 })
      .toBe(0);

    // Scrolling back to the bottom must still reach the latest message — the
    // load-older growth didn't corrupt the bottom of the list.
    await chatPane.scrollToBottom();
    await expect(chatPane.assistantMessage(assistantText(TURNS - 1))).toBeVisible({
      timeout: 10_000,
    });
  });
});

// ---------------------------------------------------------------------------
// Helpers (self-contained, mirroring chat-virtualization.spec.ts)
// ---------------------------------------------------------------------------

function buildLongSessionJsonl(sessionId: string, turns: number): string {
  const lines: string[] = [];
  let parentUuid: string | null = null;
  for (let i = 0; i < turns; i++) {
    const userUuid = uuid(i * 2 + 1);
    const assistantUuid = uuid(i * 2 + 2);
    lines.push(
      JSON.stringify({
        type: "user",
        uuid: userUuid,
        parentUuid,
        sessionId,
        isSidechain: false,
        userType: "external",
        message: { role: "user", content: [{ type: "text", text: userText(i) }] },
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i * 2)).toISOString(),
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

/** Index-bearing, unambiguous text per turn. The trailing `-marker` prevents
 *  prefix collisions (e.g. turn 17 vs turn 175). */
function userText(turn: number): string {
  return `page-prompt-${turn}-marker`;
}

function assistantText(turn: number): string {
  return `page-reply-${turn}-marker`;
}
