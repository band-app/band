/**
 * End-to-end coverage for the terminal link menu.
 *
 * A plain click on a URL printed in a terminal opens a popover at the link
 * with Copy link and Open in system browser (and Open in Band browser in the
 * desktop app). Cmd+click (Ctrl+click off macOS) skips the popover. This
 * boots the production server and a real PTY in the web build, which has no
 * browser panes, so the Band browser row is absent and Cmd+click opens the
 * system browser. The Band browser tab itself needs a `<webview>`, which only
 * the desktop app renders; it is not covered here.
 *
 * Renderer note: the DOM renderer is forced (as in `terminal-file-links.spec.ts`)
 * so the printed URL is locatable text.
 */

import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { TerminalLinkPopoverPage } from "./pages/TerminalLinkPopoverPage";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-terminal-link-popover-token";
const REPO = "alpha-terminal-link-popover";
const WORKTREE = toWorktreeId(REPO, "main", "local");
const URL_TEXT = "https://example.test/path";
const MOD = process.platform === "darwin" ? "Meta" : "Control";

test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;
let workdir: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  workdir = realpathSync(mkdtempSync(join(tmpdir(), "band-term-link-popover-")));
  writeFileSync(join(workdir, "wrap.sh"), WRAP_SCRIPT);
  seedState(tmpHome, {
    repos: [
      {
        name: REPO,
        path: workdir,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: workdir }],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN, useWebGLTerminalRenderer: false });
  server = await startServer({ tmpHome });
});

// Prints link text for the wrap tests at the terminal's real width. `fill N` is N letters.
// hard: Ink-style rows, each hard-newlined and indented by two spaces, the URL running to
// the right edge and a ")" after it. soft: one long line xterm wraps itself.
const WRAP_SCRIPT = String.raw`
cols=$(stty size | cut -d' ' -f2)
fill() { printf '%*s' "$1" '' | tr ' ' a; }
len() { printf %s "$1" | wc -c | tr -d ' '; }
mode=$1; tag=$2; out=$3
case $mode in
  hard)
    pre="  Authorize ("
    t1="https://example.test/$tag-k1x-"; t2="$tag-k2x-"; t3="$tag-k3x-"; t4="$tag-k4x-end"
    f1=$(fill $((cols - $(len "$pre$t1"))))
    f2=$(fill $((cols - 2 - $(len "$t2"))))
    f3=$(fill $((cols - 2 - $(len "$t3"))))
    printf '%s' "$t1$f1$t2$f2$t3$f3$t4" > "$out"
    printf '%s\n  %s\n  %s\n  %s)\n' "$pre$t1$f1" "$t2$f2" "$t3$f3" "$t4"
    ;;
  soft)
    u="https://example.test/$(fill $((cols + 5)))$tag-k2x-end"
    printf '%s' "$u" > "$out"
    printf '%s\n' "$u"
    ;;
  osc)
    printf '\033]8;;https://osc.test/target?x=1\033\\%s\033]8;;\033\\\n' "$(fill $((cols + 3)))$tag-k2x-end"
    ;;
esac
`;

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
  rmSync(workdir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function printLink(page: import("@playwright/test").Page): Promise<{
  worktreePage: WorktreePage;
  menu: TerminalLinkPopoverPage;
}> {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  await worktreePage.goto(WORKTREE);
  await worktreePage.waitForReady();
  await worktreePage.openTerminalTab();
  await worktreePage.waitForTerminalReady(75_000);
  await worktreePage.runInTerminal(`echo ${URL_TEXT}`);
  return { worktreePage, menu: new TerminalLinkPopoverPage(page) };
}

test.describe("Terminal link menu", () => {
  test("a click on a URL opens the menu without opening anything", async ({ page, context }) => {
    test.setTimeout(120_000);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const { worktreePage, menu } = await printLink(page);
    const opened: string[] = [];
    context.on("page", (p) => opened.push(p.url()));

    await worktreePage.clickTerminalFileLink(URL_TEXT);

    await expect(menu.popover).toBeVisible();
    await expect(menu.url).toHaveText(URL_TEXT);
    await expect(menu.openInSystemBrowser).toBeVisible();
    // The web build has no browser panes.
    await expect(menu.openInBandBrowser).toHaveCount(0);
    expect(opened).toEqual([]);

    // Copy link puts the URL on the clipboard and shows a check.
    await menu.copy();
    await expect(menu.copyButton).toHaveAccessibleName("Copied");
    expect(await menu.readClipboard()).toBe(URL_TEXT);

    // Escape closes the menu and typing reaches the terminal again.
    await menu.dismissWithEscape();
    await worktreePage.runInTerminal("echo after-escape-marker");
    await worktreePage.waitForTerminalOutput("after-escape-marker");
  });

  test("Open in system browser hands the URL to a new page and closes the menu", async ({
    page,
    context,
  }) => {
    test.setTimeout(120_000);
    const { worktreePage, menu } = await printLink(page);
    await worktreePage.clickTerminalFileLink(URL_TEXT);
    await expect(menu.popover).toBeVisible();

    // example.test does not resolve, so the new page ends on an error page;
    // the request it made for the URL is what shows the URL was opened.
    const request = context.waitForEvent("request", (r) => r.url() === URL_TEXT);
    await menu.openInSystem();
    await request;
    await expect(menu.popover).toBeHidden();
  });

  test("Cmd+click skips the menu and opens the system browser in the web build", async ({
    page,
    context,
  }) => {
    test.setTimeout(120_000);
    const { worktreePage, menu } = await printLink(page);

    // example.test does not resolve, so the new page ends on an error page;
    // the request it made for the URL is what shows the URL was opened.
    const request = context.waitForEvent("request", (r) => r.url() === URL_TEXT);
    await worktreePage.clickTerminalFileLink(URL_TEXT, [MOD]);
    await request;
    await expect(menu.popover).toBeHidden();
  });

  test("a URL an agent hard-wrapped over several rows opens whole from any row", async ({
    page,
    context,
  }) => {
    test.setTimeout(120_000);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const { worktreePage, menu } = await printLink(page);
    const urlFile = join(workdir, "hard.url");
    await worktreePage.runInTerminal(`sh wrap.sh hard hardA ${urlFile}`);

    await worktreePage.clickTerminalRowContaining("hardA-k3x-");

    await expect(menu.popover).toBeVisible();
    const full = readFileSync(urlFile, "utf8");
    expect(full).toContain("hardA-k4x-end");
    await expect(menu.url).toHaveText(full);
    await menu.copy();
    expect(await menu.readClipboard()).toBe(full);
  });

  test("a URL that ends mid-row is not extended by the next row", async ({ page }) => {
    test.setTimeout(120_000);
    const { worktreePage, menu } = await printLink(page);
    await worktreePage.runInTerminal("printf 'see https://a.test/x\\nnext line\\n'");

    await worktreePage.clickTerminalFileLink("see https://a.test/x");

    await expect(menu.popover).toBeVisible();
    await expect(menu.url).toHaveText("https://a.test/x");
  });

  test("a URL xterm soft-wrapped still opens whole", async ({ page }) => {
    test.setTimeout(120_000);
    const { worktreePage, menu } = await printLink(page);
    const urlFile = join(workdir, "soft.url");
    await worktreePage.runInTerminal(`sh wrap.sh soft softB ${urlFile}`);

    await worktreePage.clickTerminalRowContaining("softB-k2x-");

    await expect(menu.popover).toBeVisible();
    await expect(menu.url).toHaveText(readFileSync(urlFile, "utf8"));
  });

  test("an OSC 8 hyperlink that wraps opens its target from any row", async ({ page, context }) => {
    test.setTimeout(120_000);
    const { worktreePage, menu } = await printLink(page);
    await worktreePage.runInTerminal("sh wrap.sh osc oscC /dev/null");

    await worktreePage.clickTerminalRowContaining("oscC-k2x-");
    await expect(menu.popover).toBeVisible();
    await expect(menu.url).toHaveText("https://osc.test/target?x=1");
    await menu.dismissWithEscape();

    const request = context.waitForEvent(
      "request",
      (r) => r.url() === "https://osc.test/target?x=1",
    );
    await worktreePage.clickTerminalRowContaining("oscC-k2x-", [MOD]);
    await request;
    await expect(menu.popover).toBeHidden();
  });

  test("a new pane asks programs for OSC 8 hyperlinks", async ({ page }) => {
    test.setTimeout(120_000);
    const { worktreePage } = await printLink(page);
    await worktreePage.runInTerminal("echo force-hyperlink=$FORCE_HYPERLINK");
    await worktreePage.waitForTerminalOutput("force-hyperlink=1");
  });
});
