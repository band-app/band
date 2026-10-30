// Two ways a chat can wait forever on background work (issue #1039): an idle agent that waits for
// the end of a background task nobody tells it about, and a turn held open by work that never
// ends. Chats run against the scripted stub agent (`tests/fixtures/acp-stub-agent.mjs`).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  openStream,
  runTurn,
  sendMessage,
  startAcpServer,
  stubRequests,
  trpc,
  turnEnded,
  WORKTREE_ID,
} from "./helpers/acp-chat";
import type { ServerHandle } from "./helpers/server";

let seq = 0;
const newChatId = () => `wake-chat-${Date.now()}-${seq++}`;

const WAKE_MS = 500;
const STALL_MS = 1500;

const taskOf = (id: string, name: string) => ({
  asyncTaskId: id,
  name,
  taskType: "shell",
  description: name,
  showInTranscript: false,
  canStop: true,
  toolCallId: `${id}-call`,
});

const taskEnds = (id: string) => ({
  asyncTask: {
    sessionUpdate: "async_task_state_update",
    asyncTaskId: id,
    state: "completed",
    toolCallId: `${id}-call`,
  },
});

const backgroundBash = (id: string, command: string) => ({
  tool: {
    toolCallId: `${id}-call`,
    title: command,
    kind: "execute",
    status: "pending",
    rawInput: { command, run_in_background: true },
    _meta: { claudeCode: { toolName: "Bash" } },
  },
});

function prompts(server: ServerHandle): string[] {
  return stubRequests(server.home, "session/prompt").map((r) => JSON.stringify(r.params));
}

interface ListedChat {
  id: string;
  lastActivityAt: number | null;
  stalled: boolean;
  status: string;
}

async function listed(server: ServerHandle, chatId: string): Promise<ListedChat | undefined> {
  const data = await trpc<{ chats: ListedChat[] }>(
    server.url,
    "chats.list",
    { worktreeId: WORKTREE_ID },
    "query",
  );
  return data.chats.find((c) => c.id === chatId);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("background work", () => {
  let server: ServerHandle;

  beforeAll(async () => {
    server = await startAcpServer({
      env: {
        BAND_BACKGROUND_WAKE_MS: String(WAKE_MS),
        BAND_TURN_QUIET_STALL_MS: String(STALL_MS),
      },
      turns: [
        { match: "^A background task", steps: [{ say: "Carrying on." }] },
        {
          match: "^silent",
          steps: [
            backgroundBash("t-silent", "pnpm test"),
            { toolUpdate: { toolCallId: "t-silent-call", status: "completed" } },
            { asyncTask: taskOf("t-silent", "pnpm test") },
            { say: "Waiting for the notice." },
            { afterMs: 1500, later: [taskEnds("t-silent")] },
          ],
        },
        {
          match: "^notified",
          steps: [
            backgroundBash("t-own", "pnpm lint"),
            { toolUpdate: { toolCallId: "t-own-call", status: "completed" } },
            { asyncTask: taskOf("t-own", "pnpm lint") },
            { say: "Waiting for the notice." },
            {
              afterMs: 1500,
              later: [taskEnds("t-own"), { sleep: 100 }, { say: "The lint run finished." }],
            },
          ],
        },
        { match: "^hold", steps: [{ say: "Started a subagent." }, { waitForCancel: true }] },
        {
          match: "^chatty",
          steps: [
            ...Array.from({ length: 8 }, (_, i) => [{ say: `step ${i}. ` }, { sleep: 500 }]).flat(),
            { say: "Done." },
          ],
        },
        { steps: [{ say: "Done." }] },
      ],
    });
  });

  afterAll(async () => {
    await server?.close();
  });

  it("wakes an idle agent once when its background task ends and the adapter starts no turn", async () => {
    const chatId = newChatId();
    await runTurn(server.url, chatId, "silent build");
    expect(prompts(server)).toHaveLength(1);

    await expect.poll(() => prompts(server).length, { timeout: 15_000 }).toBe(2);
    const woke = prompts(server)[1];
    expect(woke).toContain("A background task you started has ended");
    expect(woke).toContain("pnpm test (completed)");

    // One message per finished task: nothing follows the wake turn.
    await sleep(WAKE_MS * 4);
    expect(prompts(server)).toHaveLength(2);
  });

  it("sends nothing when the adapter starts its own turn for the completion", async () => {
    const before = prompts(server).length;
    const chatId = newChatId();
    await runTurn(server.url, chatId, "notified build");
    await sleep(1500 + 100 + WAKE_MS * 4);
    // Only the user's own prompt reached the agent.
    expect(prompts(server)).toHaveLength(before + 1);
  });

  it("reports a turn held open with no updates as stalled, and leaves it running", async () => {
    const chatId = newChatId();
    const stream = await openStream(server.url, chatId, { until: turnEnded });
    await sendMessage(server.url, chatId, "hold on");

    await expect
      .poll(async () => (await listed(server, chatId))?.stalled, { timeout: 15_000 })
      .toBe(true);
    const chat = await listed(server, chatId);
    expect(typeof chat?.lastActivityAt).toBe("number");

    expect(chat?.status).toBe("running");

    await trpc(server.url, "tasks.abort", { worktreeId: WORKTREE_ID, chatId });
    await stream.events;
    expect((await listed(server, chatId))?.stalled).toBe(false);
  });

  it("never marks a long turn stalled while it keeps sending updates", async () => {
    const chatId = newChatId();
    const stream = await openStream(server.url, chatId, { until: turnEnded });
    await sendMessage(server.url, chatId, "chatty work");
    const seen: boolean[] = [];
    const deadline = Date.now() + 3500;
    while (Date.now() < deadline) {
      seen.push((await listed(server, chatId))?.stalled ?? false);
      await sleep(300);
    }
    expect(seen.length).toBeGreaterThan(5);
    expect(seen.every((stalled) => !stalled)).toBe(true);
    await stream.events;
  });
});
