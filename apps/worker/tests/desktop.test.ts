import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { call, cleanup, startHub, startWorker, tmpDir } from "./helpers.ts";

// The worker reports the desktop capability from DISPLAY and an x11vnc on PATH, both read when it starts.
// `desktop.open` bridges a link channel to the VNC port on loopback.

function setEnv(values: Record<string, string | undefined>): () => void {
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

describe("a worker without a display", () => {
  let restore: () => void;
  let hub: Awaited<ReturnType<typeof startHub>>;
  let w: Awaited<ReturnType<typeof startWorker>>;

  before(async () => {
    restore = setEnv({ DISPLAY: undefined });
    hub = await startHub();
    w = await startWorker(hub);
  });
  after(async () => {
    await w.worker.stop();
    await hub.close();
    cleanup(w.root, w.stateDir);
    restore();
  });

  it("does not report the desktop capability", () => {
    assert.ok(w.session.hello.capabilities.includes("pty"));
    assert.ok(!w.session.hello.capabilities.includes("desktop"));
  });

  it("fails desktop.open with a message that names the missing display", async () => {
    await assert.rejects(call(w.session, "desktop.open"), /no desktop.*DISPLAY is not set/s);
  });
});

describe("a worker with a display but no x11vnc", () => {
  let restore: () => void;
  let hub: Awaited<ReturnType<typeof startHub>>;
  let w: Awaited<ReturnType<typeof startWorker>>;
  let emptyBin: string;

  before(async () => {
    emptyBin = tmpDir("band-worker-nobin-");
    // The system directories prepended to PATH hold no x11vnc on a CI runner or a developer machine without one.
    restore = setEnv({ DISPLAY: ":99", PATH: emptyBin });
    hub = await startHub();
    w = await startWorker(hub);
  });
  after(async () => {
    await w.worker.stop();
    await hub.close();
    cleanup(w.root, w.stateDir, emptyBin);
    restore();
  });

  it("does not report the desktop capability, and desktop.open says x11vnc is missing", async (t) => {
    if (w.session.hello.capabilities.includes("desktop")) {
      t.skip("this machine has an x11vnc in a system directory");
      return;
    }
    await assert.rejects(call(w.session, "desktop.open"), /x11vnc is not installed/);
  });
});

describe("a worker with a display and x11vnc", () => {
  let restore: () => void;
  let hub: Awaited<ReturnType<typeof startHub>>;
  let w: Awaited<ReturnType<typeof startWorker>>;
  let rfb: Server;
  let bin: string;
  let accepted = 0;

  before(async () => {
    // A stand-in for x11vnc: it greets like an RFB server and echoes what it is sent.
    rfb = createServer((socket) => {
      accepted++;
      socket.write("RFB 003.008\n");
      socket.on("data", (d) => socket.write(Buffer.concat([Buffer.from("echo:"), d])));
      socket.on("error", () => undefined);
    });
    await new Promise<void>((resolve) => rfb.listen(0, "127.0.0.1", resolve));
    const port = (rfb.address() as { port: number }).port;
    bin = tmpDir("band-worker-x11vnc-");
    const stub = join(bin, "x11vnc");
    writeFileSync(stub, "#!/bin/sh\nexit 0\n");
    chmodSync(stub, 0o755);
    restore = setEnv({
      DISPLAY: ":99",
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      BAND_DESKTOP_VNC_PORT: String(port),
    });
    hub = await startHub();
    w = await startWorker(hub);
  });
  after(async () => {
    await w.worker.stop();
    await hub.close();
    await new Promise<void>((resolve) => rfb.close(() => resolve()));
    cleanup(w.root, w.stateDir, bin);
    restore();
  });

  it("reports the desktop capability", () => {
    assert.ok(w.session.hello.capabilities.includes("desktop"));
  });

  it("bridges a channel to the VNC port in both directions", async () => {
    const res = (await w.session.request("desktop.open", {})) as { chan: number };
    const ch = w.session.getChannel(res.chan);
    assert.ok(ch, "the channel opens before the reply arrives");
    const it = ch[Symbol.asyncIterator]();
    const first = await it.next();
    assert.equal(Buffer.from(first.value as Uint8Array).toString(), "RFB 003.008\n");
    await ch.send(Buffer.from("hello"));
    const echo = await it.next();
    assert.equal(Buffer.from(echo.value as Uint8Array).toString(), "echo:hello");
    ch.end();
    assert.equal(accepted, 1);
  });

  it("fails with the connect error when x11vnc is not listening", async () => {
    const restorePort = setEnv({ BAND_DESKTOP_VNC_PORT: "1" });
    try {
      await assert.rejects(
        call(w.session, "desktop.open"),
        /cannot reach x11vnc on 127\.0\.0\.1:1/,
      );
    } finally {
      restorePort();
    }
  });
});
