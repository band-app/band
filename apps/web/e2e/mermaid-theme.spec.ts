/**
 * Mermaid diagrams follow the light/dark mode: the markdown preview renders a
 * sequence diagram with mermaid's `default` theme in light mode and its `dark`
 * theme in dark mode, and switching the mode in Settings > Appearance
 * re-renders the open diagram without a reload.
 *
 * Real server, real Chromium. The diagram's message label colour is the
 * observable: dark on light, light on dark.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
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
import { AppearancePage } from "./pages/AppearancePage";
import { FileViewerPage } from "./pages/FileViewerPage";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-mermaid-theme-token";
const REPO = "mermaid-theme-repo";
const BRANCH = "main";
const WORKTREE = toWorktreeId(REPO, BRANCH, "local");
const DIAGRAM = "sequenceDiagram\n  Alice->>Bob: Hello Bob\n  Bob-->>Alice: Hi Alice";

test.use({ viewport: { width: 1280, height: 900 } });

let server: ServerHandle;
let tmpHome: string;

async function startWith(theme: "light" | "dark"): Promise<void> {
  tmpHome = createTmpHome();
  const repo = join(tmpHome, REPO);
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", BRANCH]);
  writeFileSync(join(repo, "DIAGRAM.md"), `# Diagram\n\n\`\`\`mermaid\n${DIAGRAM}\n\`\`\`\n`);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "initial"]);
  seedState(tmpHome, {
    repos: [
      {
        name: REPO,
        path: repo,
        defaultBranch: BRANCH,
        worktrees: [{ branch: BRANCH, path: repo }],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN, theme, useWebGLTerminalRenderer: false });
  server = await startServer({ tmpHome });
}

test.afterEach(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test("S1: dark mode renders the diagram with light text", async ({ page }, testInfo) => {
  await startWith("dark");
  resetClientState(tmpHome);
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  const viewer = new FileViewerPage(page);
  await worktreePage.goto(WORKTREE);
  await worktreePage.waitForReady();
  await worktreePage.openFileLeaf("DIAGRAM.md");
  expect(await viewer.previewMermaidTextBrightness()).toBeGreaterThan(160);
  await testInfo.attach("mermaid-dark", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});

test("S2 and S3: light mode renders dark text, and switching to dark re-renders without a reload", async ({
  page,
}, testInfo) => {
  await startWith("light");
  resetClientState(tmpHome);
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  const viewer = new FileViewerPage(page);
  const appearance = new AppearancePage(page, server.url, TOKEN);
  await worktreePage.goto(WORKTREE);
  await worktreePage.waitForReady();
  await worktreePage.openFileLeaf("DIAGRAM.md");
  expect(await viewer.previewMermaidTextBrightness()).toBeLessThan(100);
  await testInfo.attach("mermaid-light", {
    body: await page.screenshot(),
    contentType: "image/png",
  });

  await appearance.settings.openDialog("appearance");
  await appearance.chooseMode("dark");
  await page.keyboard.press("Escape");
  await expect.poll(() => viewer.previewMermaidTextBrightness()).toBeGreaterThan(160);
  await testInfo.attach("mermaid-switched-dark", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});
