/**
 * End-to-end coverage for the agent failure card. The hub's structured error
 * (cause, exit, stderr tail) is covered by `acp-chat.test.ts`; this spec
 * drives the card in the browser against the real server and a stub agent
 * that kills itself or exits non-zero.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { toWorktreeId } from "@/dashboard";

import { acpStubEnv } from "./helpers/acp-stub";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { ChatPanePage } from "./pages/ChatPanePage";

const TOKEN = "e2e-agent-failure-token";
const REPO = "failproj";
const WORKTREE = toWorktreeId(REPO, "main", "local");

test.use({ viewport: { width: 1000, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

const NOISE = [
  "[session/create] sessionId=cf181bd2 phase=validate-cwd durationMs=3 totalMs=3",
  "[session/query] sessionId=cf181bd2 resume=none apiType=native baseUrl=native",
  "(node:3957134) [CLAUDE_SDK_CAN_USE_TOOL_SHADOWED] Warning: canUseTool will not be invoked",
];

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repoDir = join(tmpHome, "repo");
  mkdirSync(repoDir, { recursive: true });
  seedState(tmpHome, {
    repos: [
      {
        name: REPO,
        path: repoDir,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: repoDir }],
      },
    ],
  });
  seedSettings(tmpHome, {
    tokenSecret: TOKEN,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
  });
  server = await startServer({
    tmpHome,
    env: acpStubEnv(tmpHome, {
      turns: [
        {
          match: "^kill",
          steps: [...NOISE.map((stderr) => ({ stderr })), { kill: "SIGKILL" }],
        },
        {
          match: "^enospc",
          steps: [
            ...NOISE.map((stderr) => ({ stderr })),
            { stderr: "Error: ENOSPC: no space left on device" },
            { exit: 1 },
          ],
        },
      ],
    }),
  });
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test("a killed agent shows one red card with Retry and Copy, details collapsed", async ({
      page,
      context,
    }, testInfo) => {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      const chat = new ChatPanePage(page, server.url, TOKEN);
      await chat.goto(WORKTREE);
      await chat.waitForReady();
      // A new session empties the transcript, so earlier tests' cards can't match.
      await chat.openSessionHistory();
      await chat.clickNewSession();
      await expect(chat.emptyConversation).toBeVisible();
      await chat.setDarkTheme(colorScheme === "dark");
      const before = await chat.failureCards.count();
      const prompt = `kill me (${colorScheme})`;
      await chat.typeMessage(prompt);
      await chat.submit();

      await expect(chat.failureCards).toHaveCount(before + 1);
      const f = chat.failureCard(-1);
      await expect(f.card).toHaveAttribute("data-cause", "killed");
      await expect(f.headline).toHaveText("Claude Code stopped unexpectedly");
      await expect(f.line).toContainText("Killed by SIGKILL on this hub");
      await expect(f.card).toHaveAttribute("data-tone", "red");
      await expect(f.retry).toBeVisible();
      await expect(f.copy).toBeVisible();
      await expect(f.details).not.toBeVisible();
      await chat.screenshot(testInfo.outputPath(`killed-${colorScheme}.png`));

      // Copy details puts the facts and the whole tail on the clipboard.
      await f.copy.click();
      const copied = await chat.readClipboard();
      expect(copied).toContain("Exit signal: SIGKILL");
      expect(copied).toContain("CLAUDE_SDK_CAN_USE_TOOL_SHADOWED");

      // Retry resends the last prompt and the new turn runs (and is killed again).
      await f.retry.click();
      await expect(chat.userMessage(prompt)).toHaveCount(2);
      await expect(chat.failureCards).toHaveCount(before + 2);
    });

    test("a non-zero exit quotes the last line and filters the noise", async ({
      page,
    }, testInfo) => {
      const chat = new ChatPanePage(page, server.url, TOKEN);
      await chat.goto(WORKTREE);
      await chat.waitForReady();
      // A new session empties the transcript, so earlier tests' cards can't match.
      await chat.openSessionHistory();
      await chat.clickNewSession();
      await expect(chat.emptyConversation).toBeVisible();
      await chat.setDarkTheme(colorScheme === "dark");
      const before = await chat.failureCards.count();
      await chat.typeMessage("enospc please");
      await chat.submit();

      await expect(chat.failureCards).toHaveCount(before + 1);
      const f = chat.failureCard(-1);
      await expect(f.card).toHaveAttribute("data-cause", "exit");
      await expect(f.card).toHaveAttribute("data-tone", "red");
      await expect(f.headline).toHaveText("Claude Code exited with code 1");
      await expect(f.line).toContainText("Error: ENOSPC: no space left on device");
      await f.toggle.click();
      await expect(f.details).toBeVisible();
      await expect(f.hidden).toHaveAttribute("data-hidden-count", "3");
      await expect(f.output).toContainText("ENOSPC");
      await expect(f.output).not.toContainText("phase=validate-cwd");
      await expect(f.errorLines).toHaveCount(1);
      await chat.screenshot(testInfo.outputPath(`exit-${colorScheme}.png`));

      await f.all.click();
      await expect(f.output).toContainText("phase=validate-cwd");
      await expect(f.hidden).toHaveCount(0);
    });
  });
}
