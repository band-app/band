/**
 * Composer input row: + at the left, text, then Send and the mic at the right. Send keeps the
 * foreground color in every state and theme.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import { acpStubEnv } from "./helpers/acp-stub";
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

const TOKEN = "e2e-composer-layout-token";
const WS = toWorktreeId("layoutrepo", "main", "local");

let tmpHome: string;
let server: ServerHandle;

async function start(voice: boolean) {
  tmpHome = createTmpHome();
  const repoDir = join(tmpHome, "layoutrepo");
  mkdirSync(repoDir, { recursive: true });
  seedState(tmpHome, {
    repos: [
      {
        name: "layoutrepo",
        path: repoDir,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: repoDir }],
      },
    ],
  });
  seedSettings(tmpHome, {
    tokenSecret: TOKEN,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
    ...(voice ? { voice: { enabled: true, baseUrl: "http://127.0.0.1:1/v1", model: "m" } } : {}),
  });
  server = await startServer({
    tmpHome,
    env: acpStubEnv(tmpHome, {
      turns: [
        { match: "^start", steps: [{ say: "working " }, { waitForCancel: true }] },
        { steps: [] },
      ],
    }),
  });
}

test.use({
  launchOptions: {
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  },
});

test.afterEach(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

for (const [name, viewport] of [
  ["desktop", { width: 1280, height: 800 }],
  ["phone", { width: 390, height: 844 }],
] as const) {
  test(`${name}: + , text, Send, mic share one row in that order`, async ({ page }) => {
    await start(true);
    await page.setViewportSize(viewport);
    const chat = new ChatPanePage(page, server.url, TOKEN);
    await chat.goto(WS);
    await chat.waitForReady();
    const r = await chat.composerRow();
    expect(r.attach && r.textarea && r.submit && r.mic).toBeTruthy();
    const { attach, textarea, submit, mic } = r as Record<string, NonNullable<typeof r.attach>>;
    expect(attach.x + attach.width).toBeLessThanOrEqual(textarea.x + 1);
    expect(textarea.x + textarea.width).toBeLessThanOrEqual(submit.x + 1);
    expect(submit.x + submit.width).toBeLessThanOrEqual(mic.x + 1);
    // Same row: the controls sit inside the textarea's vertical span.
    for (const b of [attach, submit, mic]) {
      expect(b.y).toBeGreaterThanOrEqual(textarea.y - 8);
      expect(b.y + b.height).toBeLessThanOrEqual(textarea.y + textarea.height + 8);
      expect(b.width).toBeGreaterThanOrEqual(name === "phone" ? 32 : 28);
    }
    expect(textarea.width).toBeGreaterThan(name === "phone" ? 150 : 400);
    await page.screenshot({ path: test.info().outputPath(`composer-${name}.png`) });
  });
}

test("without voice, Send is the rightmost control", async ({ page }) => {
  await start(false);
  const chat = new ChatPanePage(page, server.url, TOKEN);
  await chat.goto(WS);
  await chat.waitForReady();
  const r = await chat.composerRow();
  expect(r.mic).toBeNull();
  expect(r.submit).not.toBeNull();
  expect(r.submit!.x).toBeGreaterThan(r.textarea!.x + r.textarea!.width - 1);
});

for (const scheme of ["light", "dark"] as const) {
  test(`${scheme}: Send icon stays the foreground color on hover`, async ({ page }) => {
    await start(false);
    await page.emulateMedia({ colorScheme: scheme });
    const chat = new ChatPanePage(page, server.url, TOKEN);
    await resetClientState(tmpHome);
    await chat.goto(WS);
    await chat.waitForReady();
    await chat.promptInput.fill("hello\nworld\nmulti\nline");
    await expect
      .poll(async () => (await chat.sendColors()).icon)
      .toBe((await chat.sendColors()).foreground);
    await chat.submitButton.hover();
    await expect
      .poll(async () => (await chat.sendColors()).icon)
      .toBe((await chat.sendColors()).foreground);
    const r = await chat.composerRow();
    expect(r.textarea!.height).toBeGreaterThan(40);
    await page.screenshot({ path: test.info().outputPath(`composer-${scheme}.png`) });
  });
}

for (const scheme of ["light", "dark"] as const) {
  test(`${scheme}: during a running turn, Send with typed text stays the foreground color`, async ({
    page,
  }) => {
    await start(false);
    await page.emulateMedia({ colorScheme: scheme });
    const chat = new ChatPanePage(page, server.url, TOKEN);
    await chat.goto(WS);
    await chat.waitForReady();
    await chat.typeMessage("start a long task");
    await chat.submit();
    await expect(chat.assistantMessage("working")).toBeVisible();
    await chat.typeMessage("and then this");
    await expect(chat.submitButton).toBeEnabled();
    await expect
      .poll(async () => {
        const c = await chat.sendColors();
        return c.icon === c.foreground;
      })
      .toBe(true);
    await chat.submitButton.hover();
    await expect
      .poll(async () => {
        const c = await chat.sendColors();
        return c.icon === c.foreground;
      })
      .toBe(true);
  });
}

test("phone: while recording, Send hides and the textarea keeps its width", async ({ page }) => {
  await start(true);
  await page.setViewportSize({ width: 390, height: 844 });
  const chat = new ChatPanePage(page, server.url, TOKEN);
  await chat.goto(WS);
  await chat.waitForReady();
  await chat.typeMessage("draft");
  const before = await chat.composerRow();
  await chat.tapMic();
  await expect(chat.micListening).toBeVisible();
  await expect(chat.submitButton).toHaveCount(0);
  const during = await chat.composerRow();
  expect(during.textarea!.width).toBe(before.textarea!.width);
  expect(during.mic!.x).toBe(before.mic!.x);
  await chat.tapMic();
  await expect(chat.micListening).toHaveCount(0);
});
