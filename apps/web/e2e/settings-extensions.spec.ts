/**
 * Settings > Extensions against the real server: the list with a broken folder, install by URL
 * (an Express stub serves the archive and its .sha256) and by upload, remove, the default editor
 * per file type shared with Open With, and the read-only view of a non-admin device.
 */

import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import { makeTarGz, type TarEntry } from "../../hub/tests/helpers/make-tar";
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
import { trpcMutate, trpcMutateData } from "./helpers/trpc";
import { ExtensionEditorPage } from "./pages/ExtensionEditorPage";
import { ExtensionsSettingsPage } from "./pages/ExtensionsSettingsPage";
import { FileTreesPage } from "./pages/FileTreesPage";
import { SettingsPage } from "./pages/SettingsPage";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-settings-extensions-token";
const REPO_NAME = "settings-extensions-repo";
const BRANCH = "main";
const NOTE = "dir/note.band-test";
const PLAIN = "dir/plain.txt";
const FIXTURE = join(import.meta.dirname, "fixtures", "extensions", "text-editor");
const NOTE_EDITOR_REF = "note-editor/text";

let server: ServerHandle;
let tmpHome: string;
let repoPath: string;
let worktreeId: string;
let archive: Buffer;
let stub: Server;
let stubUrl: string;

const extensionsDir = () => join(tmpHome, ".band", "extensions");

/** The fixture extension under another id, handling `*.txt` and not the default for it. */
function writeNoteEditor(): void {
  const dir = join(extensionsDir(), "note-editor");
  cpSync(FIXTURE, dir, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(dir, "band-extension.json"), "utf8"));
  manifest.id = "note-editor";
  manifest.name = "Note editor";
  manifest.version = "2.3.4";
  manifest.contributes.fileEditors[0].label = "Note editor";
  manifest.contributes.fileEditors[0].selector = ["*.txt"];
  manifest.contributes.fileEditors[0].default = false;
  writeFileSync(join(dir, "band-extension.json"), JSON.stringify(manifest));
}

function writeBroken(): void {
  const dir = join(extensionsDir(), "broken-one");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "band-extension.json"), JSON.stringify({ id: "broken-one" }));
}

/** Puts the extensions folder in a known state and has the hub read it again. */
async function seedExtensions(opts: {
  textEditor?: boolean;
  noteEditor?: boolean;
  broken?: boolean;
}) {
  rmSync(extensionsDir(), { recursive: true, force: true });
  mkdirSync(extensionsDir(), { recursive: true });
  if (opts.textEditor) cpSync(FIXTURE, join(extensionsDir(), "text-editor"), { recursive: true });
  if (opts.noteEditor) writeNoteEditor();
  if (opts.broken) writeBroken();
  await trpcMutate(server.url, TOKEN, "extensions.reload", {});
}

function buildArchive(): Buffer {
  const entries: TarEntry[] = [{ name: "text-editor/", type: "5" }];
  for (const file of readdirSync(FIXTURE)) {
    entries.push({ name: `text-editor/${file}`, data: readFileSync(join(FIXTURE, file)) });
  }
  return makeTarGz(entries);
}

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  repoPath = join(tmpHome, REPO_NAME);
  mkdirSync(join(repoPath, "dir"), { recursive: true });
  git(repoPath, ["init", "-b", BRANCH]);
  writeFileSync(join(repoPath, NOTE), "hello extension\n");
  writeFileSync(join(repoPath, PLAIN), "plain text\n");
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "initial"]);
  seedState(tmpHome, {
    repos: [
      {
        name: REPO_NAME,
        path: repoPath,
        defaultBranch: BRANCH,
        worktrees: [{ branch: BRANCH, path: repoPath }],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
  worktreeId = toWorktreeId(REPO_NAME, BRANCH, "local");

  archive = buildArchive();
  const sha = createHash("sha256").update(archive).digest("hex");
  stub = createServer((req, res) => {
    if (req.url === "/text-editor.tar.gz") {
      res.writeHead(200, { "Content-Type": "application/gzip" });
      res.end(archive);
    } else if (req.url === "/text-editor.tar.gz.sha256") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(`${sha}  text-editor.tar.gz\n`);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((done) => stub.listen(0, "127.0.0.1", done));
  stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
});

test.beforeEach(() => {
  resetClientState(tmpHome);
});

test.afterAll(async () => {
  await new Promise<void>((done) => stub.close(() => done()));
  await server.close();
  cleanupTmpHome(tmpHome);
});

function pages(page: import("@playwright/test").Page, token = TOKEN) {
  const settings = new SettingsPage(page, server.url, token);
  return { settings, ext: new ExtensionsSettingsPage(page, settings) };
}

async function expectListed(ext: ExtensionsSettingsPage) {
  await expect(ext.name("text-editor")).toHaveText("Test text editor");
  await expect(ext.version("text-editor")).toHaveText("0.0.1");
  await expect(ext.editors("text-editor")).toContainText("*.band-test");
  await expect(ext.name("note-editor")).toHaveText("Note editor");
  await expect(ext.version("note-editor")).toHaveText("2.3.4");
  await expect(ext.editors("note-editor")).toContainText("*.txt");
  await expect(ext.brokenFolder("broken-one")).toBeVisible();
  const reason = await ext.openLoadError("broken-one");
  await expect(reason).toContainText("broken-one");
  await expect(reason).toContainText(/\w{4,}/);
}

test("S1: the list shows both extensions and the broken folder (desktop)", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await seedExtensions({ textEditor: true, noteEditor: true, broken: true });
  const { ext } = pages(page);
  await ext.open();
  await expectListed(ext);
});

test("S1: the list shows both extensions and the broken folder (phone width)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedExtensions({ textEditor: true, noteEditor: true, broken: true });
  const { ext } = pages(page);
  await ext.open();
  await expectListed(ext);
});

test("S2: install by URL with its .sha256, and a wrong sha256 installs nothing", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await seedExtensions({});
  const { ext } = pages(page);
  await ext.open();

  const wrong = page.waitForResponse((r) => r.url().includes("extensions.install"));
  await ext.installFromUrl(`${stubUrl}/text-editor.tar.gz`, "0".repeat(64));
  expect((await wrong).status()).toBe(400);
  const message = await ext.installError();
  await expect(message).toBeVisible();
  await expect(ext.row("text-editor")).toHaveCount(0);

  const ok = page.waitForResponse((r) => r.url().includes("extensions.install"));
  await ext.shaInput.fill("");
  await ext.installFromUrl(`${stubUrl}/text-editor.tar.gz`);
  expect((await ok).status()).toBe(200);
  await expect(ext.row("text-editor")).toBeVisible();

  await ext.settings.backToApp();
  const worktree = new WorktreePage(page, server.url, TOKEN);
  const editor = new ExtensionEditorPage(page, worktree, new FileTreesPage(page, worktree));
  await worktree.goto(worktreeId);
  await worktree.waitForReady();
  await editor.revealFile("dir", NOTE);
  await editor.open(NOTE);
  await expect(editor.textarea(NOTE)).toHaveValue("hello extension\n");
});

test("S3: upload an archive", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await seedExtensions({});
  const { ext } = pages(page);
  await ext.open();

  const done = page.waitForResponse((r) => r.url().includes("/api/extensions/install"));
  await ext.upload({ name: "text-editor.tar.gz", mimeType: "application/gzip", buffer: archive });
  expect((await done).status()).toBe(200);
  await expect(ext.row("text-editor")).toBeVisible();
  await expect(ext.version("text-editor")).toHaveText("0.0.1");
});

test("S4: remove an extension and its files open in the built-in viewer", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await seedExtensions({ textEditor: true });
  const { ext } = pages(page);
  await ext.open();
  await expect(ext.row("text-editor")).toBeVisible();

  const removed = page.waitForResponse((r) => r.url().includes("extensions.remove"));
  await ext.remove("text-editor");
  expect((await removed).status()).toBe(200);
  await expect(ext.row("text-editor")).toHaveCount(0);

  await ext.settings.backToApp();
  const worktree = new WorktreePage(page, server.url, TOKEN);
  const editor = new ExtensionEditorPage(page, worktree, new FileTreesPage(page, worktree));
  await worktree.goto(worktreeId);
  await worktree.waitForReady();
  await editor.revealFile("dir", NOTE);
  await new FileTreesPage(page, worktree).clickFile(NOTE);
  await expect(editor.builtinViewer).toBeVisible();
  await expect(editor.editor(NOTE)).toHaveCount(0);
});

test("S5: the default editor set here shows in Open With, and clearing it works both ways", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await seedExtensions({ noteEditor: true });
  const worktree = new WorktreePage(page, server.url, TOKEN);
  const trees = new FileTreesPage(page, worktree);
  const editor = new ExtensionEditorPage(page, worktree, trees);
  const { settings, ext } = pages(page);
  await worktree.goto(worktreeId);
  await worktree.waitForReady();
  await editor.revealFile("dir", PLAIN);

  const current = async () => {
    return editor.explorerOpenWithEntries(PLAIN);
  };

  await settings.openDialog("extensions");
  await ext.expectDefault("*.txt", "manifest");
  await ext.chooseDefault("*.txt", NOTE_EDITOR_REF);
  await ext.expectDefault("*.txt", NOTE_EDITOR_REF);
  await settings.backToApp();

  await current();
  await expect(editor.openWithItem("file-tree", NOTE_EDITOR_REF)).toContainText("(current)");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // Clearing here clears there.
  await settings.openDialog("extensions");
  await ext.chooseDefault("*.txt", "manifest");
  await ext.expectDefault("*.txt", "manifest");
  await settings.backToApp();
  const menu = await current();
  await expect(menu).toBeVisible();
  await expect(editor.openWithItem("file-tree", "builtin")).toContainText("(current)");
  await expect(editor.openWithItem("file-tree", NOTE_EDITOR_REF)).not.toContainText("(current)");

  // Setting it in Open With shows here.
  await editor.setDefaultItem("file-tree", NOTE_EDITOR_REF).click();
  await settings.openDialog("extensions");
  await ext.expectDefault("*.txt", NOTE_EDITOR_REF);
});

test("S6: a non-admin device sees the list and defaults but no controls", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await seedExtensions({ textEditor: true, noteEditor: true });
  const { token } = await trpcMutateData<{ token: string }>(
    server.url,
    TOKEN,
    "tokens.createDevice",
    { label: "e2e plain device" },
  );
  const { ext } = pages(page, token);
  await ext.open();

  await expect(ext.row("text-editor")).toBeVisible();
  await expect(ext.row("note-editor")).toBeVisible();
  await expect(ext.defaultValue("*.txt")).toHaveAttribute("data-default", "manifest");
  await expect(ext.urlInput).toHaveCount(0);
  await expect(ext.uploadButton).toHaveCount(0);
  await expect(ext.reloadButton).toHaveCount(0);
  await expect(ext.removeButton("text-editor")).toHaveCount(0);
  await expect(ext.defaultSelect("*.txt")).toHaveCount(0);
});
