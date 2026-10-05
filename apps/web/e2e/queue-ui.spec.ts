/**
 * Messages sent while the agent is still running queue at the end of the
 * transcript:
 *
 *   - They render under a "Queued · sent when the agent finishes" divider, in
 *     order, with an attachment chip for each attached file.
 *   - Hovering one shows edit and delete.
 *   - Edit turns the message into an inline editor: Enter or the send
 *     button saves, Shift+Enter adds a line, Escape or clicking outside
 *     discards, and Escape doesn't stop the turn.
 *   - Dragging a message's bubble reorders the queue, and the messages go
 *     out in the new order once the running turn ends.
 *
 * Real server, no tRPC mocking. The ACP stub agent holds the "start" turn on
 * a permission request, so the queue stays put until the test answers it;
 * the answer ends the turn and the server sends the queue.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import { acpStubEnv, stubRequests } from "./helpers/acp-stub";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { ChatPanePage } from "./pages/ChatPanePage";

const TOKEN = "e2e-queue-ui-token";
// One repo per test, so each gets a fresh chat and queue.
const REPOS = ["queuerender", "queueedit", "queuereorder"];
const [RENDER_WS, EDIT_WS, REORDER_WS] = REPOS.map((p) => toWorktreeId(p, "main"));
// A 1x1 PNG, the smallest image the composer accepts as an attachment.
const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedState(tmpHome, {
    repos: REPOS.map((name) => {
      const repoDir = join(tmpHome, name);
      mkdirSync(repoDir, { recursive: true });
      return {
        name,
        path: repoDir,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: repoDir }],
      };
    }),
  });
  seedSettings(tmpHome, {
    tokenSecret: TOKEN,
    defaultCodingAgent: "claude-code",
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
  });
  server = await startServer({
    tmpHome,
    env: acpStubEnv(tmpHome, {
      turns: [
        {
          match: "^start",
          steps: [
            { say: "working " },
            {
              permission: {
                toolCall: {
                  toolCallId: "tc-hold",
                  title: "Hold the turn",
                  kind: "execute",
                  status: "pending",
                },
                options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
              },
              after: { allow: [{ say: "first turn done" }] },
            },
          ],
        },
        { steps: [{ say: "Heard {{prompt}}" }] },
      ],
    }),
  });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

/** Opens the chat and starts a turn that waits on a permission answer. */
async function startHeldTurn(chatPane: ChatPanePage, worktreeId: string): Promise<void> {
  await chatPane.goto(worktreeId);
  await chatPane.waitForReady();
  await chatPane.typeMessage("start a long task");
  await chatPane.submit();
  await expect(chatPane.permissionCards).toHaveCount(1);
}

async function queueMessage(chatPane: ChatPanePage, text: string): Promise<void> {
  await chatPane.typeMessage(text);
  await chatPane.submit();
  await expect(chatPane.queuedMessage(text)).toBeVisible();
}

/**
 * The text of every prompt the agent received after this test's held turn
 * started, in order. The tests in this file share one agent log, and the
 * turn's own prompt carries Band's instructions after its text.
 */
function promptsAfterHeldTurn(): string[] {
  const prompts = stubRequests(tmpHome, "session/prompt").map((r) =>
    (r.params.prompt as { type: string; text?: string }[])
      .flatMap((block) => (block.type === "text" && block.text ? [block.text] : []))
      .join(""),
  );
  const start = prompts.findLastIndex((p) => p.startsWith("start a long task"));
  return prompts.slice(start + 1);
}

test("messages sent during a turn queue under a divider and go out when it ends", async ({
  page,
}) => {
  const chatPane = new ChatPanePage(page, server.url, TOKEN);
  await startHeldTurn(chatPane, RENDER_WS);
  await expect(chatPane.queueDivider).toHaveCount(0);

  await queueMessage(chatPane, "fix the bug");
  await chatPane.attachFile({ name: "pixel.png", mimeType: "image/png", buffer: PIXEL_PNG });
  await queueMessage(chatPane, "use the screenshot");

  await expect(chatPane.queueDivider).toBeVisible();
  expect(await chatPane.queuedMessageTexts()).toEqual(["fix the bug", "use the screenshot"]);
  const withFile = chatPane.queuedMessage("use the screenshot");
  await expect(chatPane.queuedAttachments(withFile)).toHaveText(["pixel.png"]);
  await expect(chatPane.queuedAttachments(chatPane.queuedMessage("fix the bug"))).toHaveCount(0);

  // The actions show on hover.
  await expect(chatPane.queuedActions(withFile)).toHaveCSS("opacity", "0");
  await withFile.hover();
  await expect(chatPane.queuedActions(withFile)).toHaveCSS("opacity", "1");

  await chatPane.deleteQueuedMessage("fix the bug");
  await expect.poll(() => chatPane.queuedMessageTexts()).toEqual(["use the screenshot"]);
  await expect(chatPane.queuedMessage("fix the bug")).toHaveCount(0);

  // Ending the turn sends what's left of the queue as a normal user message.
  await chatPane.answerPermission(0, "Allow");
  await expect(chatPane.assistantMessage("Heard use the screenshot")).toBeVisible();
  await expect(chatPane.userMessage("use the screenshot")).toBeVisible();
  await expect(chatPane.queuedMessages).toHaveCount(0);
  await expect(chatPane.queueDivider).toHaveCount(0);
  expect(promptsAfterHeldTurn()).toEqual(["use the screenshot"]);
});

test("editing a queued message inline saves with Enter or the send button and discards on Escape or a click outside", async ({
  page,
}) => {
  const chatPane = new ChatPanePage(page, server.url, TOKEN);
  await startHeldTurn(chatPane, EDIT_WS);
  await queueMessage(chatPane, "draft one");

  // Escape discards the edit and leaves the running turn alone.
  await chatPane.editQueuedMessage("draft one", "discarded by escape");
  await expect(chatPane.queuedEditor).toBeVisible();
  await chatPane.pressInQueuedEditor("Escape");
  await expect(chatPane.queuedMessage("draft one")).toBeVisible();
  await expect(chatPane.queuedEditor).toHaveCount(0);
  await expect(chatPane.permissionCards).toHaveCount(1);
  await expect(chatPane.stopButton).toBeVisible();

  await chatPane.editQueuedMessage("draft one", "discarded by a click outside");
  await chatPane.clickOutsideQueuedEditor();
  await expect(chatPane.queuedMessage("draft one")).toBeVisible();
  await expect(chatPane.queuedEditor).toHaveCount(0);

  // Shift+Enter adds a line and keeps the editor open; Enter saves.
  await chatPane.editQueuedMessage("draft one", "saved by enter");
  await chatPane.pressInQueuedEditor("Shift+Enter");
  await expect(chatPane.queuedEditor).toBeVisible();
  await chatPane.pressInQueuedEditor("l");
  await chatPane.pressInQueuedEditor("Enter");
  await expect(chatPane.queuedEditor).toHaveCount(0);
  await expect.poll(() => chatPane.queuedMessageTexts()).toEqual(["saved by enter\nl"]);

  await chatPane.editQueuedMessage("saved by enter", "saved by button");
  await chatPane.saveQueuedEdit();
  await expect.poll(() => chatPane.queuedMessageTexts()).toEqual(["saved by button"]);

  // The edit reached the server: the edited text is what the agent gets.
  await chatPane.answerPermission(0, "Allow");
  await expect(chatPane.assistantMessage("Heard saved by button")).toBeVisible();
  expect(promptsAfterHeldTurn()).toEqual(["saved by button"]);
});

test("dragging a queued message's bubble reorders the queue and the order it is sent in", async ({
  page,
}) => {
  const chatPane = new ChatPanePage(page, server.url, TOKEN);
  await startHeldTurn(chatPane, REORDER_WS);
  await queueMessage(chatPane, "alpha");
  await queueMessage(chatPane, "beta");
  await queueMessage(chatPane, "gamma");

  await chatPane.dragQueuedMessage("gamma", "alpha");
  await expect.poll(() => chatPane.queuedMessageTexts()).toEqual(["gamma", "alpha", "beta"]);

  // The new order is the server's, not just the optimistic local one. A
  // reload can land before `queue.set` does, so reload until it shows.
  await expect
    .poll(async () => {
      await chatPane.reload();
      await chatPane.waitForReady();
      await expect(chatPane.permissionCards).toHaveCount(1);
      await expect(chatPane.queuedMessages).toHaveCount(3);
      return chatPane.queuedMessageTexts();
    })
    .toEqual(["gamma", "alpha", "beta"]);

  await chatPane.answerPermission(0, "Allow");
  await expect(chatPane.assistantMessage("Heard beta")).toBeVisible();
  await expect(chatPane.queuedMessages).toHaveCount(0);
  expect(promptsAfterHeldTurn()).toEqual(["gamma", "alpha", "beta"]);
});
