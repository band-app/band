/**
 * Dispatch approvals and task groups (plan step 6.3). The coordinator's agent is the scripted ACP stub: a
 * message to its chat makes it call `worktrees_create` through the MCP entry Band gave the session. The
 * project is in steer mode, so each call waits as a card on the project page until the user decides.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { acpStubEnv } from "./helpers/acp-stub";
import { gitInHome as git } from "./helpers/git";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { ProjectsPage } from "./pages/ProjectsPage";

test.use({ viewport: { width: 1280, height: 900 } });

const TOKEN = "e2e-dispatch-token";
const API = "api";
const CLIENT = "client";

let server: ServerHandle;
let tmpHome: string;
let coordinator: { worktreeId: string; chatId: string };

async function trpc<T>(procedure: string, input: unknown): Promise<T> {
  const res = await fetch(`${server.url}/trpc/${procedure}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `band_token=${TOKEN}` },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`${procedure}: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { result: { data: T } }).result.data;
}

function seedRepo(name: string) {
  const path = join(tmpHome, name);
  mkdirSync(path, { recursive: true });
  git(path, ["init", "-b", "main"], tmpHome);
  writeFileSync(join(path, "README.md"), `# ${name}\n`);
  git(path, ["add", "."], tmpHome);
  git(path, ["commit", "-m", "seed"], tmpHome);
  return { name, path, defaultBranch: "main", worktrees: [{ branch: "main", path }] };
}

/** A scripted turn in which the coordinator calls `worktrees_create` with `args`. */
const dispatchTurn = (match: string, args: object) => ({
  match,
  steps: [
    {
      mcpCall: { name: match, server: "band-coordinator", tool: "worktrees_create", args },
    },
    { say: "dispatch requested" },
  ],
});

/** Makes the coordinator of the shop project run its scripted turn named `text`. */
async function ask(text: string): Promise<void> {
  const res = await fetch(`${server.url}/api/chats/${coordinator.chatId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `band_token=${TOKEN}` },
    body: JSON.stringify({ worktreeId: coordinator.worktreeId, text }),
  });
  if (!res.ok) throw new Error(`send failed: ${res.status} ${await res.text()}`);
}

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedState(tmpHome, { repos: [seedRepo(API), seedRepo(CLIENT)] });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({
    tmpHome,
    env: {
      ...acpStubEnv(tmpHome, {
        turns: [
          dispatchTurn("^dispatch-one", {
            repo: API,
            branch: "feat-one",
            brief: "Do the first thing.",
            scenarios: ["it works"],
          }),
          dispatchTurn("^dispatch-two", {
            repo: API,
            branch: "feat-two",
            brief: "Do the second thing.",
            scenarios: ["it works"],
          }),
          dispatchTurn("^dispatch-group", {
            group: {
              repos: [{ repo: API }, { repo: CLIENT }],
              mode: "split",
              mergeOrder: [CLIENT, API],
            },
            branch: "feat-shared",
            title: "Shared change",
            brief: "Change both sides.",
            scenarios: ["both sides agree"],
          }),
          { steps: [{ say: "ok" }] },
        ],
      }),
      BAND_TEST_ACP_HTTP_LOG: join(tmpHome, "acp-http-log.jsonl"),
    },
  });
  const created = await trpc<{
    project: { coordinator: { worktreeId: string; chatId: string } };
  }>("projects.create", { name: "shop", repos: [{ repo: API }, { repo: CLIENT }] });
  coordinator = created.project.coordinator;
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test("a steer dispatch waits as a card, approving creates the worktree", async ({ page }) => {
  const projects = new ProjectsPage(page, server.url, TOKEN);
  await projects.goto();
  await projects.open();
  await projects.openProject("shop");
  await expect(projects.coordinator()).toHaveAttribute("data-state", "started");
  await expect(projects.noDispatches()).toBeVisible();

  await ask("dispatch-one");
  await expect(projects.dispatches()).toHaveCount(1, { timeout: 20_000 });
  await expect(projects.dispatches().first()).toContainText("feat-one");
  await expect(projects.worktree(`${API}-feat-one`)).toHaveCount(0);

  await projects.approveDispatch();
  await expect(projects.noDispatches()).toBeVisible();
  await expect(projects.worktree(`${API}-feat-one`)).toBeVisible();
});

test("rejecting a dispatch creates nothing", async ({ page }) => {
  const projects = new ProjectsPage(page, server.url, TOKEN);
  await projects.goto();
  await projects.open();
  await projects.openProject("shop");

  await ask("dispatch-two");
  await expect(projects.dispatches()).toHaveCount(1, { timeout: 20_000 });
  await expect(projects.dispatches().first()).toContainText("feat-two");

  await projects.rejectDispatch();
  await expect(projects.noDispatches()).toBeVisible();
  await expect(projects.worktree(`${API}-feat-two`)).toHaveCount(0);
});

test("an approved group shows on the project page with its merge order", async ({ page }) => {
  const projects = new ProjectsPage(page, server.url, TOKEN);
  await projects.goto();
  await projects.open();
  await projects.openProject("shop");

  await ask("dispatch-group");
  await expect(projects.dispatches()).toHaveCount(1, { timeout: 20_000 });
  await expect(projects.dispatches().first()).toContainText("Shared change");
  await projects.approveDispatch();

  await expect(projects.group("feat-shared")).toBeVisible();
  await expect(projects.groupMembers("feat-shared")).toHaveText([
    new RegExp(`^${CLIENT}, worktree ${CLIENT}-feat-shared`),
    new RegExp(`^${API}, worktree ${API}-feat-shared`),
  ]);
  await expect(projects.worktree(`${API}-feat-shared`)).toBeVisible();
  await expect(projects.worktree(`${CLIENT}-feat-shared`)).toBeVisible();
});
