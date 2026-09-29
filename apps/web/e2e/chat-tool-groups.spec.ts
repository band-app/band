/**
 * Consecutive tool calls in the chat pane fold into one summary line, and
 * each message has a hover row with a copy action and the time it was sent.
 *
 *   - Collapsed, a group is one line: "Ran 3 commands (1 failed), read
 *     package.json". A lone shell command is a group too: "Ran 1 command".
 *   - Expanded, each call is a row with a short description (Claude Code's
 *     `rawInput.description`, or the title). A failed call reads "Failed
 *     to …" and carries `data-status="error"`.
 *   - Expanding a shell call shows `$ command`, "Exit code N" and the
 *     output, from Claude Code's fenced text (exit code in its first line)
 *     or from Codex's `rawOutput.formatted_output` / `exit_code`.
 *   - Hovering a finished group's summary shows how long its calls took,
 *     from the first call's start to the last one's end.
 *   - Hovering a message shows how long ago it was sent, with the exact
 *     time in a tooltip, and copies its text. The time comes from the
 *     event log, so it survives a reload (the cold replay path).
 *
 * Architecture: the REAL `dist/start-server.mjs` against a fresh temp home,
 * the ACP stub agent scripting the tool calls, and the UI driven through
 * `ChatPanePage`. The clipboard is read through `WorkspacePage`'s
 * `installClipboardCapture`, which records the copy fallback's payload.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
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
import { WorkspacePage } from "./pages/WorkspacePage";

const TOKEN = "e2e-chat-tool-groups-token";
const PROJECT = "toolgroups";
const WORKSPACE = toWorkspaceId(PROJECT, "main");
const REPLY = "Fixed the lint errors.";
const STATUS_REPLY = "The tree is clean.";
const README_REPLY = "The README is short.";
/** The scenario sleeps 300 ms inside the pull call, so its duration and
 *  the group's have at least three digits of milliseconds. */
const TOOK = /^(\d{3}ms|\d+(\.\d)?s)$/;

// Relative times and the tooltip's exact time are formatted for the
// browser's locale and zone; pin both.
test.use({ viewport: { width: 1280, height: 800 }, locale: "en-US", timezoneId: "UTC" });

let server: ServerHandle;
let tmpHome: string;
/** The reply's time as the live stream dated it, checked after a reload. */
let liveReplyTime: string | null = null;
/** The group's duration as the live stream timed it, checked after a reload. */
let liveGroupDuration: string | null = null;

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
    defaultCodingAgent: "claude-code",
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
  });

  server = await startServer({
    tmpHome,
    env: acpStubEnv(tmpHome, {
      turns: [
        {
          match: "fix the lint",
          steps: [
            // Claude Code's shape: command and description in rawInput,
            // output as fenced text.
            {
              tool: {
                toolCallId: "tc-pull",
                title: "git pull",
                kind: "execute",
                status: "pending",
                rawInput: { command: "git pull", description: "Pull latest changes from branch" },
              },
            },
            // Gives the group a duration the tooltip can't round to 0ms.
            { sleep: 300 },
            {
              toolUpdate: {
                toolCallId: "tc-pull",
                status: "completed",
                content: [
                  {
                    type: "content",
                    content: { type: "text", text: "```console\nAlready up to date.\n```" },
                  },
                ],
              },
            },
            {
              tool: {
                toolCallId: "tc-read",
                title: "Read package.json",
                kind: "read",
                status: "completed",
                locations: [{ path: join(repoDir, "package.json") }],
                rawInput: { file_path: join(repoDir, "package.json") },
              },
            },
            // A failed command: Claude Code puts the exit code on the
            // first line of the fenced output.
            {
              tool: {
                toolCallId: "tc-lint",
                title: "pnpm lint:fix 2>&1",
                kind: "execute",
                status: "pending",
                rawInput: { command: "pnpm lint:fix 2>&1", description: "Run biome lint fix" },
              },
            },
            {
              toolUpdate: {
                toolCallId: "tc-lint",
                status: "failed",
                content: [
                  {
                    type: "content",
                    content: {
                      type: "text",
                      text: "```\nExit code 1\n> npx @biomejs/biome check --write .\n\nsh: 1: biome: not found\n```",
                    },
                  },
                ],
              },
            },
            // Codex's shape: the command as argv, the output and exit code
            // in rawOutput, no description.
            {
              tool: {
                toolCallId: "tc-ls",
                title: "ls node_modules",
                kind: "execute",
                status: "in_progress",
                rawInput: { command: ["ls", "node_modules"], cwd: repoDir },
              },
            },
            {
              toolUpdate: {
                toolCallId: "tc-ls",
                status: "completed",
                rawOutput: { formatted_output: "@biomejs\ntypescript\n", exit_code: 0 },
              },
            },
            { say: REPLY },
          ],
        },
        {
          match: "check the status",
          steps: [
            {
              tool: {
                toolCallId: "tc-status",
                title: "git status",
                kind: "execute",
                status: "pending",
                rawInput: { command: "git status", description: "Show working tree status" },
              },
            },
            {
              toolUpdate: {
                toolCallId: "tc-status",
                status: "completed",
                content: [
                  {
                    type: "content",
                    content: { type: "text", text: "```console\nnothing to commit\n```" },
                  },
                ],
              },
            },
            { say: STATUS_REPLY },
          ],
        },
        {
          match: "read the readme",
          steps: [
            {
              tool: {
                toolCallId: "tc-readme",
                title: "Read README.md",
                kind: "read",
                status: "completed",
                locations: [{ path: join(repoDir, "README.md") }],
                rawInput: { file_path: join(repoDir, "README.md") },
              },
            },
            { say: README_REPLY },
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

test.describe("chat tool groups and message actions", () => {
  // Later tests read the chat the first one ran.
  test.describe.configure({ mode: "serial" });

  test("folds consecutive tool calls into one summary and shows each call's details", async ({
    page,
  }) => {
    const chatPane = new ChatPanePage(page, server.url, TOKEN);
    await chatPane.goto(WORKSPACE);
    await chatPane.waitForReady();

    await chatPane.typeMessage("fix the lint");
    await chatPane.submit();
    await expect(chatPane.assistantMessage(REPLY)).toBeVisible();

    // Collapsed: one summary line, no rows.
    await expect(chatPane.toolGroups).toHaveCount(1);
    await expect(chatPane.toolGroupSummary(0)).toHaveText(
      "Ran 3 commands (1 failed), read package.json",
    );
    await expect(chatPane.toolCallContainers).toHaveCount(0);

    // The finished group shows how long it took once hovered.
    await expect(chatPane.toolGroupDuration(0)).toHaveText(TOOK);
    await expect(chatPane.toolGroupDuration(0)).toHaveCSS("opacity", "0");
    await chatPane.hoverToolGroup(0);
    await expect(chatPane.toolGroupDuration(0)).toHaveCSS("opacity", "1");
    liveGroupDuration = await chatPane.toolGroupDuration(0).textContent();

    // Expanded: a row per call, in order, the failed one marked.
    await chatPane.expandToolGroup(0);
    await expect(chatPane.toolCallLabels()).toHaveText([
      "Pull latest changes from branch",
      "Read package.json",
      "Failed to run biome lint fix",
      "ls node_modules",
    ]);
    await expect(chatPane.toolCall("Failed to run biome lint fix")).toHaveAttribute(
      "data-status",
      "error",
    );
    await expect(chatPane.toolCall("Pull latest changes from branch")).toHaveAttribute(
      "data-status",
      "complete",
    );

    // Each call has its own duration, shown once its row is hovered. A
    // call reported finished in its first event wasn't timed, so it has none.
    const pull = chatPane.toolCallDuration("Pull latest changes from branch");
    await expect(pull).toHaveText(TOOK);
    await expect(pull).toHaveCSS("opacity", "0");
    await chatPane.hoverToolCall("Pull latest changes from branch");
    await expect(pull).toHaveCSS("opacity", "1");
    await expect(chatPane.toolCallDuration("Read package.json")).toHaveCount(0);

    // The failed call: command, exit code, and the output without the
    // exit-code line or the code fence.
    await chatPane.expandToolCall("Failed to run biome lint fix");
    await expect(chatPane.toolCallCommand("Failed to run biome lint fix")).toHaveText(
      "$ pnpm lint:fix 2>&1",
    );
    await expect(chatPane.toolCallExitCode("Failed to run biome lint fix")).toHaveText(
      "Exit code 1",
    );
    const lintOutput = chatPane.toolCallOutput("Failed to run biome lint fix");
    await expect(lintOutput).toContainText("sh: 1: biome: not found");
    await expect(lintOutput).not.toContainText("Exit code");
    await expect(lintOutput).not.toContainText("```");

    // A Codex-shaped call: argv joined, output from rawOutput, and no
    // exit-code line for a command that succeeded.
    await chatPane.expandToolCall("ls node_modules");
    await expect(chatPane.toolCallCommand("ls node_modules")).toHaveText("$ ls node_modules");
    await expect(chatPane.toolCallOutput("ls node_modules")).toHaveText("@biomejs\ntypescript");
    await expect(chatPane.toolCallExitCode("ls node_modules")).toHaveCount(0);

    // The live stream dates both messages.
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
    await expect(chatPane.messageTime(chatPane.userMessage("fix the lint"))).toHaveAttribute(
      "datetime",
      iso,
    );
    const replyTime = chatPane.messageTime(chatPane.assistantMessage(REPLY));
    await expect(replyTime).toHaveAttribute("datetime", iso);
    liveReplyTime = await replyTime.getAttribute("datetime");
  });

  test("a message shows when it was sent and copies its text on hover", async ({ page }) => {
    const chatPane = new ChatPanePage(page, server.url, TOKEN);
    const workspace = new WorkspacePage(page, server.url, TOKEN);
    await workspace.installClipboardCapture();
    await chatPane.goto(WORKSPACE);
    await chatPane.waitForReady();

    // The chat from the previous test replays from the event log.
    const reply = chatPane.assistantMessage(REPLY);
    await expect(reply).toBeVisible();

    // Hidden until hovered.
    await expect(chatPane.messageActions(reply)).toHaveCSS("opacity", "0");
    await chatPane.hoverMessage(reply);
    await expect(chatPane.messageActions(reply)).toHaveCSS("opacity", "1");
    await expect(chatPane.messageTime(reply)).toHaveText(/^(just now|1 minute ago)$/);
    // The replay carries the time the live stream had.
    expect(liveReplyTime).not.toBeNull();
    await expect(chatPane.messageTime(reply)).toHaveAttribute("datetime", liveReplyTime ?? "");

    const tooltip = await chatPane.openMessageTimeTooltip(reply);
    await expect(tooltip).toContainText(
      new Date(liveReplyTime ?? 0).toLocaleString("en-US", { timeZone: "UTC" }),
    );

    await chatPane.copyMessage(reply);
    await expect.poll(async () => (await workspace.readCopied()).at(-1)).toBe(REPLY);

    // The user's own message has the same row.
    const prompt = chatPane.userMessage("fix the lint");
    await chatPane.copyMessage(prompt);
    await expect.poll(async () => (await workspace.readCopied()).at(-1)).toBe("fix the lint");
    await expect(chatPane.messageTime(prompt)).toHaveText(/^(just now|1 minute ago)$/);

    // The group's duration comes from the logged event times too.
    expect(liveGroupDuration).not.toBeNull();
    await expect(chatPane.toolGroupDuration(0)).toHaveText(liveGroupDuration ?? "");
  });

  test("a lone shell command folds into a group of one", async ({ page }) => {
    const chatPane = new ChatPanePage(page, server.url, TOKEN);
    await chatPane.goto(WORKSPACE);
    await chatPane.waitForReady();
    await expect(chatPane.assistantMessage(REPLY)).toBeVisible();

    await chatPane.typeMessage("check the status");
    await chatPane.submit();
    await expect(chatPane.assistantMessage(STATUS_REPLY)).toBeVisible();

    // The earlier turn's group, then this one's.
    await expect(chatPane.toolGroups).toHaveCount(2);
    await expect(chatPane.toolGroupSummary(1)).toHaveText("Ran 1 command");
    await expect(chatPane.toolCallContainers).toHaveCount(0);

    await chatPane.expandToolGroup(1);
    await expect(chatPane.toolCallLabels()).toHaveText(["Show working tree status"]);
    await chatPane.expandToolCall("Show working tree status");
    await expect(chatPane.toolCallCommand("Show working tree status")).toHaveText("$ git status");
    await expect(chatPane.toolCallOutput("Show working tree status")).toHaveText(
      "nothing to commit",
    );
  });

  test("a lone read stays a row of its own", async ({ page }) => {
    const chatPane = new ChatPanePage(page, server.url, TOKEN);
    await chatPane.goto(WORKSPACE);
    await chatPane.waitForReady();
    await expect(chatPane.assistantMessage(STATUS_REPLY)).toBeVisible();

    await chatPane.typeMessage("read the readme");
    await chatPane.submit();
    await expect(chatPane.assistantMessage(README_REPLY)).toBeVisible();

    // No third group: the read is shown without expanding anything.
    await expect(chatPane.toolGroups).toHaveCount(2);
    await expect(chatPane.toolCallLabels()).toHaveText(["Read README.md"]);
  });
});
