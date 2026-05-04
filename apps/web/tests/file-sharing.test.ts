import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings, seedState } from "./helpers/seed-state";
import { SERVER_RUNTIME, SERVER_SCRIPT } from "./helpers/server-runtime";

const PROJECT_ROOT = join(import.meta.dirname, "..");
const FAKE_AGENT_PATH = join(import.meta.dirname, "fake-agent.mjs");
const DEFAULT_TOKEN = "file-sharing-test-token";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ServerHandle {
  url: string;
  home: string;
  close: () => Promise<void>;
}

function createTmpHome(): string {
  const tmp = mkdtempSync(join(tmpdir(), "band-filesharing-"));
  const bandDir = join(tmp, ".band");
  mkdirSync(bandDir, { recursive: true });
  return tmp;
}

function writeScenario(tmpHome: string, events: object[]): string {
  const scenarioPath = join(tmpHome, "scenario.json");
  writeFileSync(scenarioPath, JSON.stringify(events));
  return scenarioPath;
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

function createDefaultState(tmpHome: string) {
  const repoPath = join(tmpHome, "myrepo");
  mkdirSync(repoPath, { recursive: true });
  return {
    projects: [
      {
        name: "testproject",
        path: repoPath,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: repoPath }],
      },
    ],
  };
}

async function startServer(
  opts: { tmpHome?: string; scenarioPath?: string } = {},
): Promise<ServerHandle> {
  const home = opts.tmpHome || createTmpHome();
  const port = await getRandomPort();

  return new Promise((resolve, reject) => {
    const child = spawn(SERVER_RUNTIME, [SERVER_SCRIPT], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: home,
        PORT: String(port),
        NODE_ENV: "production",
        FAKE_AGENT_SCENARIO: opts.scenarioPath || "",
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
// HTTP / tRPC helpers
// ---------------------------------------------------------------------------

const defaultHeaders = { Cookie: `band_token=${DEFAULT_TOKEN}` };

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

interface SSEEvent {
  event: string | null;
  data: unknown;
}

/**
 * Parse an AI SDK SSE stream response into an array of { event, data } objects.
 */
async function parseSSEStream(response: Response): Promise<SSEEvent[]> {
  const text = await response.text();
  const events: SSEEvent[] = [];

  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const raw = line.slice(5).trim();
    if (!raw || raw === "[DONE]") continue;
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      continue;
    }

    const event =
      typeof data === "object" && data !== null
        ? ((data as Record<string, unknown>).type as string)
        : null;
    if (event) {
      events.push({ event, data });
    }
  }

  return events;
}

/**
 * Submit a task via the SSE POST endpoint and stream to completion.
 */
async function submitAndStream(
  serverUrl: string,
  workspaceId: string,
  prompt: string,
): Promise<{ submitRes: Response; events: SSEEvent[] }> {
  const chatId = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const submitRes = await fetch(`${serverUrl}/api/tasks/${encodeURIComponent(chatId)}/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...defaultHeaders },
    body: JSON.stringify({ workspaceId, prompt }),
  });
  if (!submitRes.ok) return { submitRes, events: [] };
  const events = await parseSSEStream(submitRes);
  return { submitRes, events };
}

// ---------------------------------------------------------------------------
// /api/uploads/ — HTTP file serving for user uploads
// ---------------------------------------------------------------------------

describe("/api/uploads/ — serving user-uploaded files", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));
    seedSettings(tmpHome, { tokenSecret: DEFAULT_TOKEN });

    // Pre-create uploaded files
    const uploadsDir = join(tmpHome, ".band", "uploads");
    mkdirSync(uploadsDir, { recursive: true });
    writeFileSync(join(uploadsDir, "1712345-notes.txt"), "Some notes\n");
    writeFileSync(join(uploadsDir, "1712345-photo.jpg"), Buffer.from("fake-jpg-bytes"));
    writeFileSync(join(uploadsDir, "1712345-data.json"), '{"key": "value"}\n');

    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("serves a text file with correct content-type", async () => {
    const res = await fetch(`${server.url}/api/uploads/1712345-notes.txt`, {
      headers: defaultHeaders,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain");
    const body = await res.text();
    expect(body).toContain("Some notes");
  });

  it("serves a JPEG with correct content-type", async () => {
    const res = await fetch(`${server.url}/api/uploads/1712345-photo.jpg`, {
      headers: defaultHeaders,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
  });

  it("serves a JSON file with correct content-type", async () => {
    const res = await fetch(`${server.url}/api/uploads/1712345-data.json`, {
      headers: defaultHeaders,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
  });

  it("returns 404 for non-existent upload", async () => {
    const res = await fetch(`${server.url}/api/uploads/missing.txt`, {
      headers: defaultHeaders,
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 for path traversal attempt", async () => {
    const res = await fetch(`${server.url}/api/uploads/../../../etc/passwd`, {
      headers: defaultHeaders,
    });
    expect([400, 404]).toContain(res.status);
  });
});

// ---------------------------------------------------------------------------
// /api/shared/ — HTTP file serving for agent-shared files
// ---------------------------------------------------------------------------

describe("/api/shared/ — serving agent-shared files", () => {
  let server: ServerHandle;
  let tmpHome: string;
  const PARTITION = "test-workspace";

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));
    seedSettings(tmpHome, { tokenSecret: DEFAULT_TOKEN });

    // Pre-create shared files under a workspace partition
    const sharedDir = join(tmpHome, ".band", "shared", PARTITION);
    mkdirSync(sharedDir, { recursive: true });
    writeFileSync(join(sharedDir, "report.md"), "# Test Report\n\nHello world\n");
    writeFileSync(join(sharedDir, "image.png"), Buffer.from("fake-png-bytes"));

    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("serves a shared text file with correct content-type", async () => {
    const res = await fetch(`${server.url}/api/shared/${PARTITION}/report.md`, {
      headers: defaultHeaders,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown");
    const body = await res.text();
    expect(body).toContain("# Test Report");
  });

  it("serves a shared image file with correct content-type", async () => {
    const res = await fetch(`${server.url}/api/shared/${PARTITION}/image.png`, {
      headers: defaultHeaders,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  it("returns 404 for non-existent shared file", async () => {
    const res = await fetch(`${server.url}/api/shared/${PARTITION}/nonexistent.txt`, {
      headers: defaultHeaders,
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 when workspace partition is missing from URL", async () => {
    const res = await fetch(`${server.url}/api/shared/report.md`, {
      headers: defaultHeaders,
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for path traversal attempt", async () => {
    const res = await fetch(`${server.url}/api/shared/../../../etc/passwd`, {
      headers: defaultHeaders,
    });
    expect([400, 404]).toContain(res.status);
  });
});

// ---------------------------------------------------------------------------
// Task stream — Write to shared directory emits file event
// ---------------------------------------------------------------------------

describe("Task stream — Write to shared dir emits file event", () => {
  let server: ServerHandle;
  let tmpHome: string;
  const WORKSPACE_ID = "testproject-main";

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));

    const sharedDir = join(tmpHome, ".band", "shared", WORKSPACE_ID);

    // Scenario: agent writes a file to the workspace shared dir via the Write tool.
    // The _write_file directive creates the file on disk (simulating what the
    // real Write tool would do) so the task runner's directory scan finds it.
    const scenarioPath = writeScenario(tmpHome, [
      {
        type: "system",
        subtype: "init",
        session_id: "file-share-session",
      },
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "I'll create a report for you." },
            {
              type: "tool_use",
              id: "tool-write-shared",
              name: "Write",
              input: {
                file_path: `${sharedDir}/analysis.md`,
                content: "# Analysis\n\nResults here.\n",
              },
            },
          ],
        },
      },
      // Simulate the real tool creating the file on disk
      {
        _write_file: { path: `${sharedDir}/analysis.md`, content: "# Analysis\n\nResults here.\n" },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-write-shared",
              content: "File written successfully.",
              is_error: false,
            },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        session_id: "file-share-session",
        duration_ms: 500,
        num_turns: 1,
        total_cost_usd: 0.01,
      },
    ]);

    seedSettings(tmpHome, {
      tokenSecret: DEFAULT_TOKEN,
      codingAgents: [
        { id: "claude-code", type: "claude-code", label: "Claude Code", command: FAKE_AGENT_PATH },
      ],
    });

    server = await startServer({ tmpHome, scenarioPath });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("emits a file event when agent writes to the shared directory", async () => {
    const { submitRes, events } = await submitAndStream(
      server.url,
      WORKSPACE_ID,
      "create a report",
    );
    expect(submitRes.status).toBe(200);

    const eventTypes = events.map((e) => e.event);

    // Should contain the normal tool events plus a file event
    expect(eventTypes).toContain("tool-input-available");
    expect(eventTypes).toContain("tool-output-available");
    expect(eventTypes).toContain("file");

    // Verify the file event payload
    const fileEvent = events.find((e) => e.event === "file");
    const fileData = fileEvent!.data as Record<string, unknown>;
    expect(fileData.mediaType).toBe("text/markdown");
    expect(fileData.url).toBe(`/api/shared/${WORKSPACE_ID}/analysis.md`);
    expect(fileData.filename).toBe("analysis.md");
  });
});

// ---------------------------------------------------------------------------
// Task stream — Bash cp to shared directory emits file event
// ---------------------------------------------------------------------------

describe("Task stream — Bash cp to shared dir emits file event", () => {
  let server: ServerHandle;
  let tmpHome: string;
  const WORKSPACE_ID = "testproject-main";

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));

    const sharedDir = join(tmpHome, ".band", "shared", WORKSPACE_ID);

    // Scenario: agent copies a file to the workspace shared dir via Bash cp
    const scenarioPath = writeScenario(tmpHome, [
      {
        type: "system",
        subtype: "init",
        session_id: "bash-cp-session",
      },
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "I'll copy the file for you." },
            {
              type: "tool_use",
              id: "tool-bash-cp",
              name: "Bash",
              input: {
                command: `cp /tmp/source.png ${sharedDir}/shared-image.png`,
              },
            },
          ],
        },
      },
      // Simulate cp creating the file on disk
      { _write_file: { path: `${sharedDir}/shared-image.png`, content: "fake-png" } },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-bash-cp",
              content: "",
              is_error: false,
            },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        session_id: "bash-cp-session",
        duration_ms: 300,
        num_turns: 1,
        total_cost_usd: 0.01,
      },
    ]);

    seedSettings(tmpHome, {
      tokenSecret: DEFAULT_TOKEN,
      codingAgents: [
        { id: "claude-code", type: "claude-code", label: "Claude Code", command: FAKE_AGENT_PATH },
      ],
    });

    server = await startServer({ tmpHome, scenarioPath });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("emits a file event when agent uses Bash to copy a file to shared dir", async () => {
    const { submitRes, events } = await submitAndStream(server.url, WORKSPACE_ID, "copy the image");
    expect(submitRes.status).toBe(200);

    const eventTypes = events.map((e) => e.event);

    expect(eventTypes).toContain("tool-input-available");
    expect(eventTypes).toContain("tool-output-available");
    expect(eventTypes).toContain("file");

    const fileEvent = events.find((e) => e.event === "file");
    const fileData = fileEvent!.data as Record<string, unknown>;
    expect(fileData.mediaType).toBe("image/png");
    expect(fileData.url).toBe(`/api/shared/${WORKSPACE_ID}/shared-image.png`);
    expect(fileData.filename).toBe("shared-image.png");
  });
});

// ---------------------------------------------------------------------------
// Task stream — Write to non-shared directory does NOT emit file event
// ---------------------------------------------------------------------------

describe("Task stream — Write to workspace does NOT emit file event", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));

    // Scenario: agent writes a file to the workspace (NOT shared dir)
    const scenarioPath = writeScenario(tmpHome, [
      {
        type: "system",
        subtype: "init",
        session_id: "no-file-session",
      },
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Updating the code." },
            {
              type: "tool_use",
              id: "tool-write-workspace",
              name: "Write",
              input: {
                file_path: `${tmpHome}/myrepo/src/index.ts`,
                content: 'console.log("updated");\n',
              },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-write-workspace",
              content: "File written successfully.",
              is_error: false,
            },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        session_id: "no-file-session",
        duration_ms: 300,
        num_turns: 1,
        total_cost_usd: 0.01,
      },
    ]);

    seedSettings(tmpHome, {
      tokenSecret: DEFAULT_TOKEN,
      codingAgents: [
        { id: "claude-code", type: "claude-code", label: "Claude Code", command: FAKE_AGENT_PATH },
      ],
    });

    server = await startServer({ tmpHome, scenarioPath });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("does not emit a file event for writes outside the shared directory", async () => {
    const { submitRes, events } = await submitAndStream(
      server.url,
      "testproject-main",
      "update the code",
    );
    expect(submitRes.status).toBe(200);

    const eventTypes = events.map((e) => e.event);

    expect(eventTypes).toContain("tool-input-available");
    expect(eventTypes).toContain("tool-output-available");
    expect(eventTypes).not.toContain("file");
  });
});
