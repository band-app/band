import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings, seedState } from "./helpers/seed-state";

const PROJECT_ROOT = join(import.meta.dirname, "..");
const FAKE_AGENT_PATH = join(import.meta.dirname, "fake-agent.mjs");
const DEFAULT_TOKEN = "session-history-test-token";
const SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

// Tool types found in the real cloudflared-tunnel session
const TOOL_NAMES = ["Task", "Bash", "Read", "Write", "Edit", "Grep", "TodoWrite"] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ServerHandle {
  url: string;
  home: string;
  close: () => Promise<void>;
}

function createTmpHome(): string {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "band-session-test-")));
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
  const port = await getRandomPort();

  return new Promise((resolve, reject) => {
    const child = spawn("node", ["dist/start-server.mjs"], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: opts.tmpHome,
        PORT: String(port),
        NODE_ENV: "production",
        FAKE_AGENT_SCENARIO: "",
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
          home: opts.tmpHome,
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

async function trpcData<T>(res: Response): Promise<T> {
  const body = (await res.json()) as { result: { data: T } };
  return body.result.data;
}

// ---------------------------------------------------------------------------
// Session fixture builder
// ---------------------------------------------------------------------------

/**
 * Encode a filesystem path to the Claude projects directory name.
 * The SDK uses: path.replace(/[^a-zA-Z0-9]/g, "-")
 */
function encodeProjectPath(dir: string): string {
  return dir.replace(/[^a-zA-Z0-9]/g, "-");
}

interface SessionMessage {
  type: string;
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  message?: { content: unknown[] };
  [key: string]: unknown;
}

/**
 * Build a minimal session JSONL that covers all the given tool names.
 * Returns JSONL string with proper parentUuid chain.
 */
function buildSessionFixture(toolNames: readonly string[]): string {
  const messages: SessionMessage[] = [];
  let parentUuid: string | null = null;

  // Initial user message
  const userUuid = "00000000-0000-0000-0000-000000000001";
  messages.push({
    type: "user",
    uuid: userUuid,
    parentUuid: null,
    sessionId: SESSION_ID,
    isSidechain: false,
    userType: "external",
    message: { content: [{ type: "text", text: "implement the feature" }] },
    timestamp: "2026-03-12T08:00:00.000Z",
  });
  parentUuid = userUuid;

  // One tool_use + tool_result pair per tool
  for (let i = 0; i < toolNames.length; i++) {
    const toolName = toolNames[i];
    const toolId = `toolu_${String(i + 1).padStart(4, "0")}`;
    const assistantUuid = `10000000-0000-0000-0000-${String(i + 1).padStart(12, "0")}`;
    const resultUuid = `20000000-0000-0000-0000-${String(i + 1).padStart(12, "0")}`;

    messages.push({
      type: "assistant",
      uuid: assistantUuid,
      parentUuid,
      sessionId: SESSION_ID,
      isSidechain: false,
      message: {
        content: [
          {
            type: "tool_use",
            id: toolId,
            name: toolName,
            input: { placeholder: true },
          },
        ],
      },
      timestamp: `2026-03-12T08:00:${String((i + 1) * 2).padStart(2, "0")}.000Z`,
    });

    messages.push({
      type: "user",
      uuid: resultUuid,
      parentUuid: assistantUuid,
      sessionId: SESSION_ID,
      isSidechain: false,
      userType: "tool_result",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: toolId,
            content: `result of ${toolName}`,
            is_error: false,
          },
        ],
      },
      timestamp: `2026-03-12T08:00:${String((i + 1) * 2 + 1).padStart(2, "0")}.000Z`,
    });

    parentUuid = resultUuid;
  }

  // Final assistant text
  messages.push({
    type: "assistant",
    uuid: "30000000-0000-0000-0000-000000000001",
    parentUuid,
    sessionId: SESSION_ID,
    isSidechain: false,
    message: { content: [{ type: "text", text: "All done!" }] },
    timestamp: "2026-03-12T08:01:00.000Z",
  });

  return `${messages.map((m) => JSON.stringify(m)).join("\n")}\n`;
}

/**
 * Seed a Claude Code session JSONL file in the expected location.
 */
function seedSessionFile(
  tmpHome: string,
  workspacePath: string,
  sessionId: string,
  content: string,
): void {
  const encoded = encodeProjectPath(workspacePath);
  const projectDir = join(tmpHome, ".claude", "projects", encoded);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, `${sessionId}.jsonl`), content);
}

// ---------------------------------------------------------------------------
// Test: session history tool name resolution
// ---------------------------------------------------------------------------

describe("sessions.messages — tool name resolution", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let repoDir: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    repoDir = join(tmpHome, "repo");
    mkdirSync(repoDir, { recursive: true });

    seedState(tmpHome, {
      projects: [
        {
          name: "testproject",
          path: repoDir,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: repoDir }],
        },
      ],
    });
    seedSettings(tmpHome, {
      tokenSecret: DEFAULT_TOKEN,
      codingAgent: { type: "claude-code", command: FAKE_AGENT_PATH },
    });

    // Seed the session JSONL in the expected Claude projects directory
    const fixture = buildSessionFixture(TOOL_NAMES);
    seedSessionFile(tmpHome, repoDir, SESSION_ID, fixture);

    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("resolves every tool_use block to its correct tool name", async () => {
    const res = await trpcQuery(server.url, "sessions.messages", {
      workspaceId: "testproject-main",
      sessionId: SESSION_ID,
    });
    expect(res.status).toBe(200);

    const data = await trpcData<{
      messages: Array<{
        role: string;
        content: Array<{
          type: string;
          toolName?: string;
          toolCallId?: string;
        }>;
      }>;
    }>(res);

    const toolUseBlocks = data.messages.flatMap((m) =>
      m.content.filter((b) => b.type === "tool_use"),
    );

    // We should have one tool_use block per tool name
    expect(toolUseBlocks.length).toBe(TOOL_NAMES.length);

    // Every tool_use block must have a proper tool name (not "unknown", "tool", or empty)
    const resolvedNames = toolUseBlocks.map((b) => b.toolName);
    for (const name of resolvedNames) {
      expect(name).toBeDefined();
      expect(name).not.toBe("unknown");
      expect(name).not.toBe("tool");
      expect(name).not.toBe("");
    }

    // Verify the exact tool names match what was in the session
    expect(resolvedNames).toEqual([...TOOL_NAMES]);
  });

  it("pairs every tool_use with a matching tool_result", async () => {
    const res = await trpcQuery(server.url, "sessions.messages", {
      workspaceId: "testproject-main",
      sessionId: SESSION_ID,
    });
    const data = await trpcData<{
      messages: Array<{
        role: string;
        content: Array<{
          type: string;
          toolCallId?: string;
        }>;
      }>;
    }>(res);

    const toolUseIds = new Set(
      data.messages
        .flatMap((m) => m.content)
        .filter((b) => b.type === "tool_use")
        .map((b) => b.toolCallId),
    );
    const toolResultIds = new Set(
      data.messages
        .flatMap((m) => m.content)
        .filter((b) => b.type === "tool_result")
        .map((b) => b.toolCallId),
    );

    // Every tool_use should have a corresponding tool_result
    for (const id of toolUseIds) {
      expect(toolResultIds.has(id)).toBe(true);
    }
  });
});
