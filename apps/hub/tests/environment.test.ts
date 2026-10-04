// Integration tests for `.band/environment.json` (plan step 3.1): a workspace
// runs the file's install and start and opens its terminals, the file wins over
// `.band/config.json`, a repo with only config.json still works, and
// `environment.forProject` / `environment.validate` report the parsed file, its
// problems and which hosts meet `requires`.
//
// Real production server, real git repo, real PTYs, real SQLite, temp BAND_HOME.

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toWorkspaceId } from "@band-app/shared/workspace-id";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";
import { waitFor } from "./helpers/wait-for";

const TOKEN = "environment-test-token";

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

function createRepo(parent: string, name: string, files: Record<string, string>): string {
  const repo = join(parent, name);
  mkdirSync(join(repo, ".band"), { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, env: gitEnv });
  writeFileSync(join(repo, "README.md"), "# env test\n");
  execFileSync("git", ["add", "."], { cwd: repo, env: gitEnv });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repo, env: gitEnv });
  // Written after the commit, so they are untracked and a new worktree reads
  // them from the project checkout.
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(repo, file, ".."), { recursive: true });
    writeFileSync(join(repo, file), text);
  }
  return repo;
}

let home: string;
let server: ServerHandle;

const query = async <T>(procedure: string, input: unknown): Promise<T> => {
  const res = await trpcQuery(server.url, procedure, input, TOKEN);
  const body = await res.clone().text();
  expect(res.status, body).toBe(200);
  return trpcData<T>(res);
};

async function createWorkspace(project: string, branch: string): Promise<string> {
  const res = await trpcMutate(server.url, "workspaces.create", { project, branch }, TOKEN);
  const body = await res.text();
  expect(res.status, body).toBe(200);
  return toWorkspaceId(project, branch);
}

async function terminalOutputs(workspaceId: string): Promise<string[]> {
  const { terminals } = await query<{ terminals: { terminalId: string }[] }>("terminal.list", {
    workspaceId,
  });
  return Promise.all(
    terminals.map(
      async (t) =>
        (await query<{ output: string }>("terminal.output", { terminalId: t.terminalId })).output,
    ),
  );
}

const waitForOutput = (workspaceId: string, marker: string) =>
  waitFor(
    async () =>
      (await terminalOutputs(workspaceId)).some((o) => o.includes(marker)) ? true : undefined,
    { label: `terminal output containing ${marker}`, timeoutMs: 20_000 },
  );

const PROJECTS = {
  envproj: {
    ".band/environment.json": JSON.stringify({
      install: "echo ENV-INSTALL-$((1+1))",
      start: "echo ENV-START-$((1+1))",
      terminals: [{ name: "dev", command: "echo ENV-DEV-$((1+1))" }],
      requires: { node: ">=99" },
    }),
    // The environment wins over this.
    ".band/config.json": JSON.stringify({ setup: "echo OLD-CONFIG-SETUP" }),
  },
  configproj: {
    ".band/config.json": JSON.stringify({ setup: "echo CONFIG-ONLY-$((1+1))" }),
  },
  brokenproj: {
    ".band/environment.json": JSON.stringify({
      build: { devcontainer: ".devcontainer/devcontainer.json" },
    }),
  },
  badshapeproj: {
    ".band/environment.json": JSON.stringify({ isolation: "docker", instal: "x" }),
    ".band/config.json": JSON.stringify({ setup: "echo FALLBACK-$((1+1))" }),
  },
  plainproj: {},
};

beforeAll(async () => {
  home = createTmpHome("band-environment-");
  const repos = Object.entries(PROJECTS).map(([name, files]) => ({
    name,
    path: createRepo(home, name, files),
  }));
  seedState(home, {
    projects: repos.map(({ name, path }) => ({
      name,
      path,
      defaultBranch: "main",
      worktrees: [{ branch: "main", path }],
    })),
  });
  seedSettings(home, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome: home });
}, 120_000);

afterAll(async () => {
  await server?.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("workspace setup from environment.json", () => {
  it("runs install then start, then opens the declared terminals", async () => {
    const workspaceId = await createWorkspace("envproj", "feat/one");
    await waitForOutput(workspaceId, "ENV-START-2");
    const outputs = await terminalOutputs(workspaceId);
    const setup = outputs.find((o) => o.includes("ENV-INSTALL-2"));
    expect(setup).toContain("ENV-START-2");
    expect(outputs.some((o) => o.includes("OLD-CONFIG-SETUP"))).toBe(false);
    await waitForOutput(workspaceId, "ENV-DEV-2");
  });

  it("still runs the setup of a repo that has only config.json", async () => {
    const workspaceId = await createWorkspace("configproj", "feat/one");
    await waitForOutput(workspaceId, "CONFIG-ONLY-2");
  });

  it("ignores an environment.json with problems and falls back to config.json", async () => {
    const workspaceId = await createWorkspace("badshapeproj", "feat/one");
    await waitForOutput(workspaceId, "FALLBACK-2");
  });
});

describe("environment.forProject", () => {
  type View = {
    source: string | null;
    environment: { install?: string } | null;
    issues: { path: string; message: string }[];
    hosts: { id: string; meets: boolean; unmet: { tool: string; range: string }[] }[];
  };

  it("returns the parsed file and the hosts that miss its requires", async () => {
    const view = await query<View>("environment.forProject", { projectName: "envproj" });
    expect(view.source).toMatch(/envproj\/\.band\/environment\.json$/);
    expect(view.environment?.install).toBe("echo ENV-INSTALL-$((1+1))");
    expect(view.issues).toEqual([]);
    const local = view.hosts.find((h) => h.id === "local");
    expect(local?.meets).toBe(false);
    expect(local?.unmet).toMatchObject([{ tool: "node", range: ">=99" }]);
  });

  it("names a devcontainer file that does not exist", async () => {
    const view = await query<View>("environment.forProject", { projectName: "brokenproj" });
    expect(view.environment).toBeNull();
    expect(view.issues.map((i) => i.path)).toEqual(["build.devcontainer"]);
    expect(view.hosts).toEqual([]);
  });

  it("reports the path of each problem", async () => {
    const view = await query<View>("environment.forProject", { projectName: "badshapeproj" });
    expect(view.issues.map((i) => i.path).sort()).toEqual(["instal", "isolation"]);
  });

  it("reports no file for a project without one", async () => {
    const view = await query<View>("environment.forProject", { projectName: "plainproj" });
    expect(view).toMatchObject({ source: null, environment: null, issues: [], hosts: [] });
  });

  it("answers 404 for an unknown project", async () => {
    const res = await trpcQuery(
      server.url,
      "environment.forProject",
      { projectName: "nope" },
      TOKEN,
    );
    expect(res.status).toBe(404);
  });
});

describe("environment.validate", () => {
  it("validates a directory, or the file itself", async () => {
    const dir = join(home, "badshapeproj");
    const byDir = await query<{ issues: unknown[] }>("environment.validate", { path: dir });
    const byFile = await query<{ issues: unknown[] }>("environment.validate", {
      path: join(dir, ".band", "environment.json"),
    });
    expect(byDir.issues).toHaveLength(2);
    expect(byFile).toEqual(byDir);
  });
});

describe("authorization", () => {
  it("answers 401 without a token", async () => {
    for (const [procedure, input] of [
      ["environment.forProject", { projectName: "envproj" }],
      ["environment.validate", { path: join(home, "envproj") }],
    ] as const) {
      const res = await trpcQuery(server.url, procedure, input, undefined);
      expect(res.status, procedure).toBe(401);
    }
  });

  it("refuses environment.validate to a non-admin device token", async () => {
    const created = await trpcMutate(server.url, "tokens.createDevice", { label: "phone" }, TOKEN);
    expect(created.status).toBe(200);
    const { token } = await trpcData<{ token: string }>(created);
    const res = await trpcQuery(
      server.url,
      "environment.validate",
      { path: join(home, "envproj") },
      token,
    );
    expect(res.status).toBe(403);
  });
});

describe("hosts.list", () => {
  it("reports the local host's tool versions", async () => {
    const { hosts } = await query<{ hosts: { id: string; tools: Record<string, string> }[] }>(
      "hosts.list",
      {},
    );
    const local = hosts.find((h) => h.id === "local");
    expect(local?.tools.node).toMatch(/^\d+\.\d+\.\d+$/);
    expect(local?.tools.git).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
