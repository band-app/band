import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import {
  TerminalClient,
  type TerminalDims,
  type TerminalSink,
  type TerminalSocket,
  terminalSocketUrl,
} from "../src/terminal-client.ts";

class FakeSocket implements TerminalSocket {
  readyState = 0;
  binaryType = "";
  onopen: TerminalSocket["onopen"] = null;
  onmessage: TerminalSocket["onmessage"] = null;
  onclose: TerminalSocket["onclose"] = null;
  sent: string[] = [];
  url: string;
  protocols: string[];
  constructor(url: string, protocols: string[]) {
    this.url = url;
    this.protocols = protocols;
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  frame(data: string | Uint8Array) {
    this.onmessage?.({ data: typeof data === "string" ? data : data.slice().buffer });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  json() {
    return this.sent.filter((s) => s.startsWith("{")).map((s) => JSON.parse(s));
  }
}

function setup(dims: TerminalDims | null = { cols: 80, rows: 24 }) {
  const sockets: FakeSocket[] = [];
  const log: string[] = [];
  const parsedCallbacks: (() => void)[] = [];
  let current = dims;
  const sink: TerminalSink = {
    write: (bytes, parsed) => {
      log.push(`write:${new TextDecoder().decode(bytes)}`);
      parsedCallbacks.push(parsed);
    },
    reset: () => log.push("reset"),
    notice: (t) => log.push(`notice:${t}`),
    ended: (reason) => log.push(`ended:${reason}`),
    title: (t) => log.push(`title:${t}`),
  };
  const client = new TerminalClient({
    hubUrl: "http://hub.test:3456",
    token: "bdt_abc",
    worktreeId: "repo-main",
    terminalId: "t1",
    sink,
    getDims: () => current,
    createSocket: (url, protocols) => {
      const s = new FakeSocket(url, protocols);
      sockets.push(s);
      return s;
    },
  });
  return {
    client,
    sockets,
    log,
    parsedCallbacks,
    setDims: (d: TerminalDims | null) => {
      current = d;
    },
  };
}

const enc = (s: string) => new TextEncoder().encode(s);

describe("TerminalClient", () => {
  beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] }));
  afterEach(() => mock.timers.reset());

  it("connects with the token subprotocol and asks for the replay with its size", () => {
    const { client, sockets } = setup();
    client.connect();
    const [sock] = sockets;
    assert.equal(sock.url, "ws://hub.test:3456/terminal?worktreeId=repo-main&terminalId=t1");
    assert.deepEqual(sock.protocols, ["band", "band-token.bdt_abc"]);
    sock.open();
    assert.deepEqual(sock.json(), [{ type: "attach", cols: 80, rows: 24, flow: true }]);
    assert.equal(
      terminalSocketUrl("https://h", "a b", "c"),
      "wss://h/terminal?worktreeId=a%20b&terminalId=c",
    );
  });

  it("waits for a size before it attaches", () => {
    const { client, sockets, setDims } = setup(null);
    client.connect();
    sockets[0].open();
    assert.deepEqual(sockets[0].json(), []);
    setDims({ cols: 100, rows: 30 });
    client.resize({ cols: 100, rows: 30 });
    assert.deepEqual(sockets[0].json(), [{ type: "attach", cols: 100, rows: 30, flow: true }]);
  });

  it("acknowledges output once the screen has parsed it, batched", async () => {
    const { client, sockets, parsedCallbacks, log } = setup();
    client.connect();
    const sock = sockets[0];
    sock.open();
    sock.frame(JSON.stringify({ type: "attached" }));
    sock.frame(enc("hello"));
    sock.frame(enc("world"));
    assert.deepEqual(log, ["write:hello", "write:world"]);
    assert.equal(sock.json().filter((m) => m.type === "ack").length, 0);
    for (const cb of parsedCallbacks) cb();
    await Promise.resolve();
    assert.deepEqual(
      sock.json().filter((m) => m.type === "ack"),
      [{ type: "ack", bytes: 10 }],
    );
  });

  it("acknowledges at once while hidden so it never holds the PTY", async () => {
    const { client, sockets } = setup();
    client.connect();
    sockets[0].open();
    client.setVisible(false);
    sockets[0].frame(enc("abc"));
    await Promise.resolve();
    assert.deepEqual(
      sockets[0].json().filter((m) => m.type === "ack"),
      [{ type: "ack", bytes: 3 }],
    );
  });

  it("sends resizes only after the replay and only when the size changed", () => {
    const { client, sockets } = setup();
    client.connect();
    const sock = sockets[0];
    sock.open();
    client.resize({ cols: 90, rows: 20 });
    assert.equal(
      sock.json().filter((m) => m.type === "resize").length,
      0,
      "held during the replay",
    );
    sock.frame(JSON.stringify({ type: "attached" }));
    // The size now differs from the attach: the client sends it when the replay lands.
    client.resize({ cols: 90, rows: 20 });
    client.resize({ cols: 90, rows: 20 });
    assert.deepEqual(
      sock.json().filter((m) => m.type === "resize"),
      [{ type: "resize", cols: 90, rows: 20 }],
    );
  });

  it("sends keystrokes as plain text frames", () => {
    const { client, sockets } = setup();
    assert.equal(client.send("x"), false);
    client.connect();
    sockets[0].open();
    assert.equal(client.send("ls\r"), true);
    assert.equal(sockets[0].sent.at(-1), "ls\r");
  });

  it("reconnects after a dropped socket, resets the screen and replays", () => {
    const { client, sockets, log } = setup();
    client.connect();
    sockets[0].open();
    sockets[0].frame(enc("before"));
    sockets[0].drop(1006);
    mock.timers.tick(500);
    assert.equal(sockets.length, 2);
    sockets[1].open();
    assert.ok(log.includes("reset"));
    assert.deepEqual(sockets[1].json(), [{ type: "attach", cols: 80, rows: 24, flow: true }]);
    // The snapshot is the whole screen again: nothing from before is written twice.
    sockets[1].frame(enc("snapshot"));
    assert.deepEqual(
      log.filter((l) => l === "reset" || l.startsWith("write:")),
      ["write:before", "reset", "write:snapshot"],
    );
  });

  it("backs off between failed attempts", () => {
    const { client, sockets } = setup();
    client.connect();
    sockets[0].drop(1006);
    mock.timers.tick(499);
    assert.equal(sockets.length, 1);
    mock.timers.tick(1);
    assert.equal(sockets.length, 2);
    sockets[1].drop(1006);
    mock.timers.tick(999);
    assert.equal(sockets.length, 2);
    mock.timers.tick(1);
    assert.equal(sockets.length, 3);
  });

  it("does not reconnect after the shell exits or the hub refuses the terminal", () => {
    const a = setup();
    a.client.connect();
    a.sockets[0].open();
    a.sockets[0].drop(1000);
    mock.timers.tick(60_000);
    assert.equal(a.sockets.length, 1);
    assert.ok(a.log.includes("ended:exited"));
    a.client.resume();
    assert.equal(a.sockets.length, 1);

    const b = setup();
    b.client.connect();
    b.sockets[0].drop(4001);
    mock.timers.tick(60_000);
    assert.equal(b.sockets.length, 1);
    assert.ok(b.log.includes("ended:failed"));
  });

  it("dials again at once on resume when the socket died while the app slept", () => {
    const { client, sockets } = setup();
    client.connect();
    sockets[0].open();
    sockets[0].readyState = 3;
    client.resume();
    assert.equal(sockets.length, 2);
  });

  it("drops a socket that stops answering pings", () => {
    const { client, sockets } = setup();
    client.connect();
    sockets[0].open();
    mock.timers.tick(10_000);
    assert.equal(sockets[0].json().filter((m) => m.type === "ping").length, 1);
    mock.timers.tick(10_000);
    mock.timers.tick(10_000);
    assert.equal(sockets[0].readyState, 3);
    mock.timers.tick(500);
    assert.equal(sockets.length, 2);
  });

  it("keeps the socket while pongs arrive", () => {
    const { client, sockets } = setup();
    client.connect();
    sockets[0].open();
    for (let i = 0; i < 5; i++) {
      mock.timers.tick(10_000);
      sockets[0].frame(JSON.stringify({ type: "pong" }));
    }
    assert.equal(sockets[0].readyState, 1);
    assert.equal(sockets.length, 1);
  });

  it("strips control bytes from hub errors and forwards the title", () => {
    const { client, sockets, log } = setup();
    client.connect();
    sockets[0].open();
    sockets[0].frame(JSON.stringify({ type: "error", message: "bad\u001b[2Jthing" }));
    sockets[0].frame(JSON.stringify({ type: "title", title: "vim" }));
    assert.deepEqual(log, ["notice:bad[2Jthing", "title:vim"]);
  });

  it("kill asks the hub to close the shell", () => {
    const { client, sockets } = setup();
    client.connect();
    sockets[0].open();
    client.kill();
    assert.deepEqual(sockets[0].json().at(-1), { type: "close" });
  });
});
