/**
 * A file an agent shares opens in a center tab (issue: shared files per chat).
 *
 *   - Each card (png, pdf, md, html, ts, bin) opens a tab with the matching
 *     viewer: image, PDF frame, rendered markdown, sandboxed HTML frame,
 *     read-only code, and a binary placeholder with Download.
 *   - Clicking a card again focuses its tab instead of opening a second one.
 *   - The tab is still there after a reload.
 *   - A card's Download action saves the file under its name.
 *
 * Architecture: the REAL `dist/start-server.mjs` against a fresh temp home. The
 * scripted ACP stub holds a tool call open while the spec writes the files
 * (binary content included) into the chat's own shared folder, then completes
 * the call so the hub announces them.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { SharedFilesPage } from "./pages/SharedFilesPage";

const TOKEN = "e2e-shared-file-cards-token";
const REPO = "sharedcards";
const WORKTREE = toWorktreeId(REPO, "main", "local");
const REPLY = "Shared six files.";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const PDF = Buffer.from(
  "%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
);
const FILES: Record<string, Buffer | string> = {
  "chart.png": PNG,
  "report.pdf": PDF,
  "notes.md": "# Shared heading\n\nSome **bold** text.\n",
  "page.html": '<!doctype html><h1 id="hello">Hello from HTML</h1>',
  "util.ts": "export const answer: number = 42;\n",
  "data.bin": Buffer.from([0, 1, 2, 3, 0, 255, 254, 0]),
};

test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

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
    defaultCodingAgent: "claude-code",
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
  });
  server = await startServer({
    tmpHome,
    env: acpStubEnv(tmpHome, {
      turns: [
        {
          match: "share files",
          steps: [
            { tool: { toolCallId: "tc-share", title: "Copy files", kind: "execute" } },
            // The spec writes the files into the chat's folder during this wait.
            { sleep: 4000 },
            { toolUpdate: { toolCallId: "tc-share", status: "completed" } },
            { say: REPLY },
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

test("a shared file card opens its file in a center tab", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const chatPane = new ChatPanePage(page, server.url, TOKEN);
  const shared = new SharedFilesPage(page);
  await chatPane.goto(WORKTREE);
  await chatPane.waitForReady();
  await chatPane.typeMessage("share files");
  await chatPane.submit();

  // The turn creates the chat's own folder; put the files in it while the tool call is open.
  const worktreeDir = join(tmpHome, ".band", "shared", WORKTREE);
  await expect
    .poll(() => existsSync(worktreeDir) && readdirSync(worktreeDir).length > 0)
    .toBe(true);
  const chatDir = join(worktreeDir, readdirSync(worktreeDir)[0]);
  for (const [name, content] of Object.entries(FILES)) writeFileSync(join(chatDir, name), content);
  await expect(chatPane.assistantMessage(REPLY)).toBeVisible({ timeout: 30_000 });

  const shot = async (name: string) =>
    testInfo.attach(name, { body: await page.screenshot(), contentType: "image/png" });

  await shared.openCard("chart.png");
  await expect(shared.image).toBeVisible();
  await expect
    .poll(() => shared.image.evaluate((el: HTMLImageElement) => el.naturalWidth))
    .toBeGreaterThan(0);
  await shot("image-tab");

  await shared.openCard("report.pdf");
  await expect(shared.pdf).toBeVisible();
  await expect(shared.pdf).toHaveAttribute("src", /\/api\/shared\/.+\/report\.pdf/);
  await shot("pdf-tab");

  await shared.openCard("notes.md");
  await expect(shared.markdown.getByRole("heading", { name: "Shared heading" })).toBeVisible();
  await shot("markdown-tab");

  await shared.openCard("page.html");
  await expect(shared.html).toBeVisible();
  await expect(shared.html).toHaveAttribute("sandbox", "allow-scripts");
  await expect(
    page.frameLocator('[data-testid="shared-file__html"]:visible').getByText("Hello from HTML"),
  ).toBeVisible();
  await shot("html-tab");

  await shared.openCard("util.ts");
  await expect(shared.code).toContainText("export const answer");
  await expect(shared.code.locator('.cm-content[contenteditable="true"]')).toHaveCount(0);
  await shot("code-tab");

  await shared.openCard("data.bin");
  await expect(shared.binary).toBeVisible();
  await expect(shared.binary.getByRole("button", { name: "Download" })).toBeVisible();
  await shot("binary-tab");

  // A second click focuses the tab that is open.
  await shared.openCard("notes.md");
  await expect(shared.tab("notes.md")).toHaveCount(1);
  await expect(shared.markdown).toBeVisible();

  // The tab list survives a reload.
  await page.reload();
  await expect(shared.tab("notes.md")).toBeVisible();
  await expect(shared.tab("chart.png")).toBeVisible();
  await shared.tab("notes.md").click();
  await expect(shared.markdown.getByRole("heading", { name: "Shared heading" })).toBeVisible();

  // The card's Download action saves the file under its name.
  const download = await shared.downloadFromCard("util.ts");
  expect(download.suggestedFilename()).toBe("util.ts");
  expect(readFileSync(await download.path(), "utf8")).toBe(FILES["util.ts"]);
});
