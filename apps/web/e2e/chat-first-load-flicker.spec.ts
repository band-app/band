/**
 * Frontend integration test for the chat first-load flicker fix.
 *
 * Bug: on the first load of a long conversation, the dynamic-height
 * virtualizer (`VirtualizedMessageList`) mounts every windowed row at
 * the `estimateSize` guess, then rewrites each row's `translateY` as
 * TanStack's ResizeObserver reports real heights. Because rows are
 * `position:absolute`, the frames where some offsets use the estimate
 * and others use real measurements briefly OVERLAP — the user sees
 * text rendered on top of text, with the scroller jumping as
 * `use-stick-to-bottom` re-pins on each measurement.
 *
 * Fix (reveal gate): keep the list `visibility:hidden` for the first
 * two animation frames after mount, let the convergence run off-screen,
 * then reveal it pinned to the bottom.
 *
 * What this test proves:
 *
 *   1. **The user never sees overlapping rows.** A per-frame sampler
 *      (installed before navigation) records, for every animation frame
 *      from page load, whether the list was visually shown and whether
 *      its mounted rows overlapped on screen. No frame is allowed to be
 *      BOTH visible AND overlapping — that's the flicker, made invisible
 *      by the gate.
 *
 *   2. **No scroll jump on reveal.** The first frame in which the list
 *      is visible with rows mounted is already pinned to the bottom.
 *
 *   3. **The gate doesn't break stick-to-bottom.** Once loaded, the last
 *      seeded message is visible (the conversation parked at the end).
 *
 * Architecture mirrors `chat-virtualization.spec.ts`: REAL production
 * `dist/start-server.mjs` against a fresh tmp home, NO tRPC mocking, a
 * session seeded in the ACP stub agent's store is imported with
 * `session/load` and replayed by the chat-events SSE stream, and the UI is
 * driven through `ChatPanePage`.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import { acpStubEnv, type SeededTurn, seedStubSession } from "./helpers/acp-stub";
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

const TOKEN = "e2e-chat-first-load-flicker-token";
const PROJECT = "flickerproj";
const WORKSPACE = toWorkspaceId(PROJECT, "main");
const CHAT_ID = "flicker-chat-deterministic-id";
const SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

// Long enough that the windowed rows have real, varied heights and the
// pre-fix convergence cascade is measurable, without ballooning replay
// cost. Each turn writes one user + one assistant message.
const TURNS = 300;

// Wide viewport so useIsDesktop() reports true and the shared dockview
// renders the chat pane in its desktop layout.
test.use({ viewport: { width: 1280, height: 800 } });

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
      },
    ],
  });

  // Seed the session in the stub agent's own store, as if an earlier agent
  // process had recorded it. Band has never seen it, so pointing the chat
  // at it makes the server `session/load` it: the stub replays every turn
  // as `user_message_chunk` + `agent_message_chunk` updates, which Band
  // writes to its event log.
  seedStubSession(tmpHome, { sessionId: SESSION_ID, cwd: repoDir, turns: buildTurns(TURNS) });

  server = await startServer({ tmpHome, env: acpStubEnv(tmpHome) });

  // Pre-create the chat with a deterministic id and point it at the
  // seeded session, hitting the real tRPC surface so the dashboard's
  // saved-layout + active-session bookkeeping matches production.
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

test.describe("Chat first-load flicker", () => {
  test("long conversation first load never shows overlapping rows and reveals pinned to the bottom", async ({
    page,
  }) => {
    const chatPane = new ChatPanePage(page, server.url, TOKEN);

    // Install the per-frame sampler BEFORE navigating so it captures the
    // first frames the virtualized list paints.
    await chatPane.installFirstPaintObserver();

    await chatPane.goto(WORKSPACE);
    await chatPane.waitForReady();

    // The list mounts once the subscription has replayed the session.
    // With the reveal gate the container starts `visibility:hidden`, so
    // `toBeVisible()` resolves only after the gate flips it on — exactly
    // the post-convergence state we want to assert against.
    await chatPane.waitForVirtualList(15_000);

    // Positive anchor: replay finished AND stick-to-bottom parked at the
    // end — the bottom row only mounts when the viewport is at the end.
    const lastAssistantTag = assistantText(TURNS - 1);
    await expect(chatPane.assistantMessage(lastAssistantTag)).toBeVisible({
      timeout: 30_000,
    });

    // Give the sampler a couple more frames after the last message is
    // painted so the "settled, visible, pinned" frames are recorded.
    // `expect.poll` (no fixed sleep) waits until we've actually observed
    // visible frames carrying more than one mounted row.
    await expect
      .poll(
        async () =>
          (await chatPane.readFirstPaintSamples()).filter((s) => s.visible && s.rowCount > 1)
            .length,
        { timeout: 10_000, interval: 200 },
      )
      .toBeGreaterThan(0);

    const samples = await chatPane.readFirstPaintSamples();

    // Core regression assertion: across EVERY animation frame from page
    // load, no frame was both visually shown and overlapping. On the
    // pre-fix build the list is visible from its first mount frame, so
    // the overlapping convergence frames are visible and this fails.
    const visibleOverlapFrames = samples.filter((s) => s.visible && s.overlap);
    expect(visibleOverlapFrames).toEqual([]);

    // No scroll jump / layout thrash on reveal: in every frame the list
    // was visible, the scroller stayed at the bottom. The bug parks the
    // viewport at the fictional estimate-based bottom (or top) and
    // thrashes by tens of thousands of px as rows measure; the gate
    // reveals only after the layout has settled AND pinned, so every
    // visible frame sits at the latest message. The 64px tolerance is
    // generous against sub-row settling (under one message height) yet
    // far below the tens-of-thousands-of-px jump the regression shows.
    const visibleOffsets = samples.filter((s) => s.visible).map((s) => s.bottomOffset);
    // Guard against a vacuous pass: with no visible samples
    // `Math.max(...[])` is `-Infinity`, which would satisfy `< 64` and
    // silently hide a regression. The poll above already proves visible
    // frames exist; assert it explicitly so a future refactor can't
    // erode it.
    expect(visibleOffsets.length).toBeGreaterThan(0);
    expect(Math.max(...visibleOffsets)).toBeLessThan(64);
  });
});

// ---------------------------------------------------------------------------
// Helpers (mirrors chat-virtualization.spec.ts — each spec owns its own
// deterministic turn builder so they stay independently readable).
// ---------------------------------------------------------------------------

/** `turns` user→assistant pairs, each carrying index-bearing text so the
 *  test can address a specific message without matching the wrong row. */
function buildTurns(turns: number): SeededTurn[] {
  return Array.from({ length: turns }, (_, i) => ({ user: userText(i), agent: assistantText(i) }));
}

function userText(turn: number): string {
  return `flicker-prompt-${turn}-marker`;
}

/** Distinct per-turn reply text. Every third turn is several lines long
 *  so adjacent rows differ enough in height to expose the pre-fix
 *  estimate/measured overlap. */
function assistantText(turn: number): string {
  const tag = `flicker-reply-${turn}-marker`;
  if (turn % 3 === 0) {
    return `${tag}\n\nThis reply spans multiple lines so its measured height\ndiffers substantially from the ${220}px row estimate, which is\nthe condition that produced overlapping rows before the gate.`;
  }
  return tag;
}
