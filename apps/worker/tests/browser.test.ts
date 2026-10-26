import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { findChromium } from "@band-app/host-local/browser/chromium";
import { decodeFrames, encodeFrame, type ServerSession } from "@band-app/link";
import { call, cleanup, startHub, startWorker, type TestHub, type TestWorker } from "./helpers.ts";

const chromium = findChromium();

// RemoteHost gives browser.open 60 s (packages/host-remote/src/remote-host.ts), because a Chromium that hangs
// on its first start is killed after 20 s and started again, which can take 44 s in all. The link's default
// 30 s would end the call mid-retry and hide the browser's own error.
const OPEN_TIMEOUT_MS = 60_000;

function openBrowser(session: ServerSession, worktreeId: string) {
  return call<BrowserInfo>(session, "browser.open", { worktreeId }, { timeoutMs: OPEN_TIMEOUT_MS });
}

interface BrowserInfo {
  pid: number;
  profileDir: string;
  headless: boolean;
  port: number;
}

/** A CDP client over the worker's `browser.connect` channel, with the same framing the hub uses. */
async function connectCdp(session: ServerSession, worktreeId: string) {
  const reply = (await session.request("browser.connect", { worktreeId })) as { chan: number };
  const ch = session.getChannel(reply.chan);
  assert.ok(ch, "the channel opens before the reply arrives");
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  const events: Record<string, unknown>[] = [];
  void (async () => {
    try {
      for await (const text of decodeFrames(ch)) {
        const message = JSON.parse(text) as Record<string, unknown>;
        if (typeof message.id === "number") pending.get(message.id)?.(message);
        else events.push(message);
      }
    } catch {
      // reset
    }
  })();
  let nextId = 0;
  return {
    send(method: string, params: unknown = {}, sessionId?: string) {
      const id = ++nextId;
      const result = new Promise<Record<string, unknown>>((resolve) => pending.set(id, resolve));
      void ch.send(encodeFrame(JSON.stringify({ id, method, params, sessionId })));
      return result.then((m) => {
        assert.equal(m.error, undefined, `${method}: ${JSON.stringify(m.error)}`);
        return m.result as Record<string, unknown>;
      });
    },
    close: () => ch.reset("test done"),
  };
}

async function pageTitle(
  session: ServerSession,
  worktreeId: string,
  url: string,
  profileDir?: string,
) {
  const cdp = await connectCdp(session, worktreeId);
  try {
    const { targetId } = (await cdp.send("Target.createTarget", { url })) as { targetId: string };
    const { sessionId } = (await cdp.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    })) as { sessionId: string };
    // The page may still be loading when the target is created.
    const startedAt = Date.now();
    let last = "";
    for (let i = 0; i < 100; i++) {
      const res = (await cdp.send(
        "Runtime.evaluate",
        {
          expression:
            "JSON.stringify({ state: document.readyState, href: location.href, title: document.title })",
        },
        sessionId,
      )) as { result: { value: string } };
      last = res.result.value;
      const page = JSON.parse(last) as { state: string; href: string; title: string };
      if (page.state === "complete" && page.title) {
        console.log(`DIAG title after ${Date.now() - startedAt} ms, ${i + 1} polls`);
        return page.title;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    const log = profileDir
      ? readFileSync(join(profileDir, "chromium.log"), "utf8").split("\n").slice(-30).join(" | ")
      : "";
    throw new Error(
      `the page never got a title after ${Date.now() - startedAt} ms; last saw ${last}; chromium.log: ${log}`,
    );
  } finally {
    cdp.close();
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("browser over the link", {
  skip: chromium ? false : "no Chromium on this machine",
}, () => {
  let hub: TestHub;
  let w: TestWorker;
  let site: Server;
  let origin: string;
  let cookieHits = 0;

  before(async () => {
    process.env.BAND_CHROMIUM_BIN = chromium;
    site = createServer((req, res) => {
      if (req.url === "/cookie") {
        cookieHits++;
        const expires = new Date(Date.now() + 3600_000).toUTCString();
        res.writeHead(200, {
          "content-type": "text/html",
          "set-cookie": `band=persisted; Expires=${expires}; Path=/`,
        });
        res.end("<title>cookie set</title>");
        return;
      }
      if (req.url === "/echo-cookie") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<title>cookie:${req.headers.cookie ?? "none"}</title>`);
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<title>served on the worker</title>");
    });
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    hub = await startHub();
    w = await startWorker(hub);
  });

  after(async () => {
    await call(w.session, "browser.close", { worktreeId: "wt-a" }).catch(() => undefined);
    await call(w.session, "browser.close", { worktreeId: "wt-b" }).catch(() => undefined);
    await w.worker.stop();
    await hub.close();
    site.closeAllConnections();
    await new Promise<void>((r) => site.close(() => r()));
    cleanup(w.root, w.stateDir);
  });

  it("reads the title of a page on the worker's localhost", async () => {
    const openedAt = Date.now();
    const info = await openBrowser(w.session, "wt-a");
    console.log(`DIAG browser.open took ${Date.now() - openedAt} ms`);
    assert.ok(info.pid > 0);
    assert.ok(info.profileDir.startsWith(join(w.stateDir, "browser")));
    assert.equal(
      await pageTitle(w.session, "wt-a", origin, info.profileDir),
      "served on the worker",
    );
  });

  it("keeps the DevTools port on loopback", async () => {
    const info = await openBrowser(w.session, "wt-a");
    const [port, path] = readFileSync(join(info.profileDir, "DevToolsActivePort"), "utf8").split(
      "\n",
    );
    assert.equal(Number(port), info.port);
    const version = await fetch(`http://127.0.0.1:${info.port}/json/version`);
    assert.equal(version.status, 200);
    assert.match(path ?? "", /^\/devtools\/browser\//);
    // `--remote-debugging-address=127.0.0.1` binds loopback only: the listening socket is not on a wildcard address.
    const flags = (await import("node:child_process"))
      .execFileSync("ps", ["-o", "command=", "-p", String(info.pid)], { encoding: "utf8" })
      .trim();
    assert.match(flags, /--remote-debugging-address=127\.0\.0\.1/);
    assert.match(flags, /--remote-debugging-port=0/);
  });

  it("keeps cookies across a close and reopen of the same worktree", async () => {
    await openBrowser(w.session, "wt-b");
    assert.equal(await pageTitle(w.session, "wt-b", `${origin}/cookie`), "cookie set");
    await call(w.session, "browser.close", { worktreeId: "wt-b" });
    const again = await openBrowser(w.session, "wt-b");
    assert.ok(cookieHits >= 1);
    assert.equal(
      await pageTitle(w.session, "wt-b", `${origin}/echo-cookie`),
      "cookie:band=persisted",
    );
    assert.ok(again.profileDir.endsWith("wt-b"));
  });

  it("gives another worktree its own profile", async () => {
    const other = await openBrowser(w.session, "wt-a");
    assert.equal(await pageTitle(w.session, "wt-a", `${origin}/echo-cookie`), "cookie:none");
    assert.ok(other.profileDir.endsWith("wt-a"));
  });

  it("kills Chromium when the worktree's browser is closed", async () => {
    const info = await openBrowser(w.session, "wt-a");
    assert.ok(alive(info.pid));
    await call(w.session, "browser.close", { worktreeId: "wt-a" });
    assert.equal(alive(info.pid), false);
    await assert.rejects(call(w.session, "browser.connect", { worktreeId: "wt-a" }));
    assert.ok(existsSync(info.profileDir), "the profile stays for the next open");
  });
});
