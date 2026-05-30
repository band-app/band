/**
 * Regression coverage: pressing Esc while the `@`-mention file dropdown
 * is open closes the dropdown but MUST NOT cancel the in-flight agent
 * task.
 *
 * Before the fix in `file-mention-suggestions.tsx` (and the matching
 * change in `slash-command-suggestions.tsx`), the dropdown's Esc handler
 * called `preventDefault()` but not `stopPropagation()`. The capture-
 * phase document listener fired first, but the event then continued to
 * the textarea's React onKeyDown, which calls `onEscape()`, which is
 * wired in `ChatView.tsx` to `cancel()` whenever a task is streaming.
 * Result: typing `@`, getting a file picker, pressing Esc to dismiss it
 * also killed the running task — extremely surprising behaviour.
 *
 * Architecture: same shape as `chat-cancel.spec.ts` — real
 * `dist/start-server.mjs`, fake-agent stdio scenario with a 30 s sleep
 * so the Stop button stays visible the entire test, no tRPC mocking.
 *
 * The `@`-mention dropdown is the chosen surface because its data path
 * (`workspace.searchFiles` → `git ls-files`) needs only a real git
 * repo + one committed file in the worktree. The slash-command
 * dropdown requires the bound coding-agent to implement `listSkills()`,
 * which the fake-agent does not — but the fix applied to both Esc
 * handlers is identical (`stopPropagation()` in the capture-phase
 * document listener), so this single spec is sufficient regression
 * coverage for both call sites.
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

const TOKEN = "e2e-chat-mention-escape-token";
const PROJECT = "mentionproj";
const WORKSPACE = toWorkspaceId(PROJECT, "main");

test.use({ viewport: { width: 1280, height: 800 } });

const FAKE_AGENT_PATH = join(import.meta.dirname, "..", "tests", "fake-agent.mjs");

let server: ServerHandle;
let tmpHome: string;

// Hermetic git environment — identical pattern to
// `workspace-cache-eviction.spec.ts`. Without it a contributor's
// `GIT_CONFIG_GLOBAL` (signing keys, hooks, etc.) leaks into the
// `git init` / `commit` calls below and can hang or fail the test.
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

function git(cwd: string, args: string[], home: string): string {
  return execFileSync("git", args, { cwd, env: makeGitEnv(home), encoding: "utf-8" });
}

test.beforeAll(async () => {
  tmpHome = createTmpHome();

  // Real git repo with one committed file. `workspace.searchFiles` runs
  // `git ls-files --cached --others --exclude-standard` against the
  // worktree; without a real repo the call throws and the `@`-mention
  // dropdown never opens.
  const repoDir = join(tmpHome, "repo");
  mkdirSync(repoDir, { recursive: true });
  git(repoDir, ["init", "-b", "main"], tmpHome);
  writeFileSync(join(repoDir, "README.md"), "# Mention escape test\n");
  git(repoDir, ["add", "."], tmpHome);
  git(repoDir, ["commit", "-m", "initial commit"], tmpHome);

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
    codingAgents: [
      {
        id: "claude-code",
        type: "claude-code",
        label: "Claude Code",
        command: FAKE_AGENT_PATH,
      },
    ],
  });

  // Same fake-agent scenario as `chat-cancel.spec.ts`: emit one
  // `text-delta` IMMEDIATELY so status flips to "streaming" (Stop
  // button visible), then sleep 30 s. The sleep window is where the
  // test opens and dismisses the dropdown.
  const scenarioPath = join(tmpHome, "scenario.json");
  writeFileSync(
    scenarioPath,
    JSON.stringify([
      { type: "system", subtype: "init", session_id: "mention-escape-session" },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "partial reply " }] },
      },
      { _sleep_ms: 30_000 },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "never observed" }] },
      },
      {
        type: "result",
        subtype: "success",
        session_id: "mention-escape-session",
        duration_ms: 30_000,
        num_turns: 1,
        total_cost_usd: 0.0,
      },
    ]),
  );

  server = await startServer({
    tmpHome,
    env: { FAKE_AGENT_SCENARIO: scenarioPath },
  });
});

test.afterAll(async () => {
  if (server) await server.close();
  cleanupTmpHome(tmpHome);
});

test.describe("@-mention dropdown — Esc dismisses dropdown, not the running task", () => {
  test("Esc with the @-mention dropdown open does NOT cancel the streaming task", async ({
    page,
  }) => {
    const chatPane = new ChatPanePage(page, server.url, TOKEN);
    await chatPane.goto(WORKSPACE);
    await chatPane.waitForReady();

    // Kick a task off — Stop button visible == task is streaming.
    await chatPane.typeMessage("start a task");
    await chatPane.submit();
    await expect(chatPane.stopButton).toBeVisible();

    // Type `@` in the (now-empty) prompt to open the file-mention
    // dropdown. `clearPrompt()` ensures the textarea is empty first —
    // most submit paths clear it, but the prompt's draft logic can
    // leave whitespace, and the dropdown's regex needs `@` at position
    // 0 or preceded by whitespace.
    await chatPane.clearPrompt();
    await chatPane.focusPrompt();
    await chatPane.pressKey("@");

    // The dropdown takes ~150 ms (debounced trpc.workspace.searchFiles)
    // to populate. `toBeVisible()` auto-retries until it appears or
    // Playwright times out.
    await expect(chatPane.fileMentionDropdown).toBeVisible();

    // Press Esc. With the fix, the dropdown's capture-phase document
    // listener swallows the event via `stopPropagation()` BEFORE it
    // reaches the textarea's React onKeyDown → no `cancel()` call.
    await chatPane.pressKey("Escape");

    // 1) The dropdown is gone.
    await expect(chatPane.fileMentionDropdown).not.toBeVisible();

    // 2) The Stop button is STILL visible — i.e. the task is still
    //    streaming.
    //
    //    A single `toBeVisible()` check would race the cancel path:
    //    without the fix, Esc fires `trpc.tasks.abort` whose round-trip
    //    (~100-500 ms locally) eventually emits `task-error` and the
    //    reducer flips status out of "streaming" → Stop button
    //    unmounts. If we asserted visibility once immediately after
    //    Esc, that assertion might pass before the cancel response
    //    landed.
    //
    //    The natural reflex is `expect.poll(() => isVisible(), {
    //    timeout: 1500 }).toBe(true)`, but that's WRONG here: poll
    //    stops on the first iteration where the predicate returns the
    //    expected value, so it succeeds immediately when the button is
    //    visible and never samples STABILITY over the window. We need
    //    the opposite — assert visibility is maintained across many
    //    samples spanning the full 1.5 s.
    //
    //    Instead, loop with `toBeVisible({ timeout: 100 })` for
    //    1.5 s. Each call returns ~immediately when visible and only
    //    waits if the button is missing; the tight loop consumes real
    //    wall-clock time as Playwright keeps querying the DOM,
    //    comfortably longer than the worst-case cancel round-trip. If
    //    the button ever becomes invisible in that window, the per-
    //    iteration assertion times out and the test fails — catching
    //    the regression. `page.waitForTimeout` is banned by repo
    //    convention, so this natural-DOM-query polling is the
    //    idiomatic alternative.
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      await expect(chatPane.stopButton).toBeVisible({ timeout: 100 });
    }
  });
});
