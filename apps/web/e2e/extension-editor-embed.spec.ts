/**
 * `/embed/editor` (docs/extensions.md, "Embedding an editor"): the iOS app hosts an extension
 * editor in a web view through this route. Only the editor renders, in the compact layout with a
 * Save button, and the selection reaches the hub like a normal tab's. iPhone-sized viewport.
 */

import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import { git } from "./helpers/git";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { trpcQuery } from "./helpers/trpc";
import { EmbedEditorPage } from "./pages/EmbedEditorPage";

test.use({ viewport: { width: 390, height: 844 } });

const TOKEN = "e2e-extension-embed-token";
const REPO_NAME = "extension-embed-repo";
const NOTE = "dir/note.band-test";
const EDITOR = "text-editor/text";

let server: ServerHandle;
let tmpHome: string;
let repoPath: string;
let worktreeId: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  repoPath = join(tmpHome, REPO_NAME);
  mkdirSync(join(repoPath, "dir"), { recursive: true });
  git(repoPath, ["init", "-b", "main"]);
  writeFileSync(join(repoPath, NOTE), "hello embed\n");
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
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  cpSync(
    join(import.meta.dirname, "fixtures", "extensions", "text-editor"),
    join(tmpHome, ".band", "extensions", "text-editor"),
    { recursive: true },
  );
  server = await startServer({ tmpHome });
  worktreeId = toWorktreeId(REPO_NAME, "main", "local");
});

test.afterAll(async () => {
  await server?.close();
  cleanupTmpHome(tmpHome);
});

test("S7: only the editor renders, compact, with Save, and the selection reaches the hub", async ({
  page,
}) => {
  const embed = new EmbedEditorPage(page, server.url, TOKEN);
  await embed.goto(worktreeId, NOTE, EDITOR);
  await embed.waitUntilReady();

  await expect(embed.shell).toHaveCount(0);
  await expect(embed.layout).toHaveText("compact");
  await expect(embed.textarea).toHaveValue("hello embed\n");

  await expect(embed.saveButton).toBeDisabled();
  await embed.textarea.fill("edited in the embed\n");
  await expect(embed.saveButton).toBeEnabled();
  await embed.saveButton.click();
  await expect(embed.saveButton).toBeDisabled();
  expect(readFileSync(join(repoPath, NOTE), "utf8")).toBe("edited in the embed\n");

  await embed.selectText(0, 6);
  await expect
    .poll(async () => {
      const state = await trpcQuery<{ file: string; selection: { text: string } } | null>(
        server.url,
        TOKEN,
        "editors.selection",
        { worktreeId },
      );
      return state ? `${state.file}:${state.selection.text}` : null;
    })
    .toBe(`${NOTE}:edited`);
});

test("S7: a missing file or editor shows an error", async ({ page }) => {
  const embed = new EmbedEditorPage(page, server.url, TOKEN);

  await embed.goto(worktreeId, "dir/missing.band-test", EDITOR);
  await expect(embed.error).toHaveAttribute("data-error", "missing-file");
  await expect(embed.editor).toHaveCount(0);

  await embed.goto(worktreeId, NOTE, "no-such/editor");
  await expect(embed.error).toHaveAttribute("data-error", "missing-editor");
});
