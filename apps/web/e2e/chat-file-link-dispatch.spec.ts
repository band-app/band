/**
 * End-to-end coverage for the dispatcher-side half of issue #539:
 * the click → `useContext(FileLinkWorktreeContext)` → `dispatchOpenFile`
 * chain inside `FileLinkedAnchor`.
 *
 * The other specs in this PR
 * (`chat-file-link-worktree.spec.ts`, `chat-file-link-mobile.spec.ts`)
 * drive `band:open-file` via `window.dispatchEvent` from the page
 * context, which validates the LISTENER half but bypasses the
 * dispatcher entirely. This spec exercises the full chain a real
 * user takes:
 *
 *   1. Real chat session contains an assistant message with a path
 *      that the remark plugin auto-links to `band-file:src/main.rs:42`.
 *   2. User clicks the rendered `<a>` element.
 *   3. `FileLinkedAnchor`'s click handler reads worktreeId from
 *      `FileLinkWorktreeContext` (which `ChatView` provides) and
 *      calls `dispatchOpenFile(filename, worktreeId)`.
 *   4. A test-side window listener captures the dispatched event's
 *      detail and asserts the worktreeId matches the chat pane's
 *      owning worktree.
 *
 * Without the fix, the dispatcher carries only `{ filename }` and
 * the test sees `detail.worktreeId === undefined`. With the fix,
 * `detail.worktreeId` equals the worktree the chat lives in.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
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
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-chat-file-link-dispatch-token";
const REPO = "chat-file-link-dispatch-repo";
const DEFAULT_BRANCH = "main";
const WORKTREE = toWorktreeId(REPO, DEFAULT_BRANCH);

// Wide viewport so `useIsDesktop()` returns true and the shared
// dockview renders — the chat pane lives in the dockview, and
// `FileLinkWorktreeProvider` wraps the chat tree at the
// dockview level.
test.use({ viewport: { width: 1280, height: 800 } });

function makeGitEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@test.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@test.com",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
}

function git(cwd: string, args: string[], home: string): void {
  execFileSync("git", args, { cwd, env: makeGitEnv(home) });
}

let server!: ServerHandle;
let tmpHome: string | undefined;

test.beforeAll(async () => {
  tmpHome = createTmpHome();

  // Real git repo — the auto-link regex requires the path to look
  // file-shaped (extension + line indicator), but no actual file
  // read happens during the click; the path is just a string the
  // dispatcher carries to the listener.
  const repoPath = join(tmpHome, REPO);
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "-b", DEFAULT_BRANCH], tmpHome);
  writeFileSync(join(repoPath, "README.md"), "# dispatch test\n");
  git(repoPath, ["add", "."], tmpHome);
  git(repoPath, ["commit", "-m", "initial commit"], tmpHome);

  seedState(tmpHome, {
    repos: [
      {
        name: REPO,
        path: repoPath,
        defaultBranch: DEFAULT_BRANCH,
        worktrees: [{ branch: DEFAULT_BRANCH, path: repoPath }],
      },
    ],
  });

  seedSettings(tmpHome, {
    tokenSecret: TOKEN,
    defaultCodingAgent: "claude-code",
    codingAgents: [
      {
        id: "claude-code",
        type: "claude-code",
        label: "Claude Code",
      },
    ],
  });

  // Stub agent scenario: a single assistant message with text that
  // contains a path inside markdown inline code. The
  // `rehypeFileLinkedCode` plugin wraps the rendered `<code>` in
  // an `<a href="band-file:src/main.rs:42">` anchor — this is the
  // path that survives Streamdown's sanitize step (it runs AFTER
  // sanitize/harden, so the band-file: href isn't stripped, unlike
  // the plain-text remark plugin's links which run BEFORE sanitize
  // and get blocked). The inline-code path is what real assistant
  // replies use when referencing files (Claude / GPT outputs
  // backtick-wrapped paths by convention).
  server = await startServer({
    tmpHome,
    env: acpStubEnv(tmpHome, {
      turns: [{ steps: [{ say: "Check `src/main.rs:42` for the implementation." }] }],
    }),
  });
});

test.afterAll(async () => {
  if (server) await server.close();
  if (tmpHome) cleanupTmpHome(tmpHome);
});

test.describe("FileLinkedAnchor — click → context → dispatch (issue #539)", () => {
  test("clicking a band-file link in chat dispatches band:open-file scoped to the chat's owning worktree", async ({
    page,
  }) => {
    const worktreePage = new WorktreePage(page, server.url, TOKEN);
    const chatPane = new ChatPanePage(page, server.url, TOKEN);

    // Install the window event capture BEFORE any chat-message
    // renders so the very first click on a `band-file:` link is
    // observed. The capture lives behind a POM method so the test
    // body doesn't reach for `page.addInitScript` directly.
    await chatPane.installOpenFileCapture();

    await worktreePage.goto(WORKTREE);
    await worktreePage.waitForReady();
    await chatPane.waitForReady();

    // Send a message to wake up the stub agent. The agent replies
    // with an assistant message containing an inline-code path
    // `` `src/main.rs:42` `` (from the scenario seeded in
    // beforeAll). The `rehypeFileLinkedCode` plugin in
    // `MessageResponse` wraps the rendered `<code>` in an
    // `<a href="band-file:src/main.rs:42">`.
    await chatPane.typeMessage("kick off");
    await chatPane.submit();

    // Wait for the rendered `band-file:` link to appear — the
    // anchor's accessible name comes from the inline-code child's
    // text content. `fileLinkAnchor()` is exposed on the POM for
    // the visibility wait; the click goes through the action
    // method `clickFileLinkAnchor()` so the test body never
    // interacts with a raw Locator.
    await expect(chatPane.fileLinkAnchor(/src\/main\.rs:42/)).toBeVisible({ timeout: 10_000 });

    // Confirm the capture is clean before clicking, so the
    // post-click assertion is unambiguous.
    expect(await chatPane.capturedOpenFileEvents()).toEqual([]);

    // Click the rendered link. The onClick handler calls
    // `e.preventDefault() + e.stopPropagation()` to suppress the
    // browser's native navigation, reads `worktreeId` from the
    // surrounding `FileLinkWorktreeContext`, and dispatches the
    // band:open-file event.
    await chatPane.clickFileLinkAnchor(/src\/main\.rs:42/);

    // The dispatched event MUST carry both `filename` and
    // `worktreeId`. Without the issue #539 fix, the detail would
    // be `{ filename: "src/main.rs:42" }` only — no worktreeId.
    // With the fix, the chat's owning worktree flows through
    // the context to the dispatch.
    await expect
      .poll(() => chatPane.capturedOpenFileEvents())
      .toEqual([{ filename: "src/main.rs:42", worktreeId: WORKTREE }]);
  });
});
