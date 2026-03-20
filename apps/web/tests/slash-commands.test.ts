import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedState } from "./helpers/seed-state";

const PROJECT_ROOT = join(import.meta.dirname, "..");
const FAKE_AGENT_PATH = join(import.meta.dirname, "fake-agent.mjs");
const DEFAULT_TOKEN = "slash-test-token";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ServerHandle {
  url: string;
  home: string;
  close: () => Promise<void>;
}

function createTmpHome(): string {
  const tmp = mkdtempSync(join(tmpdir(), "band-test-slash-"));
  const bandDir = join(tmp, ".band");
  mkdirSync(bandDir, { recursive: true });
  mkdirSync(join(bandDir, "status"), { recursive: true });
  return tmp;
}

function seedSettings(tmpHome: string, settings: object): void {
  writeFileSync(join(tmpHome, ".band", "settings.json"), JSON.stringify(settings));
}

function createDefaultState(tmpHome: string) {
  const repoDir = join(tmpHome, "repo");
  mkdirSync(repoDir, { recursive: true });
  return {
    projects: [
      {
        name: "testproject",
        path: repoDir,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: repoDir }],
      },
    ],
  };
}

function defaultSettings() {
  return {
    tokenSecret: DEFAULT_TOKEN,
    codingAgent: {
      type: "claude-code",
      command: FAKE_AGENT_PATH,
    },
  };
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

/**
 * Seed skill directories in the temp HOME's ~/.claude/skills/ folder.
 */
function seedSkills(tmpHome: string, skills: Array<{ dirName: string; skillMd: string }>): void {
  const skillsDir = join(tmpHome, ".claude", "skills");
  mkdirSync(skillsDir, { recursive: true });
  for (const skill of skills) {
    const skillDir = join(skillsDir, skill.dirName);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), skill.skillMd);
  }
}

/**
 * Seed project-level skill directories inside a workspace's .claude/skills/ folder.
 */
function seedProjectSkills(
  repoDir: string,
  skills: Array<{ dirName: string; skillMd: string }>,
): void {
  const skillsDir = join(repoDir, ".claude", "skills");
  mkdirSync(skillsDir, { recursive: true });
  for (const skill of skills) {
    const skillDir = join(skillsDir, skill.dirName);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), skill.skillMd);
  }
}

async function startServer(
  opts: { tmpHome?: string; env?: Record<string, string> } = {},
): Promise<ServerHandle> {
  const home = opts.tmpHome || createTmpHome();
  const port = await getRandomPort();

  return new Promise((resolve, reject) => {
    const child = spawn("node", ["dist/start-server.mjs"], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: home,
        PORT: String(port),
        NODE_ENV: "production",
        FAKE_AGENT_SCENARIO: "",
        ...opts.env,
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

async function trpcQuery(
  serverUrl: string,
  procedure: string,
  input?: unknown,
  opts?: { headers?: Record<string, string> },
) {
  const url =
    input !== undefined
      ? `${serverUrl}/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`
      : `${serverUrl}/trpc/${procedure}`;
  return fetch(url, { headers: { ...defaultHeaders, ...opts?.headers } });
}

async function trpcData<T>(res: Response): Promise<T> {
  const body = (await res.json()) as { result: { data: T } };
  return body.result.data;
}

// ---------------------------------------------------------------------------
// skills.list — with seeded global skills
// ---------------------------------------------------------------------------

describe("skills.list — with seeded global skills", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));
    seedSettings(tmpHome, defaultSettings());

    seedSkills(tmpHome, [
      {
        dirName: "commit",
        skillMd: [
          "---",
          "name: commit",
          "description: Create a git commit with a message.",
          "argument-hint: -m <message>",
          "---",
          "",
          "# Commit Skill",
          "",
          "Creates a git commit.",
        ].join("\n"),
      },
      {
        dirName: "review-pr",
        skillMd: [
          "---",
          "name: review-pr",
          "description: Review a GitHub pull request.",
          "argument-hint: <pr-url>",
          "---",
          "",
          "# Review PR Skill",
        ].join("\n"),
      },
      {
        dirName: "no-description",
        skillMd: ["---", "name: no-description", "---", "", "# No Description"].join("\n"),
      },
    ]);

    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns parsed skills from SKILL.md files", async () => {
    const res = await trpcQuery(server.url, "skills.list", {
      workspaceId: "testproject-main",
    });
    expect(res.status).toBe(200);

    const data = await trpcData<{
      skills: Array<{ name: string; description: string; argumentHint?: string }>;
    }>(res);

    expect(data.skills).toBeInstanceOf(Array);
    expect(data.skills.length).toBe(2); // no-description skill is excluded

    const commit = data.skills.find((s) => s.name === "commit");
    expect(commit).toBeDefined();
    expect(commit!.description).toBe("Create a git commit with a message.");
    expect(commit!.argumentHint).toBe("-m <message>");

    const reviewPr = data.skills.find((s) => s.name === "review-pr");
    expect(reviewPr).toBeDefined();
    expect(reviewPr!.description).toBe("Review a GitHub pull request.");
    expect(reviewPr!.argumentHint).toBe("<pr-url>");
  });

  it("returns skills sorted alphabetically by name", async () => {
    const res = await trpcQuery(server.url, "skills.list", {
      workspaceId: "testproject-main",
    });
    const data = await trpcData<{
      skills: Array<{ name: string }>;
    }>(res);

    const names = data.skills.map((s) => s.name);
    expect(names).toEqual(["commit", "review-pr"]);
  });
});

// ---------------------------------------------------------------------------
// skills.list — no skills directory
// ---------------------------------------------------------------------------

describe("skills.list — no skills directory", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));
    seedSettings(tmpHome, defaultSettings());
    // Do NOT seed any skills
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns empty array when skills directory does not exist", async () => {
    const res = await trpcQuery(server.url, "skills.list", {
      workspaceId: "testproject-main",
    });
    expect(res.status).toBe(200);

    const data = await trpcData<{
      skills: Array<{ name: string; description: string; argumentHint?: string }>;
    }>(res);

    expect(data.skills).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// skills.list — project-level skills override global
// ---------------------------------------------------------------------------

describe("skills.list — project-level skills", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    const state = createDefaultState(tmpHome);
    seedState(tmpHome, state);
    seedSettings(tmpHome, defaultSettings());

    // Seed a global skill
    seedSkills(tmpHome, [
      {
        dirName: "deploy",
        skillMd: ["---", "name: deploy", "description: Deploy to production (global).", "---"].join(
          "\n",
        ),
      },
    ]);

    // Seed a project-level skill that overrides a global one
    const repoDir = join(tmpHome, "repo");
    seedProjectSkills(repoDir, [
      {
        dirName: "deploy",
        skillMd: [
          "---",
          "name: deploy",
          "description: Deploy to staging (project-level).",
          "---",
        ].join("\n"),
      },
      {
        dirName: "lint",
        skillMd: ["---", "name: lint", "description: Run project linter.", "---"].join("\n"),
      },
    ]);

    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("project-level skill overrides global skill with same name", async () => {
    const res = await trpcQuery(server.url, "skills.list", {
      workspaceId: "testproject-main",
    });
    expect(res.status).toBe(200);

    const data = await trpcData<{
      skills: Array<{ name: string; description: string }>;
    }>(res);

    const deploy = data.skills.find((s) => s.name === "deploy");
    expect(deploy).toBeDefined();
    expect(deploy!.description).toBe("Deploy to staging (project-level).");
  });

  it("includes both global and project-level skills", async () => {
    const res = await trpcQuery(server.url, "skills.list", {
      workspaceId: "testproject-main",
    });
    const data = await trpcData<{
      skills: Array<{ name: string }>;
    }>(res);

    const names = data.skills.map((s) => s.name);
    expect(names).toEqual(["deploy", "lint"]);
  });
});

// ---------------------------------------------------------------------------
// skills.list — unknown workspace
// ---------------------------------------------------------------------------

describe("skills.list — unknown workspace", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));
    seedSettings(tmpHome, defaultSettings());
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns empty array for non-existent workspace", async () => {
    const res = await trpcQuery(server.url, "skills.list", {
      workspaceId: "nonexistent-main",
    });
    expect(res.status).toBe(200);

    const data = await trpcData<{
      skills: Array<{ name: string }>;
    }>(res);

    expect(data.skills).toEqual([]);
  });
});
