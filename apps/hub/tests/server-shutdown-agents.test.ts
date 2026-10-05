// Server shutdown stops the coding agents it started.
//
// Agents run detached, in their own process group, so the server's own exit
// doesn't take them down. An agent busy with a turn (or a Codex agent's
// app-server) used to outlive the server. In the tests that showed up as
// ENOTEMPTY in `afterAll`: a stub agent still starting or still running
// kept writing its state and request log into the tmp home while it was
// deleted.
//
// Real server over HTTP; the agent is the scripted ACP stub. Its turn sleeps
// for a minute, which keeps the stub process alive after its stdin closes,
// so without the fix it is still running when `close()` returns.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sendMessage, startAcpServer, stubRequests, trpc, WORKTREE_ID } from "./helpers/acp-chat";
import type { ServerHandle } from "./helpers/server";
import { waitFor } from "./helpers/wait-for";

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

describe("server shutdown", () => {
  let server: ServerHandle;

  beforeAll(async () => {
    // Owns its home, so `close()` also deletes it.
    server = await startAcpServer({ turns: [{ steps: [{ sleep: 60_000 }] }] });
  });

  afterAll(async () => {
    await server.close();
  });

  it("stops an agent that is in the middle of a turn", async () => {
    const { chat } = await trpc<{ chat: { id: string } }>(server.url, "chats.create", {
      worktreeId: WORKTREE_ID,
      name: "Busy agent",
    });
    await sendMessage(server.url, chat.id, "take your time");
    const prompt = await waitFor(async () => stubRequests(server.home, "session/prompt").at(-1), {
      label: "agent received the prompt",
    });
    expect(isRunning(prompt.pid)).toBe(true);

    await server.close();

    expect(isRunning(prompt.pid)).toBe(false);
  });
});
