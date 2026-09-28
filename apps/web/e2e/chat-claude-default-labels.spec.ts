/**
 * Claude Code's "Default" model and effort choices show what they run with.
 *
 *   - The composer trigger reads the resolved model and effort ("Opus 5.5
 *     Medium"), not "Default (recommended) Default", and so does the top row
 *     of the model menu.
 *   - The rows that go back to the default read "Default: Opus 5.5" and
 *     "Default: Medium".
 *   - What the session reports (its Claude Code transcript) wins over config.
 *   - Other agents keep the labels their agent sends.
 *
 * Real server, no tRPC mocking. The ACP stub agent advertises the Claude
 * adapter's option shape, including its description of the default model row
 * ("Opus (1M context)"). Config is `$HOME/.claude/settings.json` in the tmp
 * home; the transcript is written where Claude Code writes it,
 * `$HOME/.claude/projects/<repo path slug>/<session id>.jsonl`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
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

const TOKEN = "e2e-claude-default-labels-token";
const PROJECTS = ["claudedefaults", "codexdefaults"] as const;

test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

function repoPath(name: string): string {
  return join(tmpHome, name);
}

/** A Claude Code transcript whose last assistant record ran `model` at
 *  `effort`. */
function writeTranscript(project: string, sessionId: string, model: string, effort: string) {
  const dir = join(tmpHome, ".claude", "projects", repoPath(project).replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const record = {
    type: "assistant",
    isSidechain: false,
    timestamp: new Date().toISOString(),
    effort,
    sessionId,
    message: { role: "assistant", model, content: [] },
  };
  writeFileSync(join(dir, `${sessionId}.jsonl`), `${JSON.stringify(record)}\n`);
}

function lastPromptSessionId(): string {
  return (stubRequests(tmpHome, "session/prompt").at(-1)?.params as { sessionId: string })
    .sessionId;
}

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedState(tmpHome, {
    projects: PROJECTS.map((name) => {
      mkdirSync(repoPath(name), { recursive: true });
      return {
        name,
        path: repoPath(name),
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: repoPath(name) }],
      };
    }),
  });
  seedSettings(tmpHome, {
    tokenSecret: TOKEN,
    defaultCodingAgent: "claude-code",
    codingAgents: [
      { id: "claude-code", type: "claude-code", label: "Claude Code" },
      { id: "codex", type: "codex", label: "Codex" },
    ],
  });
  mkdirSync(join(tmpHome, ".claude"), { recursive: true });
  writeFileSync(
    join(tmpHome, ".claude", "settings.json"),
    JSON.stringify({ effortLevel: "medium" }),
  );

  server = await startServer({
    tmpHome,
    env: {
      CLAUDE_CONFIG_DIR: "",
      ANTHROPIC_MODEL: "",
      CLAUDE_CODE_EFFORT_LEVEL: "",
      ...acpStubEnv(tmpHome, {
        options: {
          models: [
            { value: "default", name: "Default (recommended)", description: "Opus (1M context)" },
            { value: "opus[1m]", name: "Opus 5.5" },
            { value: "claude-fable-5-1[1m]", name: "Fable 5.1" },
            { value: "sonnet", name: "Sonnet 5" },
          ],
          extra: [
            {
              id: "effort",
              name: "Effort",
              category: "thought_level",
              options: [
                { value: "default", name: "Default" },
                { value: "low", name: "Low" },
                { value: "medium", name: "Medium" },
                { value: "high", name: "High" },
              ],
            },
          ],
        },
      }),
    },
  });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test.describe("Claude Code default model and effort labels", () => {
  test("names the model and effort the defaults run with, preferring what the session reports", async ({
    page,
  }) => {
    const chatPane = new ChatPanePage(page, server.url, TOKEN);
    await chatPane.goto(toWorkspaceId("claudedefaults", "main"));
    await chatPane.waitForReady();

    await chatPane.typeMessage("first");
    await chatPane.submit();
    await expect(chatPane.assistantMessage('Heard "first" on default.')).toBeVisible();

    // The adapter's default row names Opus; settings.json sets medium effort.
    await expect(chatPane.modelMenuButton).toContainText("Opus 5.5");
    await expect(chatPane.modelMenuEffort).toHaveText("Medium");
    await chatPane.openModelMenu();
    await expect(chatPane.selectedModelRow()).toContainText("Opus 5.5");
    await expect(chatPane.effortSubmenu).toContainText("Default: Medium");
    await chatPane.openEffortSubmenu();
    await expect(chatPane.effortOption("Default: Medium")).toBeVisible();
    await expect(chatPane.effortOption("Medium")).toBeVisible();
    await chatPane.closeMenu();

    // The session reports Fable 5.1 at high effort: that beats both.
    writeTranscript("claudedefaults", lastPromptSessionId(), "claude-fable-5-1", "high");
    await chatPane.typeMessage("second");
    await chatPane.submit();
    await expect(chatPane.assistantMessage('Heard "second" on default.')).toBeVisible();
    await expect(chatPane.modelMenuButton).toContainText("Fable 5.1");
    await expect(chatPane.modelMenuEffort).toHaveText("High");

    // Another model: the way back to the default names it.
    await chatPane.selectModel("Sonnet 5");
    await expect(chatPane.modelMenuButton).toContainText("Sonnet 5");
    await chatPane.openModelMenu();
    await chatPane.openMoreModels();
    await expect(chatPane.moreModelsOption("Default: Fable 5.1")).toBeVisible();
    await chatPane.clickMoreModel("Default: Fable 5.1");
    await expect(chatPane.modelMenuButton).toContainText("Fable 5.1");
  });

  test("other agents keep the labels their agent sends", async ({ page }) => {
    const chatPane = new ChatPanePage(page, server.url, TOKEN);
    await chatPane.goto(toWorkspaceId("codexdefaults", "main"));
    await chatPane.openNewTabMenu();
    await chatPane.openNewChatAgentMenu();
    await chatPane.startChatWithAgent("codex");

    await chatPane.typeMessage("hello");
    await chatPane.submit();
    await expect(chatPane.assistantMessage('Heard "hello" on default.')).toBeVisible();

    await expect(chatPane.modelMenuButton).toContainText("Default (recommended)");
    await expect(chatPane.modelMenuEffort).toHaveText("Default");
  });
});
