/**
 * End-to-end coverage for the dispatcher-side half of issue #539:
 * the click → `useContext(FileLinkWorkspaceContext)` → `dispatchOpenFile`
 * chain inside `FileLinkedAnchor`.
 *
 * The other specs in this PR
 * (`chat-file-link-workspace.spec.ts`, `chat-file-link-mobile.spec.ts`)
 * drive `band:open-file` via `window.dispatchEvent` from the page
 * context, which validates the LISTENER half but bypasses the
 * dispatcher entirely. This spec exercises the full chain a real
 * user takes:
 *
 *   1. Real chat session contains an assistant message with a path
 *      that the remark plugin auto-links to `band-file:src/main.rs:42`.
 *   2. User clicks the rendered `<a>` element.
 *   3. `FileLinkedAnchor`'s click handler reads workspaceId from
 *      `FileLinkWorkspaceContext` (which `ChatView` provides) and
 *      calls `dispatchOpenFile(filename, workspaceId)`.
 *   4. A test-side window listener captures the dispatched event's
 *      detail and asserts the workspaceId matches the chat pane's
 *      owning workspace.
 *
 * Without the fix, the dispatcher carries only `{ filename }` and
 * the test sees `detail.workspaceId === undefined`. With the fix,
 * `detail.workspaceId` equals the workspace the chat lives in.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
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

const TOKEN = "e2e-chat-file-link-dispatch-token";
const PROJECT = "chat-file-link-dispatch-repo";
const DEFAULT_BRANCH = "main";
const WORKSPACE = toWorkspaceId(PROJECT, DEFAULT_BRANCH);

// Wide viewport so `useIsDesktop()` returns true and the shared
// dockview renders — the chat pane lives in the dockview, and
// `FileLinkWorkspaceProvider` wraps the chat tree at the
// dockview level.
test.use({ viewport: { width: 1280, height: 800 } });

const FAKE_AGENT_PATH = join(import.meta.dirname, "..", "tests", "fake-agent.mjs");

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
  const repoPath = join(tmpHome, PROJECT);
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "-b", DEFAULT_BRANCH], tmpHome);
  writeFileSync(join(repoPath, "README.md"), "# dispatch test\n");
  git(repoPath, ["add", "."], tmpHome);
  git(repoPath, ["commit", "-m", "initial commit"], tmpHome);

  seedState(tmpHome, {
    projects: [
      {
        name: PROJECT,
        path: repoPath,
        defaultBranch: DEFAULT_BRANCH,
        worktrees: [{ branch: DEFAULT_BRANCH, path: repoPath }],
      },
    ],
  });

  // Fake-agent scenario: a single assistant message with text that
  // contains a path inside markdown inline code. The
  // `rehypeFileLinkedCode` plugin wraps the rendered `<code>` in
  // an `<a href="band-file:src/main.rs:42">` anchor — this is the
  // path that survives Streamdown's sanitize step (it runs AFTER
  // sanitize/harden, so the band-file: href isn't stripped, unlike
  // the plain-text remark plugin's links which run BEFORE sanitize
  // and get blocked). The inline-code path is what real assistant
  // replies use when referencing files (Claude / GPT outputs
  // backtick-wrapped paths by convention).
  const scenarioPath = join(tmpHome, "scenario.json");
  writeFileSync(
    scenarioPath,
    JSON.stringify([
      { type: "system", subtype: "init", session_id: "dispatch-session" },
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "text",
              text: "Check `src/main.rs:42` for the implementation.",
            },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        session_id: "dispatch-session",
        duration_ms: 1,
        num_turns: 1,
        total_cost_usd: 0.0,
      },
    ]),
  );

  seedSettings(tmpHome, {
    tokenSecret: TOKEN,
    defaultCodingAgent: "claude-code",
    codingAgents: [
      {
        id: "claude-code",
        type: "claude-code",
        label: "Claude Code",
        command: FAKE_AGENT_PATH,
      },
    ],
  });

  server = await startServer({
    tmpHome,
    env: { FAKE_AGENT_SCENARIO: scenarioPath },
  });
});

test.afterAll(async () => {
  if (server) await server.close();
  if (tmpHome) cleanupTmpHome(tmpHome);
});

test.describe("FileLinkedAnchor — click → context → dispatch (issue #539)", () => {
  test("clicking a band-file link in chat dispatches band:open-file scoped to the chat's owning workspace", async ({
    page,
  }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    const chatPane = new ChatPanePage(page, server.url, TOKEN);

    // Install the window event capture BEFORE any chat-message
    // renders so the very first click on a `band-file:` link is
    // observed. The capture lives behind a POM method so the test
    // body doesn't reach for `page.addInitScript` directly.
    await chatPane.installOpenFileCapture();

    await workspacePage.goto(WORKSPACE);
    await workspacePage.waitForReady();
    await chatPane.waitForReady();

    // Send a message to wake up the fake-agent. The agent replies
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
    // browser's native navigation, reads `workspaceId` from the
    // surrounding `FileLinkWorkspaceContext`, and dispatches the
    // band:open-file event.
    await chatPane.clickFileLinkAnchor(/src\/main\.rs:42/);

    // The dispatched event MUST carry both `filename` and
    // `workspaceId`. Without the issue #539 fix, the detail would
    // be `{ filename: "src/main.rs:42" }` only — no workspaceId.
    // With the fix, the chat's owning workspace flows through
    // the context to the dispatch.
    await expect
      .poll(() => chatPane.capturedOpenFileEvents())
      .toEqual([{ filename: "src/main.rs:42", workspaceId: WORKSPACE }]);
  });
});
