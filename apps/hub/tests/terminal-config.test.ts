import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings, seedState } from "./helpers/seed-state";
import { SERVER_RUNTIME, SERVER_SCRIPT } from "./helpers/server-runtime";

const PROJECT_ROOT = join(import.meta.dirname, "..");
const DEFAULT_TOKEN = "terminal-config-test-token";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ServerHandle {
  url: string;
  home: string;
  close: () => Promise<void>;
}

function createTmpHome(): string {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "band-terminal-config-test-")));
  mkdirSync(join(tmp, ".band"), { recursive: true });
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

async function startServer(
  opts: { tmpHome?: string; env?: Record<string, string> } = {},
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
// Git helpers
// ---------------------------------------------------------------------------

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf-8" });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("workspace.getTerminalConfig", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let repoPath: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();

    // Create a git repo
    repoPath = join(tmpHome, "repo");
    mkdirSync(repoPath, { recursive: true });
    git(repoPath, ["init", "-b", "main"]);
    writeFileSync(join(repoPath, "README.md"), "# Test\n");
    git(repoPath, ["add", "."]);
    git(repoPath, ["commit", "-m", "initial commit"]);

    seedState(tmpHome, {
      projects: [
        {
          name: "repo",
          path: repoPath,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: repoPath }],
        },
      ],
    });
    seedSettings(tmpHome, {
      tokenSecret: DEFAULT_TOKEN,
      worktreesDir: join(tmpHome, ".band", "worktrees"),
    });
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns null when no config exists", async () => {
    const res = await trpcQuery(server.url, "workspace.getTerminalConfig", {
      workspaceId: "repo-main",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ config: null }>(res);
    expect(data.config).toBeNull();
  });

  it("returns null when config has no workspace.terminal block", async () => {
    // Write a config without workspace.terminal
    const configDir = join(repoPath, ".band");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), JSON.stringify({ setup: "npm install" }));

    const res = await trpcQuery(server.url, "workspace.getTerminalConfig", {
      workspaceId: "repo-main",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ config: null }>(res);
    expect(data.config).toBeNull();
  });

  it("returns parsed config with a single pane layout", async () => {
    const terminalConfig = {
      workspace: {
        terminal: {
          layout: {
            pane: {
              name: "shell",
              command: "echo hello",
            },
          },
        },
      },
    };

    const configDir = join(repoPath, ".band");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), JSON.stringify(terminalConfig));

    const res = await trpcQuery(server.url, "workspace.getTerminalConfig", {
      workspaceId: "repo-main",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{
      config: {
        layout: { pane: { name: string; command: string } };
      };
    }>(res);
    expect(data.config).not.toBeNull();
    expect(data.config.layout).toHaveProperty("pane");
    expect((data.config.layout as { pane: { name: string } }).pane.name).toBe("shell");
    expect((data.config.layout as { pane: { command: string } }).pane.command).toBe("echo hello");
  });

  it("returns parsed config with nested splits", async () => {
    const terminalConfig = {
      workspace: {
        terminal: {
          layout: {
            direction: "horizontal",
            split: 0.5,
            children: [
              {
                pane: {
                  name: "dev server",
                  command: "npm run dev",
                  cwd: ".",
                },
              },
              {
                direction: "vertical",
                split: 0.5,
                children: [
                  {
                    pane: {
                      name: "tests",
                      command: "npm run test:watch",
                    },
                  },
                  {
                    pane: {
                      name: "shell",
                      focus: true,
                    },
                  },
                ],
              },
            ],
          },
        },
      },
    };

    const configDir = join(repoPath, ".band");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), JSON.stringify(terminalConfig));

    const res = await trpcQuery(server.url, "workspace.getTerminalConfig", {
      workspaceId: "repo-main",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{
      config: {
        layout: {
          direction: string;
          split: number;
          children: unknown[];
        };
      };
    }>(res);
    expect(data.config).not.toBeNull();
    expect(data.config.layout.direction).toBe("horizontal");
    expect(data.config.layout.split).toBe(0.5);
    expect(data.config.layout.children).toHaveLength(2);
  });

  it("returns config with pane env and cwd", async () => {
    const terminalConfig = {
      workspace: {
        terminal: {
          layout: {
            pane: {
              name: "dev",
              command: "npm start",
              cwd: "./packages/api",
              env: { PORT: "4000", NODE_ENV: "development" },
            },
          },
        },
      },
    };

    const configDir = join(repoPath, ".band");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), JSON.stringify(terminalConfig));

    const res = await trpcQuery(server.url, "workspace.getTerminalConfig", {
      workspaceId: "repo-main",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{
      config: {
        layout: {
          pane: {
            name: string;
            cwd: string;
            env: Record<string, string>;
          };
        };
      };
    }>(res);
    expect(data.config.layout.pane.cwd).toBe("./packages/api");
    expect(data.config.layout.pane.env).toEqual({ PORT: "4000", NODE_ENV: "development" });
  });

  it("returns null for invalid config (malformed layout)", async () => {
    const invalidConfig = {
      workspace: {
        terminal: {
          layout: {
            direction: "horizontal",
            // Missing children
          },
        },
      },
    };

    const configDir = join(repoPath, ".band");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), JSON.stringify(invalidConfig));

    const res = await trpcQuery(server.url, "workspace.getTerminalConfig", {
      workspaceId: "repo-main",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ config: null }>(res);
    expect(data.config).toBeNull();
  });

  it("returns null for invalid split value", async () => {
    const invalidConfig = {
      workspace: {
        terminal: {
          layout: {
            direction: "horizontal",
            split: 1.5, // Out of range (should be 0.1–0.9)
            children: [{ pane: { name: "a" } }, { pane: { name: "b" } }],
          },
        },
      },
    };

    const configDir = join(repoPath, ".band");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), JSON.stringify(invalidConfig));

    const res = await trpcQuery(server.url, "workspace.getTerminalConfig", {
      workspaceId: "repo-main",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ config: null }>(res);
    expect(data.config).toBeNull();
  });

  it("returns null for unknown workspace", async () => {
    const res = await trpcQuery(server.url, "workspace.getTerminalConfig", {
      workspaceId: "nonexistent-branch",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ config: null }>(res);
    expect(data.config).toBeNull();
  });

  it("applies default split value of 0.5 when split is omitted", async () => {
    const terminalConfig = {
      workspace: {
        terminal: {
          layout: {
            direction: "vertical",
            // split omitted — should default to 0.5
            children: [{ pane: { name: "left" } }, { pane: { name: "right" } }],
          },
        },
      },
    };

    const configDir = join(repoPath, ".band");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), JSON.stringify(terminalConfig));

    const res = await trpcQuery(server.url, "workspace.getTerminalConfig", {
      workspaceId: "repo-main",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{
      config: {
        layout: { direction: string; split: number; children: unknown[] };
      };
    }>(res);
    expect(data.config.layout.split).toBe(0.5);
  });
});
