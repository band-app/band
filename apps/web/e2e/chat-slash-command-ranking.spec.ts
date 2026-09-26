/**
 * The `/` dropdown ranks commands the way the agent's own picker does.
 *
 * Claude Code advertises user skills before its built-in commands, so in a
 * real session `/loop` sat around 74th in `available_commands_update`. The
 * dropdown used to keep every command whose name or description contained
 * the query, in the agent's order, and skills that merely mention "loop"
 * pushed the built-in `/loop` below the visible rows.
 *
 * The ranking now mirrors Claude Code's picker: exact name, then names
 * starting with the query (shortest first), then names containing it, then
 * descriptions containing it (only for queries of 3+ characters). Ties keep
 * the agent's order, and an empty query shows the agent's list unchanged.
 *
 * Architecture: real `dist/start-server.mjs`, the ACP stub agent advertises
 * the commands below through `BAND_TEST_ACP_COMMANDS`, and a fresh chat gets
 * them from the server's boot probe. UI driven through `ChatPanePage`.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
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

const TOKEN = "e2e-chat-slash-ranking-token";
const PROJECT = "slashproj";
const WORKSPACE = toWorkspaceId(PROJECT, "main");

// Skills first and built-ins last, as Claude Code advertises them.
const COMMANDS = [
  { name: "am-babysit", description: "Babysit a pull request, usually run via /loop" },
  { name: "band-loop", description: "Schedule a recurring prompt against a workspace" },
  { name: "diagnosing-bugs", description: "Diagnosis loop for hard bugs" },
  { name: "loop-status", description: "Show the running loops" },
  { name: "no-tdd-guard", description: "Allow commits without tests" },
  { name: "$tdd", description: "Test-driven development" },
  { name: "review", description: "Review the pending changes" },
  { name: "loop", description: "Run a prompt or slash command on a recurring interval" },
];

test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repoDir = join(tmpHome, "repo");
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
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
  });
  server = await startServer({ tmpHome, env: acpStubEnv(tmpHome, { commands: COMMANDS }) });
});

test.afterAll(async () => {
  if (server) await server.close();
  cleanupTmpHome(tmpHome);
});

async function openChat(page: Page): Promise<ChatPanePage> {
  const chatPane = new ChatPanePage(page, server.url, TOKEN);
  await chatPane.goto(WORKSPACE);
  await chatPane.waitForReady();
  return chatPane;
}

test.describe("slash-command dropdown ranking", () => {
  test("a bare / lists the commands in the agent's order", async ({ page }) => {
    const chatPane = await openChat(page);
    await chatPane.typeMessage("/");

    await expect
      .poll(() => chatPane.slashCommandNames())
      .toEqual(COMMANDS.map((c) => `/${c.name}`));
  });

  test("/loop puts the exact command first, then prefix, name and description matches", async ({
    page,
  }) => {
    const chatPane = await openChat(page);
    await chatPane.typeMessage("/loop");

    await expect
      .poll(() => chatPane.slashCommandNames())
      .toEqual(["/loop", "/loop-status", "/band-loop", "/am-babysit", "/diagnosing-bugs"]);

    // Enter picks the top row.
    await chatPane.pressKey("Enter");
    await expect.poll(() => chatPane.promptValue()).toBe("/loop ");
  });

  test("a two-letter query ignores descriptions", async ({ page }) => {
    const chatPane = await openChat(page);
    await chatPane.typeMessage("/lo");

    await expect
      .poll(() => chatPane.slashCommandNames())
      .toEqual(["/loop", "/loop-status", "/band-loop"]);
  });

  test("a Codex $-skill matches as if it had no $", async ({ page }) => {
    const chatPane = await openChat(page);
    await chatPane.typeMessage("/tdd");
    await expect.poll(() => chatPane.slashCommandNames()).toEqual(["/$tdd", "/no-tdd-guard"]);

    // A prefix too: `$tdd` starts with "td" once the `$` is dropped.
    await chatPane.typeMessage("/td");
    await expect.poll(() => chatPane.slashCommandNames()).toEqual(["/$tdd", "/no-tdd-guard"]);
  });
});
