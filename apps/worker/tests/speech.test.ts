import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";

import { call, cleanup, startHub, startWorker, type TestHub, type TestWorker } from "./helpers.ts";

// `speech.transcribe` makes the OpenAI-compatible request from the worker's network, so the hub
// can use a server on this machine's loopback. Only the hub's link reaches it.

interface Seen {
  auth: string | undefined;
  path: string | undefined;
  model: string | null;
  responseFormat: string | null;
  language: string | null;
  fileName: string | null;
  fileType: string | null;
  fileSize: number;
}

describe("speech.transcribe on a worker", () => {
  let hub: TestHub;
  let w: TestWorker;
  let stub: Server;
  let stubUrl: string;
  const seen: Seen[] = [];

  before(async () => {
    stub = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", async () => {
        const form = await new Request("http://stub.local/", {
          method: "POST",
          headers: { "content-type": req.headers["content-type"] ?? "" },
          body: Buffer.concat(chunks),
        }).formData();
        const file = form.get("file") as File;
        seen.push({
          auth: req.headers.authorization,
          path: req.url,
          model: form.get("model") as string | null,
          responseFormat: form.get("response_format") as string | null,
          language: form.get("language") as string | null,
          fileName: file.name,
          fileType: file.type,
          fileSize: file.size,
        });
        if (req.headers.authorization !== "Bearer sk-local-secret-key") {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "bad key sk-local-secret-key" } }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ text: " hello from the worker " }));
      });
    });
    await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
    const addr = stub.address();
    stubUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/v1`;
    hub = await startHub();
    w = await startWorker(hub);
  });
  after(async () => {
    await w.worker.stop();
    await hub.close();
    await new Promise<void>((r) => stub.close(() => r()));
    cleanup(w.root, w.stateDir);
  });

  const params = (over: Record<string, unknown> = {}) => ({
    baseUrl: stubUrl,
    apiKey: "sk-local-secret-key",
    model: "whisper-1",
    mimeType: "audio/webm;codecs=opus",
    audio: { base64: Buffer.from("fake-audio").toString("base64") },
    ...over,
  });

  it("posts multipart to <baseUrl>/audio/transcriptions and returns the text", async () => {
    seen.length = 0;
    const result = await call<{ text: string }>(
      w.session,
      "speech.transcribe",
      params({ language: "en" }),
    );
    assert.equal(result.text, "hello from the worker");
    assert.deepEqual(seen[0], {
      auth: "Bearer sk-local-secret-key",
      path: "/v1/audio/transcriptions",
      model: "whisper-1",
      responseFormat: "json",
      language: "en",
      fileName: "audio.webm",
      fileType: "audio/webm",
      fileSize: "fake-audio".length,
    });
  });

  it("reads a clip that arrives on a channel", async () => {
    seen.length = 0;
    const clip = Buffer.alloc(600 * 1024, 7);
    const ch = w.session.openChannel("speech.audio", {});
    const done = call<{ text: string }>(
      w.session,
      "speech.transcribe",
      params({ audio: { chan: ch.id } }),
    );
    await ch.send(clip);
    ch.end();
    assert.equal((await done).text, "hello from the worker");
    assert.equal(seen[0]?.fileSize, clip.byteLength);
  });

  it("returns a provider failure as a coded result without the key", async () => {
    const result = await call<{ error?: { code: string; message: string } }>(
      w.session,
      "speech.transcribe",
      params({ apiKey: "sk-wrong-key-12345" }),
    );
    assert.equal(result.error?.code, "unauthorized");
    assert.ok(!JSON.stringify(result).includes("sk-wrong-key-12345"));
    assert.ok(!JSON.stringify(result).includes("sk-local-secret-key"));
  });

  it("answers unreachable when nothing listens at the URL", async () => {
    const result = await call<{ error?: { code: string } }>(
      w.session,
      "speech.transcribe",
      params({ baseUrl: "http://127.0.0.1:1/v1" }),
    );
    assert.equal(result.error?.code, "unreachable");
  });

  it("refuses a URL that is not http(s)", async () => {
    const result = await call<{ error?: { code: string } }>(
      w.session,
      "speech.transcribe",
      params({ baseUrl: "file:///etc/passwd" }),
    );
    assert.equal(result.error?.code, "not_configured");
  });

  it("is not a procedure of the direct listener", async () => {
    const reply = await call<{ port: number }>(w.session, "direct.register", {
      token: "bwd_test-token",
      scope: { worktreeId: "x", path: w.root, defaultBranch: "main" },
      ttlMs: 60_000,
    });
    const res = await fetch(`http://127.0.0.1:${reply.port}/direct/speech.transcribe`, {
      method: "POST",
      headers: { authorization: "Bearer bwd_test-token", "content-type": "application/json" },
      body: JSON.stringify(params()),
    });
    assert.equal(res.status, 404);
  });
});
