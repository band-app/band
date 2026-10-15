/**
 * Voice dictation (docs/voice-dictation.md): Settings > Voice and the composer's mic.
 *
 * Real hub, temp BAND_HOME, and a real OpenAI-compatible stub server that checks the multipart
 * fields and the Bearer key (`apps/hub/tests/fixtures/stt-stub.ts`). Chromium records a fake
 * microphone (`--use-fake-device-for-media-stream`, permission prompt auto-accepted), so the
 * clip is real webm audio that goes through the hub. `apps/hub/tests/voice.test.ts` covers the
 * hub's call path, the worker host and the access rules.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import { type SttStub, startSttStub } from "../../hub/tests/fixtures/stt-stub";
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
import { trpcMutate } from "./helpers/trpc";
import { ChatPanePage } from "./pages/ChatPanePage";
import { SettingsPage } from "./pages/SettingsPage";

const TOKEN = "e2e-voice-token";
const KEY = "sk-e2e-voice-secret-key-123456";
const WS = toWorktreeId("voicerepo", "main", "local");

test.use({
  viewport: { width: 1280, height: 800 },
  launchOptions: {
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  },
});
test.describe.configure({ mode: "serial" });

let server: ServerHandle;
let tmpHome: string;
let stub: SttStub;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repoDir = join(tmpHome, "voicerepo");
  mkdirSync(repoDir, { recursive: true });
  seedState(tmpHome, {
    repos: [
      {
        name: "voicerepo",
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
  stub = await startSttStub({ key: KEY, text: "login bug" });
  server = await startServer({ tmpHome, env: acpStubEnv(tmpHome, { turns: [{ steps: [] }] }) });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  await stub.close();
  cleanupTmpHome(tmpHome);
});

test("the composer has no mic until voice is set up", async ({ page }) => {
  const chat = new ChatPanePage(page, server.url, TOKEN);
  await chat.goto(WS);
  await chat.waitForReady();
  await expect(chat.promptInput).toBeVisible();
  await expect(chat.mic).toHaveCount(0);
});

test("Settings > Voice tests the connection and reports a wrong key without showing it", async ({
  page,
}) => {
  await trpcMutate(server.url, TOKEN, "vault.put", {
    name: "stt-key",
    kind: "api_key",
    value: KEY,
  });
  await trpcMutate(server.url, TOKEN, "vault.put", {
    name: "stt-wrong",
    kind: "api_key",
    value: "sk-e2e-wrong-key-abcdef",
  });
  const settings = new SettingsPage(page, server.url, TOKEN);
  await settings.goto();
  await settings.openDialog("voice");

  await settings.fillVoice({
    baseUrl: stub.baseUrl,
    model: "whisper-1",
    apiKey: "stt-wrong",
    enabled: true,
  });
  await settings.testVoice();
  await expect(settings.voiceError).toContainText("refused the API key");
  await expect(settings.dialog).not.toContainText("sk-e2e-wrong-key-abcdef");

  await settings.fillVoice({ baseUrl: stub.baseUrl, model: "whisper-1", apiKey: "stt-key" });
  await settings.testVoice();
  await expect(settings.voiceOk).toBeVisible();
  await expect(settings.voiceError).toHaveCount(0);
  await expect(settings.dialog).not.toContainText(KEY);

  await settings.fillVoice({ baseUrl: "http://127.0.0.1:1/v1", model: "whisper-1" });
  await settings.testVoice();
  await expect(settings.voiceError).toContainText("Could not reach");

  await settings.fillVoice({ baseUrl: stub.baseUrl, model: "whisper-1", language: "en" });
  await settings.saveVoice();
  await expect(settings.dialog.getByTestId("settings__voice-save")).toBeDisabled();
  await expect(settings.voiceError).toHaveCount(0);
  // The save is done once the hub reports voice as available.
  await expect
    .poll(async () => {
      const res = await fetch(`${server.url}/trpc/voice.status`, {
        headers: { Cookie: `band_token=${TOKEN}` },
      });
      return ((await res.json()) as { result: { data: { available: boolean } } }).result.data
        .available;
    })
    .toBe(true);
});

test("dictation inserts the text at the cursor and sends nothing", async ({ page }) => {
  stub.requests.length = 0;
  const chat = new ChatPanePage(page, server.url, TOKEN);
  await chat.goto(WS);
  await chat.waitForReady();

  await chat.typeMessage("Fix the ");
  await chat.placeCaretAtEnd();
  await chat.tapMic();
  await expect(chat.micListening).toBeVisible();
  await expect(chat.micTimer).toBeVisible();
  // The timer counts while the mic records.
  await expect(chat.micTimer).not.toHaveText("0:00");
  await chat.tapMic();

  await expect(chat.promptInput).toHaveValue("Fix the login bug");
  await expect(chat.micListening).toHaveCount(0);
  expect(stub.requests).toHaveLength(1);
  expect(stub.requests[0]).toMatchObject({
    auth: `Bearer ${KEY}`,
    model: "whisper-1",
    responseFormat: "json",
    language: "en",
    fileName: "audio.webm",
  });
  expect(stub.requests[0]?.fileSize).toBeGreaterThan(0);
  // Nothing was sent: no message in the conversation, and the text stays editable.
  await expect(chat.emptyConversation).toBeVisible();
  await chat.typeMessage("Fix the login bug now");
  await expect(chat.promptInput).toHaveValue("Fix the login bug now");
});

test("dictation lands in the middle of a draft, at the caret", async ({ page }) => {
  const chat = new ChatPanePage(page, server.url, TOKEN);
  await chat.goto(WS);
  await chat.waitForReady();

  await chat.typeMessage("Fix the .");
  await chat.promptInput.focus();
  await chat.promptInput.evaluate((el: HTMLTextAreaElement) => {
    el.setSelectionRange(8, 8);
  });
  await chat.tapMic();
  await expect(chat.micListening).toBeVisible();
  await chat.tapMic();
  await expect(chat.promptInput).toHaveValue("Fix the login bug.");
});

test("cancelling a recording inserts nothing and sends no audio", async ({ page }) => {
  stub.requests.length = 0;
  const chat = new ChatPanePage(page, server.url, TOKEN);
  await chat.goto(WS);
  await chat.waitForReady();

  await chat.typeMessage("Draft");
  await chat.tapMic();
  await expect(chat.micListening).toBeVisible();
  await chat.cancelDictation();
  await expect(chat.micListening).toHaveCount(0);
  await expect(chat.promptInput).toHaveValue("Draft");
  expect(stub.requests).toHaveLength(0);
});

test.describe("a denied microphone", () => {
  test("explains how to allow it", async ({ page }) => {
    // The browser answers the first getUserMedia call with a refusal, as Chrome does after
    // "Block" and Safari after "Don't allow".
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () =>
        Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
    });
    const chat = new ChatPanePage(page, server.url, TOKEN);
    await chat.goto(WS);
    await chat.waitForReady();
    await chat.tapMic();
    await expect(chat.micError).toContainText("Microphone access is blocked");
    await expect(chat.micError).toContainText("Allow the microphone");
    await expect(chat.micListening).toHaveCount(0);
  });
});
