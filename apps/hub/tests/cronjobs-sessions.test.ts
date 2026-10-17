// Cronjobs that name an agent and an agent session. A job with a session id sends its prompt to the
// chat whose active session is that id, opens a new chat on that session when none has it, and fails
// the run (no fresh session) when the agent cannot open it. The coding agent is the scripted ACP stub.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type StubRequest,
  seedAcpHome,
  sendMessage,
  startAcpServer,
  stubRequests,
  trpc,
  WORKTREE_ID,
} from "./helpers/acp-chat";
import type { ServerHandle } from "./helpers/server";
import { waitFor } from "./helpers/wait-for";

interface Chat {
  id: string;
  agent: string;
  status: string;
  activeSessionId?: string;
  labels: Record<string, string>;
}
interface Job {
  id: string;
  lastRunStatus?: string;
  lastRunMessage?: string;
}
interface Trigger {
  chatId: string;
  taskId?: string;
  queuedMessageId?: string;
}

let home: string;
let server: ServerHandle;

const chats = async () =>
  (await trpc<{ chats: Chat[] }>(server.url, "chats.list", { worktreeId: WORKTREE_ID }, "query"))
    .chats;

const createJob = (input: Record<string, unknown>) =>
  trpc<{ job: Job }>(server.url, "cronjobs.create", {
    worktreeId: WORKTREE_ID,
    name: "Pinned job",
    prompt: "pinned prompt",
    cronExpression: "0 0 1 1 *",
    ...input,
  }).then((r) => r.job);

const trigger = (id: string) =>
  trpc<Trigger>(server.url, "cronjobs.trigger", { key: WORKTREE_ID, id });

const getJob = (id: string) =>
  trpc<{ job: Job }>(server.url, "cronjobs.get", { key: WORKTREE_ID, id }, "query").then(
    (r) => r.job,
  );

const idle = (chatId: string) =>
  waitFor(
    async () => {
      const chat = (await chats()).find((c) => c.id === chatId);
      return chat && chat.status === "idle" && chat.activeSessionId ? chat : undefined;
    },
    { label: `chat ${chatId} idle with a session` },
  );

const promptsSeen = (text: string) =>
  stubRequests(home, "session/prompt").filter((r: StubRequest) =>
    (r.params.prompt as { text?: string }[]).some((b) => b.text === text),
  ).length;

/** A chat with one finished turn, so the agent holds a session for it. */
async function chatWithSession(): Promise<{ chat: Chat; sessionId: string }> {
  const { chat } = await trpc<{ chat: Chat }>(server.url, "chats.create", {
    worktreeId: WORKTREE_ID,
    name: "Seed chat",
  });
  await sendMessage(server.url, chat.id, "seed message");
  const done = await idle(chat.id);
  return { chat: done, sessionId: done.activeSessionId as string };
}

beforeAll(async () => {
  home = seedAcpHome("band-cron-sessions-");
  server = await startAcpServer({ home, turns: [{ steps: [{ say: "Done" }] }] });
});

afterAll(async () => {
  await server.close();
});

describe("cronjobs with a session id", () => {
  let seed: { chat: Chat; sessionId: string };

  it("S4: runs the prompt in the chat that has the session, without a new chat", async () => {
    seed = await chatWithSession();
    const before = (await chats()).length;
    const job = await createJob({ sessionId: seed.sessionId, via: "chat" });

    const fired = await trigger(job.id);
    expect(fired.chatId).toBe(seed.chat.id);
    await waitFor(() => (promptsSeen("pinned prompt") === 1 ? true : undefined), {
      label: "the job's prompt reached the agent",
    });
    await idle(seed.chat.id);
    expect(await chats()).toHaveLength(before);
  });

  it("S5: opens a new chat on the session when no chat has it, and reuses it", async () => {
    await trpc(server.url, "chats.remove", { chatId: seed.chat.id });
    expect(await chats()).toHaveLength(0);
    const sessionsBefore = stubRequests(home, "session/new").length;
    const job = await createJob({ sessionId: seed.sessionId, via: "chat", name: "Reopen job" });

    const first = await trigger(job.id);
    const [opened] = await chats();
    expect(opened.id).toBe(first.chatId);
    expect(opened.activeSessionId).toBe(seed.sessionId);
    expect(opened.labels["band:cronId"]).toBe(job.id);
    await idle(first.chatId);

    // The agent was asked to reopen the session, never to start another one.
    const reopened = stubRequests(home).filter(
      (r) =>
        (r.method === "session/load" || r.method === "session/resume") &&
        r.params.sessionId === seed.sessionId,
    );
    expect(reopened.length).toBeGreaterThan(0);
    expect(stubRequests(home, "session/new")).toHaveLength(sessionsBefore);

    const second = await trigger(job.id);
    expect(second.chatId).toBe(first.chatId);
    await idle(second.chatId);
    expect(await chats()).toHaveLength(1);
  });

  it("S6: fails the run and starts no fresh session when the session does not exist", async () => {
    const chatsBefore = await chats();
    const sessionsBefore = stubRequests(home, "session/new").length;
    const job = await createJob({ sessionId: "session-that-does-not-exist", via: "chat" });

    const res = await fetch(`${server.url}/trpc/cronjobs.trigger`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: "band_token=acp-chat-test-token" },
      body: JSON.stringify({ key: WORKTREE_ID, id: job.id }),
    });
    expect(res.status).toBe(412);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("Could not open session session-that-does-not-exist");

    const after = await getJob(job.id);
    expect(after.lastRunStatus).toBe("failed");
    expect(after.lastRunMessage).toContain("session-that-does-not-exist");
    expect((await chats()).map((c) => c.id)).toEqual(chatsBefore.map((c) => c.id));
    expect(stubRequests(home, "session/new")).toHaveLength(sessionsBefore);
  });
});

describe("cronjobs with an agent", () => {
  it("S8: the job's chat runs the chosen agent", async () => {
    const job = await createJob({ agent: "codex", name: "Codex job" });
    const fired = await trigger(job.id);
    const chat = (await chats()).find((c) => c.id === fired.chatId);
    expect(chat?.agent).toBe("codex");
    await idle(fired.chatId);
  });
});

describe("cronjob validation", () => {
  const refused = async (input: Record<string, unknown>) => {
    const res = await fetch(`${server.url}/trpc/cronjobs.create`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: "band_token=acp-chat-test-token" },
      body: JSON.stringify({
        worktreeId: WORKTREE_ID,
        name: "Refused",
        prompt: "x",
        cronExpression: "0 0 1 1 *",
        ...input,
      }),
    });
    const body = (await res.json()) as { error?: { message?: string } };
    return { status: res.status, text: body.error?.message ?? "" };
  };

  it("S9: refuses a session on a terminal job and an unknown agent", async () => {
    const terminal = await refused({ via: "terminal", sessionId: "s-1" });
    expect(terminal.status).toBe(400);
    expect(terminal.text).toContain("via=chat");

    const unknown = await refused({ agent: "no-such-agent" });
    expect(unknown.status).toBe(400);
    expect(unknown.text).toContain('Unknown agent "no-such-agent"');

    const seed = await chatWithSession();
    const mismatch = await refused({ sessionId: seed.sessionId, agent: "codex" });
    expect(mismatch.status).toBe(400);
    expect(mismatch.text).toContain("claude-code");
    expect(mismatch.text).toContain("codex");

    const update = await createJob({ name: "To update" });
    const res = await fetch(`${server.url}/trpc/cronjobs.update`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: "band_token=acp-chat-test-token" },
      body: JSON.stringify({ key: WORKTREE_ID, id: update.id, via: "terminal", sessionId: "s-2" }),
    });
    expect(res.status).toBe(400);
  });
});
