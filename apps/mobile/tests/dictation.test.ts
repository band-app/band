import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import {
  Dictation,
  type DictationState,
  MIC_DENIED_MESSAGE,
  mimeTypeForUri,
  type RecorderPort,
  uploadClip,
} from "../src/lib/composer/dictation.ts";

/** A recorder that records the calls the controller makes, standing in for `expo-audio`. */
function fakeRecorder(opts: { granted?: boolean; uri?: string | null } = {}) {
  const calls: string[] = [];
  const port: RecorderPort = {
    requestPermission: async () => {
      calls.push("permission");
      return { granted: opts.granted ?? true };
    },
    start: async () => {
      calls.push("start");
    },
    stop: async () => {
      calls.push("stop");
      return opts.uri === null ? null : { uri: opts.uri ?? "file:///tmp/clip.m4a" };
    },
    cancel: async () => {
      calls.push("cancel");
    },
  };
  return { port, calls };
}

describe("Dictation", () => {
  it("asks for permission on the first start, records, and returns the text on stop", async () => {
    const { port, calls } = fakeRecorder();
    const uploaded: string[] = [];
    const states: DictationState[] = [];
    const d = new Dictation(
      port,
      async (uri) => {
        uploaded.push(uri);
        return "  login bug ";
      },
      (s) => states.push(s),
    );
    await d.start();
    assert.equal(d.state.phase, "recording");
    assert.deepEqual(calls, ["permission", "start"]);
    assert.equal(await d.stop(), "login bug");
    assert.deepEqual(uploaded, ["file:///tmp/clip.m4a"]);
    assert.deepEqual(
      states.map((s) => s.phase),
      ["starting", "recording", "transcribing", "idle"],
    );
    assert.equal(d.state.error, null);
  });

  it("explains a denied microphone and records nothing", async () => {
    const { port, calls } = fakeRecorder({ granted: false });
    const d = new Dictation(port, async () => "never");
    await d.start();
    assert.deepEqual(d.state, { phase: "idle", error: MIC_DENIED_MESSAGE });
    assert.deepEqual(calls, ["permission"]);
    assert.match(MIC_DENIED_MESSAGE, /Settings/);
  });

  it("cancel discards the audio and uploads nothing", async () => {
    const { port, calls } = fakeRecorder();
    let uploads = 0;
    const d = new Dictation(port, async () => {
      uploads++;
      return "x";
    });
    await d.start();
    await d.cancel();
    assert.equal(d.state.phase, "idle");
    assert.equal(uploads, 0);
    assert.equal(calls.at(-1), "cancel");
    // A stop after the cancel does nothing.
    assert.equal(await d.stop(), "");
    assert.equal(uploads, 0);
  });

  it("reports an upload failure and an empty result, and can record again", async () => {
    const { port } = fakeRecorder();
    let answer: () => Promise<string> = async () => {
      throw new Error("The speech-to-text server refused the API key.");
    };
    const d = new Dictation(port, () => answer());
    await d.start();
    assert.equal(await d.stop(), "");
    assert.equal(d.state.error, "The speech-to-text server refused the API key.");

    answer = async () => "   ";
    await d.start();
    assert.equal(await d.stop(), "");
    assert.match(d.state.error ?? "", /No speech was recognized/);

    answer = async () => "fixed";
    await d.start();
    assert.equal(await d.stop(), "fixed");
    assert.equal(d.state.error, null);
  });

  it("ignores a second tap while it is starting or transcribing", async () => {
    const { port, calls } = fakeRecorder();
    const d = new Dictation(port, async () => "x");
    const first = d.start();
    await d.start();
    await first;
    assert.equal(calls.filter((c) => c === "start").length, 1);
  });

  it("says so when the recorder produced no file", async () => {
    const { port } = fakeRecorder({ uri: null });
    const d = new Dictation(port, async () => "x");
    await d.start();
    assert.equal(await d.stop(), "");
    assert.equal(d.state.error, "Nothing was recorded.");
  });
});

describe("mimeTypeForUri", () => {
  it("names the container from the extension", () => {
    assert.equal(mimeTypeForUri("file:///a/b.m4a"), "audio/mp4");
    assert.equal(mimeTypeForUri("file:///a/b.WAV"), "audio/wav");
    assert.equal(mimeTypeForUri("file:///a/b.webm?x=1"), "audio/webm");
    assert.equal(mimeTypeForUri("file:///a/b"), "audio/mp4");
  });
});

describe("uploadClip", () => {
  let server: Server;
  let url: string;
  const seen: { auth?: string; type?: string; body: Buffer; path?: string }[] = [];
  let reply: { status: number; body: unknown } = {
    status: 200,
    body: { text: "Fix the login bug" },
  };

  before(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen.push({
          auth: req.headers.authorization,
          type: req.headers["content-type"],
          body: Buffer.concat(chunks),
          path: req.url,
        });
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  const clip = (bytes: string) => async () => new Blob([bytes]);

  it("posts the raw clip to the hub with the Bearer token and the clip's type", async () => {
    seen.length = 0;
    const text = await uploadClip({
      hubUrl: url,
      token: "bdt_secret",
      uri: "file:///var/clip.m4a",
      readClip: clip("m4a-bytes"),
    });
    assert.equal(text, "Fix the login bug");
    assert.equal(seen[0]?.path, "/api/voice/transcribe");
    assert.equal(seen[0]?.auth, "Bearer bdt_secret");
    assert.equal(seen[0]?.type, "audio/mp4");
    assert.equal(seen[0]?.body.toString(), "m4a-bytes");
  });

  it("surfaces the hub's message when voice is not set up or the provider fails", async () => {
    reply = {
      status: 409,
      body: { error: { code: "not_configured", message: "Voice dictation is off." } },
    };
    await assert.rejects(
      uploadClip({ hubUrl: url, token: "t", uri: "file:///c.m4a", readClip: clip("x") }),
      /Voice dictation is off\./,
    );
    reply = { status: 200, body: { text: "ok" } };
  });

  it("refuses an empty or oversized clip before sending", async () => {
    seen.length = 0;
    await assert.rejects(
      uploadClip({ hubUrl: url, token: "t", uri: "file:///c.m4a", readClip: clip("") }),
      /empty/,
    );
    const big = async () => ({ size: 26 * 1024 * 1024 }) as Blob;
    await assert.rejects(
      uploadClip({ hubUrl: url, token: "t", uri: "file:///c.m4a", readClip: big }),
      /over 25 MB/,
    );
    assert.equal(seen.length, 0);
  });

  it("names an unreachable hub", async () => {
    await assert.rejects(
      uploadClip({
        hubUrl: "http://127.0.0.1:1",
        token: "t",
        uri: "file:///c.m4a",
        readClip: clip("x"),
      }),
      /Could not reach the hub/,
    );
  });
});
