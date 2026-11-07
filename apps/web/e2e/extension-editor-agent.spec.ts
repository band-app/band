/**
 * Agents and the open editor tab (docs/extensions.md, "Agent access"): the person's selection
 * shows as a chip in the chat composer and goes with the message, and the scripted ACP agent edits
 * the document through the `band` MCP server's tools. A real hub, a real browser, no tRPC mocking.
 */

import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import { acpStubEnv, stubRequests } from "./helpers/acp-stub";
import { git } from "./helpers/git";
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
import { ExtensionEditorPage } from "./pages/ExtensionEditorPage";
import { FileTreesPage } from "./pages/FileTreesPage";
import { WorktreePage } from "./pages/WorktreePage";

test.use({ viewport: { width: 1600, height: 900 } });

const TOKEN = "e2e-extension-agent-token";
const REPO_NAME = "extension-agent-repo";
const NOTE = "dir/note.band-test";
const OTHER = "dir/other.band-test";
const FIXTURE = join(import.meta.dirname, "fixtures", "extensions", "text-editor");

let server: ServerHandle;
let tmpHome: string;
let repoPath: string;
let worktreeId: string;
let httpLog: string;

const call = (name: string, tool: string, args: object = {}) => ({
  mcpCall: { name, server: "band", tool, args, fullBody: true },
});

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  repoPath = join(tmpHome, REPO_NAME);
  mkdirSync(join(repoPath, "dir"), { recursive: true });
  git(repoPath, ["init", "-b", "main"]);
  writeFileSync(join(repoPath, NOTE), "hello extension\n");
  writeFileSync(join(repoPath, OTHER), "second file\n");
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "initial"]);
  seedState(tmpHome, {
    repos: [
      {
        name: REPO_NAME,
        path: repoPath,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: repoPath }],
      },
    ],
  });
  seedSettings(tmpHome, {
    tokenSecret: TOKEN,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
    defaultCodingAgent: "claude-code",
  });
  cpSync(FIXTURE, join(tmpHome, ".band", "extensions", "text-editor"), { recursive: true });
  httpLog = join(tmpHome, "http-log.jsonl");
  server = await startServer({
    tmpHome,
    env: {
      ...acpStubEnv(tmpHome, {
        turns: [
          {
            match: "^edit-doc",
            steps: [
              call("edit", "text-editor_set_text", { file: NOTE, text: "agent edit\n" }),
              { say: "edited" },
            ],
          },
          {
            match: "^open-doc",
            steps: [
              call("open", "band_editor_open", { file: OTHER }),
              call("read", "text-editor_get_text", { file: OTHER }),
              { say: "opened" },
            ],
          },
          { steps: [{ say: "ok" }] },
        ],
      }),
      BAND_TEST_ACP_HTTP_LOG: httpLog,
    },
  });
  worktreeId = toWorktreeId(REPO_NAME, "main", "local");
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server?.close();
  cleanupTmpHome(tmpHome);
});

function logLine(name: string): { status: number; body: string } | undefined {
  try {
    return readFileSync(httpLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { name: string; status: number; body: string })
      .find((l) => l.name === name);
  } catch {
    return undefined;
  }
}

/** The text of every `session/prompt` the stub agent received, oldest first. */
function promptTexts(): string[] {
  return stubRequests(tmpHome, "session/prompt").map((r) =>
    ((r.params.prompt as { type: string; text?: string }[]) ?? [])
      .map((b) => b.text ?? "")
      .join("\n"),
  );
}

async function openEditorAndChat(page: import("@playwright/test").Page, openNote: boolean) {
  const worktree = new WorktreePage(page, server.url, TOKEN);
  const trees = new FileTreesPage(page, worktree);
  const editor = new ExtensionEditorPage(page, worktree, trees);
  const chat = new ChatPanePage(page, server.url, TOKEN);
  await chat.goto(worktreeId);
  await chat.waitForReady();
  if (openNote) {
    await editor.revealFile("dir", NOTE);
    await editor.open(NOTE);
  }
  return { editor, chat };
}

test("S1: the selection shows as a chip and goes with the message unless it is removed", async ({
  page,
}) => {
  const { editor, chat } = await openEditorAndChat(page, true);

  await editor.selectText(NOTE, 0, 5);
  await chat.showChat();
  await expect(chat.selectionChip).toHaveText("chars 0-5 · note.band-test");

  await chat.removeSelectionChip();
  await expect(chat.selectionChip).toHaveCount(0);
  await chat.typeMessage("plain question");
  await chat.submit();
  await expect(chat.userMessage("plain question")).toBeVisible();
  await expect.poll(() => promptTexts().some((t) => t.includes("plain question"))).toBe(true);
  expect(promptTexts().find((t) => t.includes("plain question"))).not.toContain("Selected in");

  // A dismissed selection stays gone for later messages and after a reload.
  await expect(chat.selectionChip).toHaveCount(0);
  await chat.typeMessage("still no selection");
  await chat.submit();
  await expect.poll(() => promptTexts().some((t) => t.includes("still no selection"))).toBe(true);
  expect(promptTexts().find((t) => t.includes("still no selection"))).not.toContain("Selected in");
  await chat.reload();
  await chat.showChat();
  await expect(chat.selectionChip).toHaveCount(0);

  // A new selection brings the chip back, and it goes with one message only.
  await editor.showTab(NOTE);
  await editor.selectText(NOTE, 0, 4);
  await chat.showChat();
  await expect(chat.selectionChip).toBeVisible();
  await chat.typeMessage("what is this word");
  await chat.submit();
  await expect.poll(() => promptTexts().some((t) => t.includes("what is this word"))).toBe(true);
  expect(promptTexts().find((t) => t.includes("what is this word"))).toContain(
    `Selected in ${NOTE} (text-editor/text): chars 0-4\nAddress: chars:0-4\nhell`,
  );
  await expect(chat.selectionChip).toHaveCount(0);
  await chat.typeMessage("and the next one");
  await chat.submit();
  await expect.poll(() => promptTexts().some((t) => t.includes("and the next one"))).toBe(true);
  expect(promptTexts().find((t) => t.includes("and the next one"))).not.toContain("Selected in");
  await chat.reload();
  await chat.showChat();
  await expect(chat.selectionChip).toHaveCount(0);

  await editor.showTab(NOTE);
  await editor.selectText(NOTE, 0, 5);
  await chat.showChat();
  await expect(chat.selectionChip).toBeVisible();

  // A collapsed selection clears the chip.
  await editor.showTab(NOTE);
  await editor.selectText(NOTE, 3, 3);
  await chat.showChat();
  await expect(chat.selectionChip).toHaveCount(0);
  await expect(chat.stopButton).toHaveCount(0);
});

test("S3: the agent edits the open tab's document, the tab shows it unsaved, and saving writes it", async ({
  page,
}) => {
  const { editor, chat } = await openEditorAndChat(page, true);

  await chat.showChat();
  await chat.typeMessage("edit-doc");
  await chat.submit();

  await editor.showTab(NOTE);
  await expect(editor.textarea(NOTE)).toHaveValue("agent edit\n");
  await expect(editor.dirtyDot(NOTE)).toBeVisible();
  await expect.poll(() => logLine("edit")?.status).toBe(200);
  expect(readFileSync(join(repoPath, NOTE), "utf8")).toBe("hello extension\n");

  await editor.save(NOTE);
  await expect(editor.dirtyDot(NOTE)).toHaveCount(0);
  expect(readFileSync(join(repoPath, NOTE), "utf8")).toBe("agent edit\n");
  await chat.showChat();
  await expect(chat.assistantMessage("edited")).toBeVisible();
  await expect(chat.stopButton).toHaveCount(0);
});

test("S4: band_editor_open makes the window open the tab, and the next call reads it", async ({
  page,
}) => {
  const { editor, chat } = await openEditorAndChat(page, false);
  await expect(editor.editor(OTHER)).toHaveCount(0);

  await chat.typeMessage("open-doc");
  await chat.submit();

  await expect(editor.editor(OTHER)).toHaveAttribute("data-ready", "true");
  await expect.poll(() => logLine("read")?.status).toBe(200);
  expect(logLine("read")?.body).toContain("second file");
  await chat.showChat();
  await expect(chat.assistantMessage("opened")).toBeVisible();
  await expect(chat.stopButton).toHaveCount(0);
});
