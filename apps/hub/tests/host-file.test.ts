// Integration tests for the host file IO procedures (`host.readFile`,
// `host.saveFile`) that back the editor's "Open File…" action.
//
// We exercise the real server pipeline: spawn the production server in a
// child process, then call the tRPC procedures over HTTP against an actual
// file living outside any registered workspace root. The assertions are
// behavioural (HTTP status, response shape, on-disk content after a save)
// — no mocks; the only seam is the band_token cookie used by the rest of
// the integration-test suite.

import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
    expect(body.error.message).toMatch(/directory|regular file/);
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

  it("host.saveFile returns a descriptive error for a non-existent file", async () => {
    // The endpoint refuses to create files — it's a save, not a create.
    // We want a clean "File not found" message instead of a raw ENOENT
    // bubbling up as an opaque 500.
    const missing = join(outsideDir, "definitely-does-not-exist.txt");
    const res = await trpcMutate(server.url, "host.saveFile", {
      absolutePath: missing,
      content: "anything",
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.message).toContain("File not found");
  });

  it("host.readFile rejects symbolic links", async () => {
    // The OS picker can return a symlink, but the host endpoints must
    // not silently follow it — a symlink to /etc/passwd would otherwise
    // pass the `isFile()` check after stat(). lstat()-based detection
    // surfaces it cleanly.
    const target = join(outsideDir, "real.txt");
    writeFileSync(target, "real content\n", "utf-8");
    const link = join(outsideDir, "link.txt");
    symlinkSync(target, link);

    const res = await trpcQuery(server.url, "host.readFile", { absolutePath: link });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.message).toContain("Symbolic link");
  });

  it("host.saveFile rejects symbolic links", async () => {
    const target = join(outsideDir, "real-save.txt");
    writeFileSync(target, "real content\n", "utf-8");
    const link = join(outsideDir, "link-save.txt");
    symlinkSync(target, link);

    const res = await trpcMutate(server.url, "host.saveFile", {
      absolutePath: link,
      content: "should not write through symlink",
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.message).toContain("Symbolic link");

    // And the target file must be unchanged.
    expect(readFileSync(target, "utf-8")).toBe("real content\n");
  });

  it("host.readFile returns { tooLarge: true } for files larger than MAX_FILE_SIZE", async () => {
    // MAX_FILE_SIZE is 1MB server-side; write something just past the
    // threshold so the boundary is exercised without bloating the test.
    const bigPath = join(outsideDir, "big.bin");
    const big = Buffer.alloc(1024 * 1024 + 1, 65); // 1MB + 1 byte of "A"
    writeFileSync(bigPath, big);

    const res = await trpcQuery(server.url, "host.readFile", { absolutePath: bigPath });
    expect(res.status).toBe(200);
    const data = await trpcData<{ tooLarge?: true; size: number; content?: string }>(res);
    expect(data.tooLarge).toBe(true);
    expect(data.size).toBe(big.length);
    // No content should be sent.
    expect(data.content).toBeUndefined();
  });

  it("host.readFile returns { binary: true } for files containing NUL bytes", async () => {
    // The detection samples the first 8KB for null bytes — the cheapest
    // signal that a file is binary. We don't want raw binary content
    // streamed back into a text editor.
    const binPath = join(outsideDir, "small.bin");
    const bin = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
    writeFileSync(binPath, bin);

    const res = await trpcQuery(server.url, "host.readFile", { absolutePath: binPath });
    expect(res.status).toBe(200);
    const data = await trpcData<{ binary?: true; size: number; content?: string }>(res);
    expect(data.binary).toBe(true);
    expect(data.size).toBe(bin.length);
    expect(data.content).toBeUndefined();
  });

  it("host.readFile / host.saveFile reject unauthenticated callers", async () => {
    // The host procedures bypass the workspace containment guard, so
    // the transport-layer band_token cookie is the only thing standing
    // between an unauthenticated caller and arbitrary FS access. The
    // assertion pins the response to 401 (the status auth.test.ts also
    // verifies for missing/invalid tokens) — a generic "non-200" would
    // pass even if the auth gate were broken and the server returned a
    // crash 500.
    const readRes = await fetch(
      `${server.url}/trpc/host.readFile?input=${encodeURIComponent(
        JSON.stringify({ absolutePath: externalPath }),
      )}`,
    );
    expect(readRes.status).toBe(401);

    const saveRes = await fetch(`${server.url}/trpc/host.saveFile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ absolutePath: externalPath, content: "evil" }),
    });
    expect(saveRes.status).toBe(401);

    // And the file on disk must be untouched (still the previous test's content).
    const onDisk = readFileSync(externalPath, "utf-8");
    expect(onDisk).not.toBe("evil");
  });
});
