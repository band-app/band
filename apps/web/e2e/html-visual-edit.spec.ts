/**
 * Visual mode of the HTML file viewer: the page renders in a sandboxed iframe
 * and, a click on source text makes it editable and the
 * commit patches only that text range in the file.
 *
 * The real hub boots on a tmp HOME with a real git worktree. Files are read
 * and written on disk in the temp worktree.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { ChatPanePage } from "./pages/ChatPanePage";
import { FileTreesPage } from "./pages/FileTreesPage";
import { HtmlVisualPage } from "./pages/HtmlVisualPage";
import { WorktreePage } from "./pages/WorktreePage";

test.use({ viewport: { width: 1600, height: 900 } });

const TOKEN = "e2e-html-visual-token";
const REPO_NAME = "html-visual-repo";
const BRANCH = "main";
const HTML_PATH = "deck/slides.html";
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
// Tabs, uneven indentation, a comment, attribute order and a script-made text on purpose.
const SLIDES_HTML = [
  "<!doctype html>\n",
  '<html lang="en">\n',
  "<head>\n",
  '\t<meta charset="utf-8">\n',
  '\t<link rel="stylesheet" href="style.css">\n',
  "</head>\n",
  "<body>\n",
  "  <!-- keep me -->\n",
  '\t<h1   id="title"  class="big">Quarterly review</h1>\n',
  '      <p class="note">Second   slide</p>\n',
  '  <img src="logo.png" alt="logo">\n',
  '  <div id="runtime"></div>\n',
  '  <script>document.getElementById("runtime").textContent = "made by script";</script>\n',
  "</body>\n",
  "</html>\n",
].join("");

let server: ServerHandle;
let tmpHome: string;
let repoPath: string;
let worktreeId: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  repoPath = join(tmpHome, REPO_NAME);
  mkdirSync(join(repoPath, "deck"), { recursive: true });
  git(repoPath, ["init", "-b", BRANCH]);
  writeFileSync(join(repoPath, HTML_PATH), SLIDES_HTML);
  writeFileSync(join(repoPath, "deck", "style.css"), "h1 { color: rgb(1, 2, 3); }");
  writeFileSync(join(repoPath, "deck", "logo.png"), PNG_BYTES);
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
});

test.beforeEach(async () => {
  await resetClientState(tmpHome);
  writeFileSync(join(repoPath, HTML_PATH), SLIDES_HTML);
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

const readSlides = () => readFileSync(join(repoPath, HTML_PATH), "utf8");

async function openVisual(page: import("@playwright/test").Page): Promise<HtmlVisualPage> {
  const worktree = new WorktreePage(page, server.url, TOKEN);
  const trees = new FileTreesPage(page, worktree);
  const visual = new HtmlVisualPage(page);
  await worktree.goto(worktreeId);
  await worktree.waitForReady();
  await trees.openFilesTab("deck");
  await trees.expandFileTreeFolder("deck", HTML_PATH);
  await trees.openFile(HTML_PATH);
  await visual.openVisual();
  return visual;
}

test.describe("HTML Visual mode", () => {
  test("S1: renders the page with its stylesheet and image", async ({ page }) => {
    const visual = await openVisual(page);

    const heading = visual.frame.getByRole("heading", { name: "Quarterly review" });
    await expect(heading).toBeVisible();
    await expect(heading).toHaveCSS("color", "rgb(1, 2, 3)");
    await expect(visual.frame.getByRole("img", { name: "logo" })).toHaveJSProperty(
      "naturalWidth",
      1,
    );
    await expect(visual.frameElement).toHaveAttribute("sandbox", "allow-scripts");
  });

  test("S2: an edit changes only the edited text range", async ({ page }) => {
    const visual = await openVisual(page);
    await visual.turnOnEditText();

    await visual.replaceText(visual.frame.getByRole("heading"), "Annual summary");

    await expect.poll(readSlides).toBe(SLIDES_HTML.replace("Quarterly review", "Annual summary"));
    await expect(visual.frame.getByRole("heading", { name: "Annual summary" })).toBeVisible();
  });

  test("S3: markup characters are written as entities and shown literally", async ({ page }) => {
    const visual = await openVisual(page);
    await visual.turnOnEditText();

    await visual.replaceText(visual.frame.getByText("Second slide"), "<b>&");

    await expect.poll(readSlides).toBe(SLIDES_HTML.replace("Second   slide", "&lt;b&gt;&amp;"));
    await expect(visual.frame.locator("p.note")).toHaveText("<b>&");
  });

  test("S4: text a script inserted is not editable and nothing is written", async ({ page }) => {
    const visual = await openVisual(page);
    await visual.turnOnEditText();
    const generated = visual.frame.locator("#runtime");
    await expect(generated).toHaveText("made by script");

    await generated.click();
    await page.keyboard.insertText("typed");

    await expect(generated).not.toHaveAttribute("contenteditable", /.*/);
    await expect(generated).toHaveText("made by script");
    expect(readSlides()).toBe(SLIDES_HTML);
  });

  test("S5: an edit against a changed file is refused, the preview reloads and a notice shows", async ({
    page,
  }) => {
    const visual = await openVisual(page);
    await visual.turnOnEditText();
    const heading = visual.frame.getByRole("heading");
    await heading.click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.insertText("Mine");

    // An agent edits the file while the person is typing.
    const changed = `<!-- new first line -->\n${SLIDES_HTML.replace("Quarterly review", "Theirs")}`;
    writeFileSync(join(repoPath, HTML_PATH), changed);
    await page.keyboard.press("Enter");

    await expect(visual.notice).toContainText("changed");
    expect(readSlides()).toBe(changed);
    await expect(visual.frame.getByRole("heading", { name: "Theirs" })).toBeVisible();
  });

  test("a saved edit does not reload the page, and a later edit still lands", async ({ page }) => {
    const visual = await openVisual(page);
    await visual.turnOnEditText();
    await visual.markPage();

    // A longer heading moves every range after it, and the second edit is checked against the file.
    await visual.replaceText(visual.frame.getByRole("heading"), "Annual summary of the year");
    const afterFirst = SLIDES_HTML.replace("Quarterly review", "Annual summary of the year");
    await expect.poll(readSlides).toBe(afterFirst);
    await visual.replaceText(visual.frame.getByText("Second slide"), "Second slide, edited");

    await expect
      .poll(readSlides)
      .toBe(afterFirst.replace("Second   slide", "Second slide, edited"));
    await expect(visual.notice).toHaveCount(0);
    expect(await visual.pageIsMarked()).toBe(true);
    // The same element can be edited again, whitespace around its text stays.
    await visual.replaceText(visual.frame.getByRole("heading"), "Final");
    await expect
      .poll(readSlides)
      .toBe(
        afterFirst
          .replace("Second   slide", "Second slide, edited")
          .replace("Annual summary of the year", "Final"),
      );
  });

  test("S6: Escape reverts the text and leaves the file alone", async ({ page }) => {
    const visual = await openVisual(page);
    await visual.turnOnEditText();
    const heading = visual.frame.getByRole("heading");

    await visual.typeThenCancel(heading, " extra");

    await expect(heading).toHaveText("Quarterly review");
    await expect(heading).not.toHaveAttribute("contenteditable", /.*/);
    expect(readSlides()).toBe(SLIDES_HTML);
  });

  test("S7: messages from another window or with a wrong nonce write nothing", async ({ page }) => {
    const visual = await openVisual(page);
    await visual.turnOnEditText();
    await expect(visual.frameElement).toHaveAttribute("sandbox", /^allow-scripts$/);
    const start = SLIDES_HTML.indexOf("Quarterly review");
    const range = { start, end: start + "Quarterly review".length };

    await visual.postForgedCommitFromPage(range);
    await visual.postForgedCommitFromParent(await visual.frameNonce(), range);
    await visual.postForgedCommitFromParent(null, range);

    // A real edit afterwards still works, so the forged ones were ignored rather than the bridge being dead.
    await visual.replaceText(visual.frame.getByRole("heading"), "Real edit");
    await expect.poll(readSlides).toBe(SLIDES_HTML.replace("Quarterly review", "Real edit"));
  });

  test("selecting text and commenting sends a change request to the agent's chat", async ({
    page,
  }) => {
    const visual = await openVisual(page);
    const chat = new ChatPanePage(page, server.url, TOKEN);

    await visual.dragSelect(visual.frame.getByRole("heading"));
    await visual.sendComment("Make this heading shorter");

    await expect.poll(() => chat.screenText()).toContain("Make this heading shorter");
    expect(await chat.screenText()).toContain("slides.html");
    expect(readSlides()).toBe(SLIDES_HTML);
  });

  test("Alt+click comments on an element that is not editable text", async ({ page }) => {
    const visual = await openVisual(page);
    const chat = new ChatPanePage(page, server.url, TOKEN);

    await visual.altClick(visual.frame.locator("#runtime"));
    await visual.sendComment("Say something else here");

    await expect.poll(() => chat.screenText()).toContain("Say something else here");
    expect(await chat.screenText()).toContain("generated by a script");
    expect(readSlides()).toBe(SLIDES_HTML);
  });

  test("the Edit toggle shows only in Visual mode and edits only when on", async ({ page }) => {
    const visual = await openVisual(page);
    await expect(visual.editToggle).toBeVisible();
    await expect(visual.editToggle).toHaveAttribute("aria-pressed", "false");

    // Off: a click on text does not make it editable.
    const heading = visual.frame.getByRole("heading");
    await heading.click();
    await expect(heading).not.toHaveAttribute("contenteditable", /.*/);

    await visual.sourceButton.click();
    await expect(visual.editToggle).toHaveCount(0);
  });
});
