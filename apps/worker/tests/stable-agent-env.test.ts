import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  type GitCredentialParams,
  METHOD_GIT_CREDENTIAL,
  METHOD_RELAY_HTTP,
  type RelayHttpRequest,
  type ServerSession,
} from "@band-app/link";
import { stopTerminalDaemons } from "../src/terminals.ts";
import {
  call,
  cleanup,
  spawnWorkerProcess,
  startHub,
  type TestHub,
  TOKEN,
  tmpDir,
  type WorkerProcess,
  waitFor,
} from "./helpers.ts";

// What an agent or shell started by a worker keeps in its environment (the git credential socket, the relay URL
// and token, a PATH with `band`) must still work after the worker restarts. These tests run the real
// `band-worker` binary, kill it, start it again on the same state dir and run commands in a shell that stayed.

interface Entry {
  terminalId: string;
  pid: number;
}

function fakeCli(dir: string, name: string, output: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\necho ${output}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe("the environment an agent holds survives a worker restart", () => {
  let hub: TestHub;
  let root: string;
  let stateDir: string;
  let cliDir: string;
  let proc: WorkerProcess | null = null;
  let session: ServerSession;
  const relayCalls: RelayHttpRequest[] = [];
  const credentialAsks: GitCredentialParams[] = [];
  let relayUrl = "";
  let cliPath = "";

  hub = undefined as never;

  async function startWorker(): Promise<void> {
    const connected = hub.nextSession();
    proc = spawnWorkerProcess(
      ["--hub", hub.url, "--token", TOKEN, "--root", root, "--state-dir", stateDir],
      { BAND_CLI_PATH: cliPath },
    );
    session = await connected;
  }

  async function killWorker(): Promise<void> {
    const current = proc;
    assert.ok(current);
    current.child.kill("SIGKILL");
    await current.exited;
    proc = null;
  }

  async function run(terminalId: string, command: string): Promise<string> {
    const res = (await session.request("pty.attach", {
      terminalId,
      dims: { cols: 200, rows: 24 },
    })) as { chan: number };
    const ch = session.getChannel(res.chan);
    assert.ok(ch);
    let text = "";
    void (async () => {
      try {
        for await (const chunk of ch) text += chunk.toString();
      } catch {
        // A reset ends the loop.
      }
    })();
    const marker = `done-${Math.random().toString(36).slice(2)}`;
    await ch.send(Buffer.from(`${command}; echo ${marker}\n`));
    await waitFor(() => text.split(marker).length > 2, 15_000, `output of ${command}`);
    ch.reset();
    // The tty echoes the typed line first, then the output follows the line ending after the typed marker.
    return text.slice(text.indexOf(`${marker}\r\n`));
  }

  before(async () => {
    hub = await startHub();
    root = tmpDir();
    stateDir = tmpDir("band-worker-state-");
    cliDir = tmpDir("band-cli-");
    cliPath = fakeCli(join(cliDir, "one"), "band", "cli-one");
    hub.server.on("connected", (s: ServerSession) => {
      s.handle(METHOD_GIT_CREDENTIAL, (params) => {
        credentialAsks.push(params as GitCredentialParams);
        return { found: true, username: "x-access-token", password: "secret-from-hub" };
      });
      s.handle(METHOD_RELAY_HTTP, (params) => {
        relayCalls.push(params as RelayHttpRequest);
        const ch = s.openChannel("relay.body");
        void ch.send(Buffer.from("ok")).then(() => ch.end());
        return { status: 200, headers: { "content-type": "text/plain" }, chan: ch.id };
      });
    });
    await startWorker();
  });

  after(async () => {
    if (proc) {
      proc.child.kill("SIGTERM");
      await proc.exited;
    }
    stopTerminalDaemons(stateDir);
    await hub.close();
    cleanup(root, stateDir, cliDir);
  });

  const probes =
    'echo "cli=$(band)"; ' +
    "printf 'protocol=https\\nhost=example.com\\npath=o/r\\n\\n' | git credential fill; " +
    'echo "relay=$(curl -s -o /dev/null -w %{http_code} -H "Authorization: Bearer $BAND_TOKEN" "$BAND_SERVER_URL/api/trpc/x")"';

  // P1-S1
  it("keeps band, the git credential and the relay working in a shell that outlives the worker", async () => {
    const grant = await call<{ url: string }>(session, "relay.register", {
      token: "brt_one",
      worktreeId: "ws",
      terminalId: "t1",
    });
    relayUrl = grant.url;
    const entry = await call<Entry>(session, "pty.spawn", {
      worktreeId: "ws",
      terminalId: "t1",
      worktreeRoot: root,
      options: { env: { BAND_SERVER_URL: relayUrl, BAND_TOKEN: "brt_one" } },
    });

    const before = await run("t1", probes);
    assert.match(before, /cli=cli-one/);
    assert.match(before, /password=secret-from-hub/);
    assert.match(before, /relay=200/);

    await killWorker();
    cliPath = fakeCli(join(cliDir, "two"), "band", "cli-two");
    credentialAsks.length = 0;
    relayCalls.length = 0;
    await startWorker();

    const after = await run("t1", probes);
    assert.match(after, /cli=cli-two/, "the same PATH now reaches the CLI the new worker resolved");
    assert.match(after, /password=secret-from-hub/);
    assert.match(after, /relay=200/);
    assert.equal(credentialAsks.length, 1);
    assert.equal(relayCalls.length, 1);
    assert.equal(relayCalls[0]?.scope.worktreeId, "ws");
    const reachable = await call<Entry[]>(session, "pty.listAll");
    assert.equal(reachable.find((e) => e.terminalId === "t1")?.pid, entry.pid);
  });

  // P1-S2
  it("refuses a relay token the hub revoked, also after another restart", async () => {
    await call(session, "relay.revoke", { token: "brt_one" });
    const revoked = await run("t1", probes);
    assert.match(revoked, /relay=401/);

    await killWorker();
    await startWorker();
    const again = await run("t1", probes);
    assert.match(again, /relay=401/, "a revoked grant is not brought back by a restart");
  });

  it("keeps the saved grants private", () => {
    assert.equal(statSync(join(stateDir, "relay.json")).mode & 0o777, 0o600);
  });

  // P1-S3
  it("repoints the stable band path when the CLI package moves", () => {
    const link = join(stateDir, "bin", "band");
    assert.equal(readlinkSync(link), cliPath);
    assert.ok(cliPath.includes(`${join(cliDir, "two")}`));
  });
});
