// The status a chat reports on its worktree: working, monitoring, question,
// done, failed or idle. Chats run against the scripted stub agent
// (`tests/fixtures/acp-stub-agent.mjs`), which can refuse, hit a limit, ask
// for permission, leave background work running and start turns of its own.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  openStream,
  runTurn,
  sendMessage,
  startAcpServer,
  trpc,
  turnEnded,
  WORKTREE_ID,
} from "./helpers/acp-chat";
import type { ServerHandle } from "./helpers/server";

let seq = 0;
const newChatId = () => `states-chat-${Date.now()}-${seq++}`;

/** How long the agent must stay silent before a turn it started itself counts as over. */
const QUIET_MS = 1000;
/** How long the agent's background task runs. */
const TASK_MS = 2500;

async function worktreeStatus(url: string): Promise<string | undefined> {
  const data = await trpc<{ agent?: { status: string } } | null>(
    url,
    "statuses.get",
    { worktreeId: WORKTREE_ID },
    "query",
  );
  return data?.agent?.status;
}

async function clearAttention(url: string): Promise<void> {
  await trpc(url, "statuses.clearNeedsAttention", { worktreeId: WORKTREE_ID });
}

const asyncTask = {
  asyncTaskId: "task-build",
  name: "npm run build",
  taskType: "shell",
  description: "npm run build",
  showInTranscript: false,
  canStop: true,
  toolCallId: "bg-build",
};

const backgroundBash = {
  tool: {
    toolCallId: "bg-build",
    title: "npm run build",
    kind: "execute",
    status: "pending",
    rawInput: { command: "npm run build", run_in_background: true },
    _meta: { claudeCode: { toolName: "Bash" } },
  },
};

describe("chat status states", () => {
  let server: ServerHandle;

  beforeAll(async () => {
    server = await startAcpServer({
      env: { BAND_AGENT_QUIET_MS: String(QUIET_MS) },
      turns: [
        { match: "^refuse", steps: [{ say: "I can't do that." }, { stop: "refusal" }] },
        { match: "^limit", steps: [{ say: "Partial" }, { stop: "max_tokens" }] },
        { match: "^fail", steps: [{ fail: "the model is overloaded" }] },
        { match: "^long", steps: [{ say: "Working." }, { waitForCancel: true }] },
        {
          match: "^ask",
          steps: [
            {
              permission: {
                toolCall: { toolCallId: "run-1", title: "Run tests", kind: "execute" },
                options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
              },
              after: { allow: [{ sleep: 1200 }, { say: "Ran them." }] },
            },
          ],
        },
        {
          match: "^form",
          steps: [
            {
              elicitation: {
                message: "Which one?",
                requestedSchema: { type: "object", properties: { pick: { type: "string" } } },
              },
              after: { accept: [{ sleep: 1200 }, { say: "Picked." }] },
            },
          ],
        },
        {
          match: "^build",
          steps: [
            backgroundBash,
            { toolUpdate: { toolCallId: "bg-build", status: "completed" } },
            { asyncTask },
            { say: "Started the build." },
            {
              afterMs: TASK_MS,
              later: [
                {
                  asyncTask: {
                    sessionUpdate: "async_task_state_update",
                    asyncTaskId: "task-build",
                    state: "completed",
                    toolCallId: "bg-build",
                  },
                },
              ],
            },
          ],
        },
        {
          match: "^cron",
          steps: [
            {
              tool: {
                toolCallId: "cron-1",
                title: "CronCreate",
                kind: "other",
                status: "pending",
                rawInput: { cron: "*/5 * * * *", prompt: "check" },
                _meta: { claudeCode: { toolName: "CronCreate" } },
              },
            },
            { toolUpdate: { toolCallId: "cron-1", status: "completed" } },
            { say: "Scheduled." },
          ],
        },
        { steps: [{ say: "Done." }] },
      ],
    });
  });

  afterAll(async () => {
    await server?.close();
  });

  it("a turn that ends normally is done", async () => {
    await runTurn(server.url, newChatId(), "hello");
    expect(await worktreeStatus(server.url)).toBe("done");
    await clearAttention(server.url);
    expect(await worktreeStatus(server.url)).toBe("idle");
  });

  it.each([
    ["refuse", "a refusal"],
    ["limit", "max_tokens"],
    ["fail", "a thrown prompt"],
  ])("a turn that ends with %s (%s) is failed", async (word) => {
    await runTurn(server.url, newChatId(), `${word} please`);
    expect(await worktreeStatus(server.url)).toBe("failed");
    await clearAttention(server.url);
  });

  it("a turn the user stopped is idle", async () => {
    const chatId = newChatId();
    let replied!: () => void;
    const inTurn = new Promise<void>((resolve) => {
      replied = resolve;
    });
    const stream = await openStream(server.url, chatId, {
      until: turnEnded,
      onEvent: (e) => {
        if (e.type === "update" && e.update.sessionUpdate === "agent_message_chunk") replied();
      },
    });
    await sendMessage(server.url, chatId, "long task");
    await inTurn;
    expect(await worktreeStatus(server.url)).toBe("working");

    await trpc(server.url, "tasks.abort", { worktreeId: WORKTREE_ID, chatId });
    await stream.events;
    expect(await worktreeStatus(server.url)).toBe("idle");
  });

  it("a permission request is a question, and answering it is working again", async () => {
    const chatId = newChatId();
    let requestId = "";
    const stream = await openStream(server.url, chatId, {
      until: turnEnded,
      onEvent: (e) => {
        if (e.type === "permission") requestId = e.requestId;
      },
    });
    await sendMessage(server.url, chatId, "ask first");
    await expect.poll(() => worktreeStatus(server.url)).toBe("question");

    await trpc(server.url, "chat.answer", { chatId, requestId, optionId: "allow" });
    await expect.poll(() => worktreeStatus(server.url)).toBe("working");
    await stream.events;
    expect(await worktreeStatus(server.url)).toBe("done");
    await clearAttention(server.url);
  });

  it("a form question (AskUserQuestion) is a question, and answering it is working again", async () => {
    const chatId = newChatId();
    let requestId = "";
    const stream = await openStream(server.url, chatId, {
      until: turnEnded,
      onEvent: (e) => {
        if (e.type === "elicitation") requestId = e.requestId;
      },
    });
    await sendMessage(server.url, chatId, "form please");
    await expect.poll(() => worktreeStatus(server.url)).toBe("question");

    await trpc(server.url, "chat.answerElicitation", {
      chatId,
      requestId,
      action: "accept",
      content: { pick: "a" },
    });
    await expect.poll(() => worktreeStatus(server.url)).toBe("working");
    await stream.events;
    expect(await worktreeStatus(server.url)).toBe("done");
    await clearAttention(server.url);
  });

  it("a turn that leaves a background task running is monitoring, then done when it ends", async () => {
    const chatId = newChatId();
    await runTurn(server.url, chatId, "build it in the background");
    expect(await worktreeStatus(server.url)).toBe("monitoring");

    await expect.poll(() => worktreeStatus(server.url), { timeout: 15_000 }).toBe("done");
    await clearAttention(server.url);
  });

  it("a turn that schedules a cron job is monitoring until the job's hold lapses", async () => {
    await runTurn(server.url, newChatId(), "cron it");
    expect(await worktreeStatus(server.url)).toBe("monitoring");
    // A cron job has no end Band can see: it stays monitoring, and acknowledging does not clear it.
    await clearAttention(server.url);
    expect(await worktreeStatus(server.url)).toBe("monitoring");
  });
});

describe("chat status of a turn the agent starts itself", () => {
  let server: ServerHandle;

  beforeAll(async () => {
    server = await startAcpServer({
      env: { BAND_AGENT_QUIET_MS: String(QUIET_MS) },
      turns: [
        {
          steps: [
            { say: "I will look again." },
            {
              afterMs: 1500,
              later: [{ say: "Woke up." }, { sleep: 700 }, { say: " Still checking." }],
            },
          ],
        },
      ],
    });
  });

  afterAll(async () => {
    await server?.close();
  });

  it("shows working while updates arrive outside a turn, then settles to done after a quiet period", async () => {
    await runTurn(server.url, newChatId(), "wake me");
    expect(await worktreeStatus(server.url)).toBe("done");
    await clearAttention(server.url);
    expect(await worktreeStatus(server.url)).toBe("idle");

    // The agent wakes by itself: no prompt from Band, only updates.
    await expect.poll(() => worktreeStatus(server.url), { timeout: 10_000 }).toBe("working");
    // Still working while it keeps talking, and done once it has been quiet.
    await expect.poll(() => worktreeStatus(server.url), { timeout: 10_000 }).toBe("done");
  });
});
