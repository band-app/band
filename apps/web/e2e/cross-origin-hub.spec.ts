/**
 * End-to-end coverage for a UI served from a different origin than the hub
 * (plan step 1A.3).
 *
 * The built UI is served by a plain static server on port B. The hub runs on
 * port A with auth on and B in `BAND_CORS_ORIGINS`. The page gets the hub URL
 * and token from the URL fragment, so every API call is cross-origin: tRPC over
 * HTTP and WebSocket, SSE chat events, and the terminal WebSocket.
 *
 * Only the coding agent is stubbed (ACP stub agent). No `page.route()`.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import { startRecordingHubStub } from "./fixtures/recording-hub-stub";
import { type StaticUiServer, startStaticUiServer } from "./fixtures/static-ui-server";
import { acpStubEnv } from "./helpers/acp-stub";
import {
  cleanupTmpHome,
  createTmpHome,
  getRandomPort,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { ChatPanePage } from "./pages/ChatPanePage";
import { TerminalSurface } from "./pages/TerminalSurface";

const TOKEN = "e2e-cross-origin-hub-token";
const PROJECT = "crossproj";
const WORKSPACE = toWorkspaceId(PROJECT, "main");

test.use({ viewport: { width: 1280, height: 800 } });

let hub: ServerHandle;
let ui: StaticUiServer;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repoDir = join(tmpHome, "repo");
  mkdirSync(repoDir, { recursive: true });
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
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
  });

  const uiPort = await getRandomPort();
  ui = await startStaticUiServer(uiPort);
  hub = await startServer({
    tmpHome,
    env: {
      ...acpStubEnv(tmpHome, { turns: [{ steps: [{ say: "streamed across origins" }] }] }),
      BAND_CORS_ORIGINS: ui.url,
    },
  });
});

test.afterAll(async () => {
  await ui?.close();
  await hub?.close();
  cleanupTmpHome(tmpHome);
});

test("the dashboard works from a static host on another origin", async ({ page }) => {
  expect(new URL(ui.url).origin).not.toBe(new URL(hub.url).origin);

  const chat = new ChatPanePage(page, ui.url, TOKEN, hub.url);
  await chat.goto(WORKSPACE);

  // tRPC over HTTP: the workspace was listed and opened, and the terminal
  // WebSocket attached a shell.
  const terminal = new TerminalSurface(page, WORKSPACE);
  await expect(terminal.wrapper).toBeVisible();
  await terminal.typeLine("echo $((6*7))-from-hub");
  await expect.poll(() => terminal.readScreenText()).toContain("42-from-hub");

  // SSE chat events and the message POST.
  await chat.waitForReady();
  await chat.typeMessage("hello hub");
  await chat.submit();
  await expect(chat.userMessage("hello hub")).toBeVisible();
  await expect(chat.assistantMessage("streamed across origins")).toBeVisible();
});

test("a #hub= link to another hub never receives the token saved for this one", async ({
  page,
}) => {
  const other = await startRecordingHubStub(await getRandomPort());
  try {
    // Save the real hub and its token.
    const chat = new ChatPanePage(page, ui.url, TOKEN, hub.url);
    await chat.goto(WORKSPACE);
    const terminal = new TerminalSurface(page, WORKSPACE);
    await expect(terminal.wrapper).toBeVisible();

    // A link that switches the hub and carries no token of its own.
    const switched = new ChatPanePage(page, ui.url, "", other.url);
    await switched.goto(WORKSPACE);
    await expect.poll(() => other.requests.length).toBeGreaterThan(0);
    await expect(terminal.wrapper).toHaveCount(0);
    expect(JSON.stringify(other.requests)).not.toContain(TOKEN);
    expect(
      other.requests.every((r) => !r.authorization && !r.wsProtocol?.includes("band-token")),
    ).toBe(true);

    // The old token stayed with its old origin: a link back needs no token.
    const back = new ChatPanePage(page, ui.url, "", hub.url);
    await back.goto(WORKSPACE);
    await expect(terminal.wrapper).toBeVisible();
  } finally {
    await other.close();
  }
});
