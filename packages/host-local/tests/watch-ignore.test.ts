import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { FileChange } from "@band-app/host-api";
import { LocalHost } from "../src/local-host";

// A real recursive watch over a real temp dir. The host drops events for ignored names before they
// leave the host, which on a worker means before they cross the link.

describe("host.fs.watch ignore", () => {
  let dir: string;
  let host: LocalHost;

  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "band-watch-ignore-")));
    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(dir, "src"));
    host = new LocalHost({ terminalBackend: () => undefined as never });
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  async function collect(ignore: string[] | undefined): Promise<string[]> {
    const controller = new AbortController();
    const seen: string[] = [];
    const reading = (async () => {
      for await (const change of host.fs.watch(dir, {
        recursive: true,
        signal: controller.signal,
        ignore,
      }) as AsyncIterable<FileChange>) {
        seen.push(change.path);
      }
    })();
    // Let the watcher start, write into an ignored and a normal path, then give the events time to arrive.
    await new Promise((r) => setTimeout(r, 200));
    writeFileSync(join(dir, "node_modules", "pkg", "index.js"), `${Math.random()}\n`);
    // The sentinel is written last; once its event arrives, the earlier write had its chance to be reported.
    const deadline = Date.now() + 5_000;
    while (!seen.some((p) => p.endsWith("sentinel.ts")) && Date.now() < deadline) {
      writeFileSync(join(dir, "src", "sentinel.ts"), `${Math.random()}\n`);
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 200));
    controller.abort();
    await reading;
    return seen;
  }

  it("sends no event for a path under an ignored directory", async () => {
    const seen = await collect(["node_modules", ".git"]);
    assert.ok(
      seen.some((p) => p.startsWith("src/")),
      `expected a src event in ${JSON.stringify(seen)}`,
    );
    assert.deepEqual(
      seen.filter((p) => p.split("/").includes("node_modules")),
      [],
    );
  });

  it("sends the ignored path's events when nothing is ignored", async () => {
    const seen = await collect(undefined);
    assert.ok(
      seen.some((p) => p.split("/").includes("node_modules")),
      `expected a node_modules event in ${JSON.stringify(seen)}`,
    );
  });
});
