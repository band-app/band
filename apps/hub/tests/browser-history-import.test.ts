import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  trpcMutate as sharedTrpcMutate,
  trpcQuery as sharedTrpcQuery,
  startServer,
  trpcData,
} from "./helpers/server";

// Integration tests for `history.import`, which stores the browsing history
// the desktop app read from a Chrome profile (the browser import dialog)
// in a worktree's history. Driven through the production server bundle
// over tRPC HTTP.
//
// Reading Chrome's History DB runs in the desktop app and is covered by
// `apps/desktop/tests/chrome-import.test.ts`.

const TOKEN = "browser-history-import-test-token";

function trpcMutate(serverUrl: string, procedure: string, input?: unknown) {
  return sharedTrpcMutate(serverUrl, procedure, input, TOKEN);
}

function trpcQuery(serverUrl: string, procedure: string, input?: unknown) {
  return sharedTrpcQuery(serverUrl, procedure, input, TOKEN);
}

interface Entry {
  url: string;
  title: string | null;
  faviconUrl: string | null;
  lastVisitedAt: number;
  visitCount: number;
}

async function listHistory(serverUrl: string, worktreeId: string): Promise<Entry[]> {
  const res = await trpcQuery(serverUrl, "history.list", { worktreeId, limit: 500 });
  expect(res.status).toBe(200);
  const { entries } = await trpcData<{ entries: (Entry & { id: number })[] }>(res);
  return entries.map(({ url, title, faviconUrl, lastVisitedAt, visitCount }) => ({
    url,
    title,
    faviconUrl,
    lastVisitedAt,
    visitCount,
  }));
}

async function importHistory(serverUrl: string, worktreeId: string, entries: unknown[]) {
  const res = await trpcMutate(serverUrl, "history.import", { worktreeId, entries });
  expect(res.status).toBe(200);
  return (await trpcData<{ imported: number }>(res)).imported;
}

describe("history.import", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome("band-history-import-");
    seedSettings(tmpHome, { tokenSecret: TOKEN });
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("rejects calls without the band_token cookie (401)", async () => {
    const res = await fetch(`${server.url}/trpc/history.import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ worktreeId: "ws-unauth", entries: [] }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects the whole batch when an entry isn't a plain http(s) URL", async () => {
    const valid = {
      url: "https://valid.example.com/",
      title: null,
      visitCount: 1,
      lastVisitedAt: 1_000,
    };
    for (const url of ["javascript:alert(1)", "https://user:pass@creds.example.com/"]) {
      const res = await trpcMutate(server.url, "history.import", {
        worktreeId: "ws-invalid",
        entries: [valid, { ...valid, url }],
      });
      expect(res.status).toBe(400);
    }
    expect(await listHistory(server.url, "ws-invalid")).toEqual([]);
  });

  it("rejects more than 5000 entries", async () => {
    const entries = Array.from({ length: 5001 }, (_, i) => ({
      url: `https://too-many-${i}.example.com/`,
      title: null,
      visitCount: 1,
      lastVisitedAt: 1_000,
    }));
    const res = await trpcMutate(server.url, "history.import", {
      worktreeId: "ws-too-many",
      entries,
    });
    expect(res.status).toBe(400);
    expect(await listHistory(server.url, "ws-too-many")).toEqual([]);
  });

  it("adds imported visits to the worktree's history, newest first", async () => {
    const imported = await importHistory(server.url, "ws-fresh", [
      {
        url: "https://docs.example.com/guide",
        title: "Guide title value",
        visitCount: 7,
        lastVisitedAt: 1_700_000_200_000,
      },
      {
        url: "http://intranet.example:8080/page?q=1",
        title: null,
        visitCount: 1,
        lastVisitedAt: 1_700_000_100_000,
      },
    ]);

    expect(imported).toBe(2);
    expect(await listHistory(server.url, "ws-fresh")).toEqual([
      {
        url: "https://docs.example.com/guide",
        title: "Guide title value",
        faviconUrl: "https://docs.example.com/favicon.ico",
        lastVisitedAt: 1_700_000_200_000,
        visitCount: 7,
      },
      {
        url: "http://intranet.example:8080/page?q=1",
        title: null,
        faviconUrl: "http://intranet.example:8080/favicon.ico",
        lastVisitedAt: 1_700_000_100_000,
        visitCount: 1,
      },
    ]);
    expect(await listHistory(server.url, "ws-other")).toEqual([]);
  });

  it("merges into existing rows and is a no-op when repeated", async () => {
    const worktreeId = "ws-merge";
    for (const input of [
      { worktreeId, url: "https://kept.example.com/", title: "Title recorded in Band" },
      { worktreeId, url: "https://filled.example.com/" },
    ]) {
      const res = await trpcMutate(server.url, "history.record", input);
      expect(res.status).toBe(200);
    }
    const before = await listHistory(server.url, worktreeId);
    const recordedAt = (url: string) => before.find((e) => e.url === url)?.lastVisitedAt;
    const futureVisit = Date.now() + 86_400_000;

    const visits = [
      {
        // Older than Band's visit, so Band's time and title stay.
        url: "https://kept.example.com/",
        title: "Title from Chrome",
        visitCount: 12,
        lastVisitedAt: 1_600_000_000_000,
      },
      {
        // Newer than Band's visit, and Band has no title for it.
        url: "https://filled.example.com/",
        title: "Title only Chrome knows",
        visitCount: 4,
        lastVisitedAt: futureVisit,
      },
    ];
    await importHistory(server.url, worktreeId, visits);
    await importHistory(server.url, worktreeId, visits);

    expect(await listHistory(server.url, worktreeId)).toEqual([
      {
        url: "https://filled.example.com/",
        title: "Title only Chrome knows",
        // Band recorded no favicon, so the import fills in the guessed one.
        faviconUrl: "https://filled.example.com/favicon.ico",
        lastVisitedAt: futureVisit,
        visitCount: 4,
      },
      {
        url: "https://kept.example.com/",
        title: "Title recorded in Band",
        faviconUrl: "https://kept.example.com/favicon.ico",
        lastVisitedAt: recordedAt("https://kept.example.com/"),
        visitCount: 12,
      },
    ]);
  });

  it("accepts a full-size import (5000 entries) in one request", async () => {
    const entries = Array.from({ length: 5000 }, (_, i) => ({
      url: `https://site-${i}.example.com/some/fairly/long/path/segment-${i}?query=value-${i}`,
      title: `Page title value ${i} with some extra words to make it realistic`,
      visitCount: 1 + (i % 9),
      lastVisitedAt: 1_700_000_000_000 - i * 1_000,
    }));

    expect(await importHistory(server.url, "ws-bulk", entries)).toBe(5000);
    const listed = await listHistory(server.url, "ws-bulk");
    expect(listed).toHaveLength(500);
    expect(listed[0]?.url).toBe(entries[0]?.url);
  });
});
