// Integration tests for the host file IO procedures (`host.readFile`,
// `host.saveFile`) that back the "Open File…" action — issue #433.
//
// We exercise the real server pipeline: spawn the production server in a
// child process, then call the tRPC procedures over HTTP against an actual
// file living outside any registered workspace root. The assertions are
// behavioural (HTTP status, response shape, on-disk content after a save)
// — no mocks; the only seam is the band_token cookie used by the rest of
// the integration-test suite.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings, seedState } from "./helpers/seed-state";
import { SERVER_RUNTIME, SERVER_SCRIPT } from "./helpers/server-runtime";

const PROJECT_ROOT = join(import.meta.dirname, "..");
const DEFAULT_TOKEN = "host-file-test-token";

// ---------------------------------------------------------------------------
// Server helpers (mirror the patterns in trpc.test.ts so the suite stays
// homogeneous; deliberately copied rather than imported to keep each test
// file self-contained — the helper file already collected enough churn).
// ---------------------------------------------------------------------------

interface ServerHandle {
  url: string;
  home: string;
  close: () => Promise<void>;
}

function createTmpHome(): string {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "band-host-file-test-")));
  const bandDir = join(tmp, ".band");
  mkdirSync(bandDir, { recursive: true });
  return tmp;
}

function getRandomPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function startServer(opts: { tmpHome: string }): Promise<ServerHandle> {
  const home = opts.tmpHome;
  const port = await getRandomPort();
  return new Promise((resolve, reject) => {
    const child = spawn(SERVER_RUNTIME, [SERVER_SCRIPT], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: home,
        PORT: String(port),
        NODE_ENV: "production",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    let settled = false;

    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.stdout!.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      if (text.includes("listening") && !settled) {
        settled = true;
        resolve({
          url: `http://127.0.0.1:${port}`,
          home,
          close: () =>
            new Promise<void>((r) => {
              child.on("exit", () => r());
              child.kill("SIGTERM");
            }),
        });
      }
    });

    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    child.on("exit", (code) => {
      if (!settled) {
        settled = true;
        reject(new Error(`Server exited with code ${code} before listening.\nstderr: ${stderr}`));
      }
    });

    setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGTERM");
        reject(new Error(`Server did not start within 15 s.\nstderr: ${stderr}`));
      }
    }, 15_000);
  });
}

// ---------------------------------------------------------------------------
// tRPC HTTP helpers
// ---------------------------------------------------------------------------

const defaultHeaders = { Cookie: `band_token=${DEFAULT_TOKEN}` };

async function trpcQuery(serverUrl: string, procedure: string, input?: unknown) {
  const url =
    input !== undefined
      ? `${serverUrl}/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`
      : `${serverUrl}/trpc/${procedure}`;
  return fetch(url, { headers: defaultHeaders });
}

async function trpcMutate(serverUrl: string, procedure: string, input?: unknown) {
  return fetch(`${serverUrl}/trpc/${procedure}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...defaultHeaders },
    body: input !== undefined ? JSON.stringify(input) : "{}",
  });
}

async function trpcData<T>(res: Response): Promise<T> {
  const body = (await res.json()) as { result: { data: T } };
  return body.result.data;
}

// ---------------------------------------------------------------------------
// host.readFile / host.saveFile — round-trip
// ---------------------------------------------------------------------------

describe("tRPC — host.readFile / host.saveFile (external files)", () => {
  let server: ServerHandle;
  let tmpHome: string;
  // The "outside" dir lives next to (not inside) the user's home, to model
  // a path that no workspace would ever contain — i.e. the real-world
  // case the "Open File…" action is for.
  let outsideDir: string;
  let externalPath: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "band-host-file-outside-")));
    externalPath = join(outsideDir, "scratch.md");
    writeFileSync(externalPath, "# external file\n\noriginal contents\n", "utf-8");

    seedState(tmpHome, { projects: [] });
    seedSettings(tmpHome, { tokenSecret: DEFAULT_TOKEN });
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it("host.readFile returns the contents of a file outside any workspace", async () => {
    const res = await trpcQuery(server.url, "host.readFile", { absolutePath: externalPath });
    expect(res.status).toBe(200);
    const data = await trpcData<{ content: string; size: number; language?: string }>(res);
    expect(data.content).toBe("# external file\n\noriginal contents\n");
    expect(data.size).toBeGreaterThan(0);
    // Markdown extension is mapped server-side; doesn't matter what the
    // exact language hint is, only that the path-based detection runs.
    expect(data.language).toBe("markdown");
  });

  it("host.readFile rejects a non-absolute path", async () => {
    const res = await trpcQuery(server.url, "host.readFile", { absolutePath: "relative/path.txt" });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.message).toContain("Absolute path required");
  });

  it("host.readFile rejects a path that is a directory", async () => {
    const res = await trpcQuery(server.url, "host.readFile", { absolutePath: outsideDir });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.message).toContain("Not a regular file");
  });

  it("host.saveFile writes new contents to the on-disk file", async () => {
    const newContent = "# external file\n\nedited via Band\n";
    const res = await trpcMutate(server.url, "host.saveFile", {
      absolutePath: externalPath,
      content: newContent,
    });
    expect(res.status).toBe(200);

    // Read the file back from disk to confirm the write actually landed —
    // never trust the procedure's `{ ok: true }` echo alone.
    const onDisk = readFileSync(externalPath, "utf-8");
    expect(onDisk).toBe(newContent);

    // And reading via host.readFile should return the new contents too.
    const readRes = await trpcQuery(server.url, "host.readFile", { absolutePath: externalPath });
    const readData = await trpcData<{ content: string }>(readRes);
    expect(readData.content).toBe(newContent);
  });

  it("host.saveFile rejects a non-absolute path", async () => {
    const res = await trpcMutate(server.url, "host.saveFile", {
      absolutePath: "still/relative.txt",
      content: "hi",
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.message).toContain("Absolute path required");
  });

  it("host.saveFile rejects writing to a directory", async () => {
    const res = await trpcMutate(server.url, "host.saveFile", {
      absolutePath: outsideDir,
      content: "should not work",
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.message).toMatch(/directory|regular file/);
  });
});
