/**
 * The cold subscribe window is bounded by logged rows as well as turns: an
 * agentic turn logs hundreds of rows, so HISTORY_PAGE_SIZE turns alone can
 * be thousands. Black-box, like `chat-history.test.ts`: a real server with
 * the stub ACP agent, whose every turn streams 120 text chunks (120 rows).
 */

import { type ChatEvent, HISTORY_PAGE_MAX_ROWS } from "@band-app/shared/chat-events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  collectEvents,
  sendMessage,
  startAcpServer,
  TEST_TOKEN,
  WORKTREE_ID,
} from "./helpers/acp-chat";
import type { ServerHandle } from "./helpers/server";
import { listTasksForWorktree } from "./helpers/tasks";
import { waitFor } from "./helpers/wait-for";

const CHAT_ID = "row-bound-chat";
const TURNS = 8;
const CHUNKS = 120;
const prompts = Array.from({ length: TURNS }, (_, i) => `turn ${i + 1}`);

let server: ServerHandle;
let cold: ChatEvent[];

beforeAll(async () => {
  server = await startAcpServer({
    turns: [{ steps: [{ say: "x".repeat(CHUNKS * 4), chunks: CHUNKS }] }],
  });
  for (const text of prompts) await sendMessage(server.url, CHAT_ID, text);
  await waitFor(
    async () => {
      const tasks = await listTasksForWorktree(server.url, WORKTREE_ID, TEST_TOKEN);
      return tasks.filter((t) => t.status === "completed").length === TURNS;
    },
    { timeoutMs: 60_000, intervalMs: 200, label: `${TURNS} turns completed` },
  );
  cold = await collectEvents(server.url, CHAT_ID, { until: (e) => e.type === "history-meta" });
}, 90_000);

afterAll(async () => {
  if (server) await server.close();
});

describe("cold subscribe row bound", () => {
  it("keeps whole turns and stays within the row bound", () => {
    const sent = prompts.filter((p) => cold.some((e) => e.type === "prompt" && e.text === p));
    // 120 chunk rows per turn: two turns fit 300 rows, a third does not.
    expect(sent).toEqual(prompts.slice(-2));
    const meta = cold.find((e) => e.type === "history-meta");
    expect(meta).toMatchObject({ type: "history-meta", hasOlder: true });
    // The window starts at a turn's prompt, so a tool call and its result
    // are never split across pages.
    expect(cold.find((e) => e.eventId > 0)).toMatchObject({ type: "prompt", text: "turn 7" });
    // Text chunks of one message are merged on the wire.
    expect(cold.filter((e) => e.eventId > 0).length).toBeLessThan(HISTORY_PAGE_MAX_ROWS);
  });
});
