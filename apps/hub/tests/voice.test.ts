// Voice dictation: audio goes to the hub, which calls an OpenAI-compatible speech-to-text
// endpoint itself, or has a worker call it when the endpoint is set to run on a host. The key
// stays in the vault. The stub server checks the multipart fields and the Bearer header.

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentWav } from "@band-app/shared/speech-transcription";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type SttStub, startSttStub } from "./fixtures/stt-stub";
import { seedSettings } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";
import { removeTmpHome } from "./helpers/tmp-home";
import { waitFor } from "./helpers/wait-for";

const TOKEN = "voice-test-token";
const KEY = "sk-stub-secret-key-0123456789";

import { WORKER_BIN } from "./helpers/worker-bin";

const AUDIO = Buffer.from("fake webm audio bytes");
const M4A = readFileSync(join(import.meta.dirname, "fixtures/dictation.m4a"));

let home: string;
let server: ServerHandle;
let stub: SttStub;
let keyItemId = "";
let worker: ChildProcess | null = null;
let hostId = "";
const scratch: string[] = [];

const m = async <T>(procedure: string, input: unknown): Promise<T> => {
  const res = await trpcMutate(server.url, procedure, input, TOKEN);
  if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
  return trpcData<T>(res);
};

const setVoice = (voice: Record<string, unknown>) =>
  m("settings.update", {
    voice: {
      enabled: true,
      baseUrl: stub.baseUrl,
      model: "whisper-1",
      apiKeyItemId: keyItemId,
      ...voice,
    },
  });

interface Answer {
  status: number;
  body: { text?: string; error?: { code: string; message: string } };
}

async function transcribe(
  opts: {
    body?: Uint8Array;
    mime?: string;
    headers?: Record<string, string>;
    auth?: "cookie" | "none" | string;
  } = {},
): Promise<Answer> {
  const auth = opts.auth ?? "cookie";
  const headers: Record<string, string> = {
    "Content-Type": opts.mime ?? "audio/webm;codecs=opus",
    ...(auth === "cookie"
      ? { Cookie: `band_token=${TOKEN}` }
      : auth === "none"
        ? {}
        : { Authorization: `Bearer ${auth}` }),
    ...opts.headers,
  };
  const res = await fetch(`${server.url}/api/voice/transcribe`, {
    method: "POST",
    headers,
    body: opts.body ?? AUDIO,
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Answer["body"] };
}

async function startWorker(): Promise<void> {
  const issued = await m<{ token: string; hostId: string }>("tokens.issueWorkerBootstrap", {
    hostName: "voice-box",
  });
  hostId = issued.hostId;
  const dir = (p: string) => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), p)));
    scratch.push(d);
    return d;
  };
  const workerHome = dir("band-voice-worker-home-");
  worker = spawn(
    process.execPath,
    [
      WORKER_BIN,
      "--hub",
      server.url,
      "--token",
      issued.token,
      "--worker-id",
      hostId,
      "--root",
      dir("band-voice-root-"),
      "--state-dir",
      dir("band-voice-state-"),
    ],
    {
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("BAND_"))),
        HOME: workerHome,
        BAND_HOME: join(workerHome, ".band"),
      },
      stdio: ["ignore", "ignore", "ignore"],
    },
  );
}

const hostStatus = async () => {
  const res = await trpcQuery(server.url, "hosts.list", undefined, TOKEN);
  const { hosts } = await trpcData<{ hosts: Array<{ id: string; status: string }> }>(res);
  return hosts.find((h) => h.id === hostId)?.status;
};

beforeAll(async () => {
  home = createTmpHome("band-voice-");
  seedSettings(home, { tokenSecret: TOKEN });
  stub = await startSttStub({ key: KEY });
  server = await startServer({ tmpHome: home, remoteHost: false });
  const put = await m<{ item: { id: string } }>("vault.put", {
    name: "stt-key",
    kind: "api_key",
    value: KEY,
  });
  keyItemId = put.item.id;
}, 120_000);

afterAll(async () => {
  worker?.kill("SIGKILL");
  await server?.close();
  await stub?.close();
  removeTmpHome(home);
  for (const d of scratch) removeTmpHome(d);
});

describe("voice settings and test connection", () => {
  it("reports the mic unavailable until voice is set up (S6, hub side)", async () => {
    const res = await trpcQuery(server.url, "voice.status", undefined, TOKEN);
    const status = await trpcData<{ available: boolean; reason?: string }>(res);
    expect(status.available).toBe(false);
    expect(status.reason).toMatch(/Settings > Voice/);
    const answer = await transcribe();
    expect(answer.status).toBe(409);
    expect(answer.body.error?.code).toBe("not_configured");
    expect(stub.requests).toHaveLength(0);
  });

  it("tests a working endpoint and sends the silent clip as a wav (S1)", async () => {
    stub.requests.length = 0;
    const result = await m<{ ok: boolean }>("voice.test", {
      baseUrl: stub.baseUrl,
      model: "whisper-1",
      apiKeyItemId: keyItemId,
    });
    expect(result.ok).toBe(true);
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]).toMatchObject({
      path: "/v1/audio/transcriptions",
      auth: `Bearer ${KEY}`,
      model: "whisper-1",
      responseFormat: "json",
      fileName: "audio.wav",
      fileType: "audio/wav",
      fileSize: silentWav(1).byteLength,
    });
  });

  it("reports a wrong key without repeating either key (S1)", async () => {
    const wrong = await m<{ item: { id: string } }>("vault.put", {
      name: "wrong-key",
      kind: "api_key",
      value: "sk-wrong-key-abcdefghij",
    });
    const res = await trpcMutate(
      server.url,
      "voice.test",
      { baseUrl: stub.baseUrl, model: "whisper-1", apiKeyItemId: wrong.item.id },
      TOKEN,
    );
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toMatch(/refused the API key/);
    expect(text).not.toContain("sk-wrong-key-abcdefghij");
    expect(text).not.toContain(KEY);
  });

  it("scrubs the key from a provider error body (S1)", async () => {
    const res = await trpcMutate(
      server.url,
      "voice.test",
      { baseUrl: stub.baseUrl, model: "missing-model", apiKeyItemId: keyItemId },
      TOKEN,
    );
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toMatch(/404/);
    expect(text).not.toContain(KEY);
  });

  it("reports an unreachable URL as a clear error (S1)", async () => {
    const res = await trpcMutate(
      server.url,
      "voice.test",
      { baseUrl: "http://127.0.0.1:1/v1", model: "whisper-1", apiKeyItemId: keyItemId },
      TOKEN,
    );
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toMatch(/Could not reach 127\.0\.0\.1:1/);
    expect(text).not.toContain(KEY);
  });

  it("never returns the key from any voice or settings procedure (S1)", async () => {
    await setVoice({ language: "en" });
    const config = await trpcQuery(server.url, "voice.config", undefined, TOKEN);
    const settings = await trpcQuery(server.url, "settings.get", undefined, TOKEN);
    const status = await trpcQuery(server.url, "voice.status", undefined, TOKEN);
    for (const res of [config, settings, status]) expect(await res.text()).not.toContain(KEY);
    const body = await trpcData<{ apiKeyItemId: string; baseUrl: string }>(
      await trpcQuery(server.url, "voice.config", undefined, TOKEN),
    );
    expect(body.apiKeyItemId).toBe(keyItemId);
    expect(body.baseUrl).toBe(stub.baseUrl);
  });
});

describe("the hub transcribes a clip", () => {
  beforeAll(() => setVoice({ language: "en", hostId: "" }));

  it("posts multipart with the Bearer key and returns the text (S2)", async () => {
    stub.requests.length = 0;
    const answer = await transcribe();
    expect(answer).toEqual({ status: 200, body: { text: "Fix the login bug" } });
    expect(stub.requests).toEqual([
      {
        path: "/v1/audio/transcriptions",
        auth: `Bearer ${KEY}`,
        model: "whisper-1",
        responseFormat: "json",
        language: "en",
        fileName: "audio.webm",
        fileType: "audio/webm",
        fileSize: AUDIO.byteLength,
      },
    ]);
  });

  it("names an mp4 clip .m4a, because providers check the extension (S2)", async () => {
    stub.requests.length = 0;
    const answer = await transcribe({ mime: "audio/mp4" });
    expect(answer.status).toBe(200);
    expect(stub.requests[0]).toMatchObject({ fileName: "audio.m4a", fileType: "audio/mp4" });
  });

  it("names an M4A clip from its bytes when the type is missing or wrong (S1)", async () => {
    for (const mime of ["application/octet-stream", "audio/webm;codecs=opus"]) {
      stub.requests.length = 0;
      const answer = await transcribe({ body: M4A, mime });
      expect(answer).toEqual({ status: 200, body: { text: "Fix the login bug" } });
      expect(stub.requests[0]).toMatchObject({
        fileName: "audio.m4a",
        fileType: "audio/mp4",
        fileSize: M4A.byteLength,
      });
    }
  });

  it("refuses a clip over 25 MB and an empty one", async () => {
    stub.requests.length = 0;
    const big = await transcribe({ body: new Uint8Array(26 * 1024 * 1024) });
    expect(big.status).toBe(413);
    const empty = await transcribe({ body: new Uint8Array(0) });
    expect(empty.status).toBe(502);
    expect(stub.requests).toHaveLength(0);
  });

  it("maps a provider 401 to a message without the key", async () => {
    const other = await m<{ item: { id: string } }>("vault.put", {
      name: "other-key",
      kind: "api_key",
      value: "sk-other-key-zzzzzzzzzz",
    });
    await setVoice({ apiKeyItemId: other.item.id });
    const answer = await transcribe();
    expect(answer.status).toBe(502);
    expect(answer.body.error?.code).toBe("unauthorized");
    expect(JSON.stringify(answer)).not.toContain("sk-other-key-zzzzzzzzzz");
    await setVoice({});
  });
});

describe("access control (S4)", () => {
  it("refuses a request with no token", async () => {
    const answer = await transcribe({ auth: "none" });
    expect(answer.status).toBe(401);
  });

  it("refuses a request that carries an agent's chat or worktree header", async () => {
    stub.requests.length = 0;
    expect((await transcribe({ headers: { "x-band-chat-id": "c1" } })).status).toBe(403);
    expect((await transcribe({ headers: { "x-band-worktree-id": "w1" } })).status).toBe(403);
    expect(stub.requests).toHaveLength(0);
  });

  it("lets a plain (non-admin) device dictate but not read or change the endpoint", async () => {
    const created = await m<{ token: string }>("tokens.createDevice", { label: "phone" });
    const phone = created.token;
    expect((await transcribe({ auth: phone })).status).toBe(200);
    for (const [procedure, input] of [
      ["voice.config", undefined],
      ["voice.test", {}],
    ] as const) {
      const res = await fetch(`${server.url}/trpc/${procedure}`, {
        method: procedure === "voice.config" ? "GET" : "POST",
        headers: { Authorization: `Bearer ${phone}`, "Content-Type": "application/json" },
        ...(procedure === "voice.config" ? {} : { body: JSON.stringify(input) }),
      });
      expect(res.status, procedure).toBe(403);
    }
    const update = await fetch(`${server.url}/trpc/settings.update`, {
      method: "POST",
      headers: { Authorization: `Bearer ${phone}`, "Content-Type": "application/json" },
      body: JSON.stringify({ voice: { enabled: true, baseUrl: "http://127.0.0.1:9/v1" } }),
    });
    expect(update.status).toBe(403);
  });

  it("leaves voice out of the MCP endpoint", async () => {
    const res = await fetch(`${server.url}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(await res.text()).not.toContain("band_voice_");
  });
});

describe("running on a worker host (S3)", () => {
  beforeAll(async () => {
    await startWorker();
    await waitFor(async () => ((await hostStatus()) === "online" ? true : undefined), {
      label: "worker online",
      timeoutMs: 30_000,
    });
  }, 60_000);

  it("reaches the stub on the worker's loopback through the worker", async () => {
    await setVoice({ hostId, language: "" });
    stub.requests.length = 0;
    const answer = await transcribe();
    expect(answer).toEqual({ status: 200, body: { text: "Fix the login bug" } });
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]).toMatchObject({
      auth: `Bearer ${KEY}`,
      model: "whisper-1",
      responseFormat: "json",
      fileName: "audio.webm",
      fileSize: AUDIO.byteLength,
      language: null,
    });
  });

  it("names an M4A clip from its bytes through the worker (S2)", async () => {
    stub.requests.length = 0;
    const answer = await transcribe({ body: M4A, mime: "application/octet-stream" });
    expect(answer.status).toBe(200);
    expect(stub.requests[0]).toMatchObject({
      fileName: "audio.m4a",
      fileType: "audio/mp4",
      fileSize: M4A.byteLength,
    });
  });

  it("sends a clip over the message limit through a channel", async () => {
    stub.requests.length = 0;
    const big = new Uint8Array(2 * 1024 * 1024).fill(3);
    const answer = await transcribe({ body: big });
    expect(answer.status).toBe(200);
    expect(stub.requests[0]?.fileSize).toBe(big.byteLength);
  });

  it("tests the connection from the worker too", async () => {
    stub.requests.length = 0;
    const result = await m<{ ok: boolean; hostId: string }>("voice.test", {});
    expect(result).toEqual({ ok: true, hostId });
    expect(stub.requests).toHaveLength(1);
  });

  it("says the host is offline and sends nothing anywhere else", async () => {
    worker?.kill("SIGKILL");
    await waitFor(async () => ((await hostStatus()) !== "online" ? true : undefined), {
      label: "worker offline",
      timeoutMs: 30_000,
    });
    stub.requests.length = 0;
    const answer = await transcribe();
    expect(answer.status).toBe(503);
    expect(answer.body.error?.code).toBe("host_offline");
    expect(answer.body.error?.message).toContain(hostId);
    expect(answer.body.error?.message).toMatch(/offline/);
    // Not the hub, and not a fallback.
    expect(stub.requests).toHaveLength(0);
  }, 60_000);
});
