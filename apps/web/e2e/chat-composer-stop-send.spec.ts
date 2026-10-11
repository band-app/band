/**
 * The composer shows either Send or Stop, never both:
 *
 *   - Text (not just whitespace) or an attachment in the prompt → Send,
 *     even while a task runs. Sending then queues, as before.
 *   - A task running and an empty prompt → Stop.
 *   - No task and an empty prompt → Send, disabled.
 *
 * Enter sends whenever Send is shown, and Escape still stops a running task
 * while the prompt has text in it.
 *
 * Real server, no tRPC mocking. The ACP stub agent holds the "start" turn
 * open until Band sends `session/cancel`, which keeps the task running for
 * as long as the test needs.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import { acpStubEnv } from "./helpers/acp-stub";
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

const TOKEN = "e2e-composer-stop-send-token";
// One repo per test, so a task one test leaves running (or queued)
// doesn't reach the next.
const REPOS = ["stopsendidle", "stopsendrunning", "stopsendescape"];
const [IDLE_WS, RUNNING_WS, ESCAPE_WS] = REPOS.map((p) => toWorktreeId(p, "main", "local"));
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
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
  });
  server = await startServer({
    tmpHome,
    env: acpStubEnv(tmpHome, {
      turns: [
        { match: "^start", steps: [{ say: "working " }, { waitForCancel: true }] },
        { steps: [{ say: "done" }] },
      ],
    }),
  });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test("with no task running, an empty or whitespace-only prompt shows a disabled Send", async ({
  page,
}) => {
  const chatPane = new ChatPanePage(page, server.url, TOKEN);
  await chatPane.goto(IDLE_WS);
  await chatPane.waitForReady();

  await expect(chatPane.submitButton).toBeDisabled();
  await expect(chatPane.stopButton).toHaveCount(0);

  await chatPane.typeMessage("   \n  ");
  await expect(chatPane.submitButton).toBeDisabled();
  await expect(chatPane.stopButton).toHaveCount(0);

  await chatPane.typeMessage("hello");
  await expect(chatPane.submitButton).toBeEnabled();
  await expect(chatPane.stopButton).toHaveCount(0);

  // A whitespace-only draft restored after a reload still counts as empty.
  await chatPane.typeMessage("   ");
  await chatPane.reload();
  await chatPane.waitForReady();
  await expect(chatPane.promptInput).toHaveValue("   ");
  await expect(chatPane.submitButton).toBeDisabled();
});

test("while a task runs, the prompt's content decides between Stop and Send", async ({ page }) => {
  const chatPane = new ChatPanePage(page, server.url, TOKEN);
  await chatPane.goto(RUNNING_WS);
  await chatPane.waitForReady();

  await chatPane.typeMessage("start a long task");
  await chatPane.submit();
  await expect(chatPane.assistantMessage("working")).toBeVisible();

  // Empty prompt: Stop only.
  await expect(chatPane.stopButton).toBeVisible();
  await expect(chatPane.submitButton).toHaveCount(0);

  // Whitespace doesn't count as content.
  await chatPane.typeMessage("   ");
  await expect(chatPane.stopButton).toBeVisible();
  await expect(chatPane.submitButton).toHaveCount(0);

  // Text: Send only, enabled.
  await chatPane.typeMessage("a follow-up");
  await expect(chatPane.submitButton).toBeEnabled();
  await expect(chatPane.stopButton).toHaveCount(0);

  // Enter sends, which queues behind the running task, and the emptied
  // prompt brings Stop back.
  await chatPane.submit();
  await expect(chatPane.queuedMessages).toHaveCount(1);
  await expect(chatPane.stopButton).toBeVisible();
  await expect(chatPane.submitButton).toHaveCount(0);

  // An attachment without text counts as content, the same rule that
  // enables Send.
  await chatPane.attachFile({ name: "pixel.png", mimeType: "image/png", buffer: PIXEL_PNG });
  await expect(chatPane.submitButton).toBeEnabled();
  await expect(chatPane.stopButton).toHaveCount(0);
});

test("Escape stops a running task even while the prompt shows Send", async ({ page }) => {
  const chatPane = new ChatPanePage(page, server.url, TOKEN);
  await chatPane.goto(ESCAPE_WS);
  await chatPane.waitForReady();

  await chatPane.typeMessage("start another long task");
  await chatPane.submit();
  await expect(chatPane.stopButton).toBeVisible();

  await chatPane.typeMessage("not sent yet");
  await expect(chatPane.submitButton).toBeEnabled();
  await expect(chatPane.stopButton).toHaveCount(0);
  await chatPane.pressKey("Escape");

  // The cancelled turn ends with an info-level "stopped" notice, and with
  // no task running an empty prompt shows a disabled Send, not Stop.
  await expect(chatPane.notices).toHaveAttribute("data-level", "info");
  await expect(chatPane.promptInput).toHaveValue("not sent yet");
  await chatPane.clearPrompt();
  await expect(chatPane.submitButton).toBeDisabled();
  await expect(chatPane.stopButton).toHaveCount(0);
});
