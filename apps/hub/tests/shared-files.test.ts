/**
 * Files an agent shares belong to its chat. Boots the real server with the
 * scripted ACP stub agent; with `BAND_TEST_HOST=remote-loopback` the worktree
 * is on a real `band-worker`, so the same assertions cover the worker path.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  runTurn,
  type StubTurn,
  sharedLocation,
  startAcpServer,
  TEST_TOKEN,
  WORKTREE_ID,
} from "./helpers/acp-chat";
import type { ServerHandle } from "./helpers/server";

const shareTurn = (match: string, name: string): StubTurn => ({
  match: `^${match}`,
  steps: [
    { tool: { toolCallId: `t-${match}`, title: "Copy a file", kind: "execute" } },
    { writeFile: { path: `{{sharedDir}}/${name}`, content: "{{prompt}}\n" } },
    { sleep: 600 },
    { toolUpdate: { toolCallId: `t-${match}`, status: "completed" } },
    { say: "shared" },
  ],
});

let server: ServerHandle;
beforeAll(async () => {
  server = await startAcpServer({
    turns: [
      shareTurn("share-a", "a.txt"),
      shareTurn("share-b", "b.txt"),
      shareTurn("same-a", "same.txt"),
      shareTurn("same-b", "same.txt"),
    ],
  });
}, 120_000);
afterAll(async () => {
  await server?.close();
});

const auth = { Cookie: `band_token=${TEST_TOKEN}` };
const get = (path: string) => fetch(`${server.url}${path}`, { headers: auth });
/** Sends the path as written; `fetch` would collapse `%2e%2e` segments before the server saw them. */
const getRaw = (path: string) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const url = new URL(server.url);
    const req = request({ host: url.hostname, port: url.port, path, headers: auth }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
const fileCards = (events: Awaited<ReturnType<typeof runTurn>>) =>
  events.filter((e) => e.type === "file") as unknown as Array<{ url: string; filename: string }>;

describe("shared files per chat (S1)", () => {
  it("shows each chat only its own file while both run at once", async () => {
    const [a, b] = await Promise.all([
      runTurn(server.url, "shared-chat-a", "share-a"),
      runTurn(server.url, "shared-chat-b", "share-b"),
    ]);
    expect(fileCards(a).map((f) => f.filename)).toEqual(["a.txt"]);
    expect(fileCards(b).map((f) => f.filename)).toEqual(["b.txt"]);
    expect(fileCards(a)[0].url).toBe(
      `/api/shared/${encodeURIComponent(WORKTREE_ID)}/shared-chat-a/a.txt`,
    );
    expect(await (await get(fileCards(a)[0].url)).text()).toBe("share-a\n");
  });

  it("keeps two chats' files of the same name apart", async () => {
    const [a, b] = await Promise.all([
      runTurn(server.url, "same-chat-a", "same-a"),
      runTurn(server.url, "same-chat-b", "same-b"),
    ]);
    expect(fileCards(a)).toHaveLength(1);
    expect(fileCards(b)).toHaveLength(1);
    expect(await (await get(fileCards(a)[0].url)).text()).toBe("same-a\n");
    expect(await (await get(fileCards(b)[0].url)).text()).toBe("same-b\n");
  });
});

describe("the shared file route (S2)", () => {
  const wt = encodeURIComponent(WORKTREE_ID);

  it("still serves the older two-segment URL", async () => {
    const root = sharedLocation(server.home, WORKTREE_ID);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "old.txt"), "from the old folder\n");
    const res = await get(`/api/shared/${wt}/old.txt`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("from the old folder\n");
  });

  it("never serves a file outside the shared root", async () => {
    const root = sharedLocation(server.home, WORKTREE_ID);
    mkdirSync(root, { recursive: true });
    const secret = join(dirname(root), "secret.txt");
    writeFileSync(secret, "outside the shared root\n");
    const attempts = [
      `/api/shared/${wt}/..%2Fsecret.txt`,
      `/api/shared/${wt}/some-chat/..%2F..%2Fsecret.txt`,
      `/api/shared/${wt}/%2e%2e/secret.txt`,
      `/api/shared/${wt}/some-chat/%2e%2e/secret.txt`,
      `/api/shared/%2e%2e/secret.txt`,
      `/api/shared/${wt}/..%5Csecret.txt`,
      `/api/shared/${wt}/a/b/secret.txt`,
      `/api/shared/${wt}/%E0%A4%A`,
    ];
    for (const path of attempts) {
      const res = await getRaw(path);
      expect([400, 404], path).toContain(res.status);
      expect(res.body, path).not.toContain("outside the shared root");
    }
  });
});
