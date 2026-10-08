/**
 * Dispatch from the coordinator. Its agent is the scripted ACP stub: a message to its chat makes it
 * call `worktree_create` through the MCP entry Band gave the session. The project is autonomous,
 * so each call creates a worktree of one repo at once, and work in two repos is two calls.
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

/** A scripted turn in which the coordinator calls `worktree_create` once per entry of `calls`. */
const dispatchTurn = (match: string, calls: object[]) => ({
  match,
  steps: [
    ...calls.map((args, i) => ({
      mcpCall: {
        name: `${match}-${i}`,
        server: "band-coordinator",
        tool: "worktree_create",
        args,
      },
    })),
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
          dispatchTurn("^dispatch-one", [
            {
              repo: API,
              branch: "feat-one",
              brief: "Do the first thing.",
              scenarios: ["it works"],
            },
          ]),
          dispatchTurn("^dispatch-pair", [
            {
              repo: CLIENT,
              branch: "feat-shared",
              title: "Shared change",
              brief: "Change the client side.",
            },
            { repo: API, branch: "feat-shared", title: "Shared change", brief: "Change the API." },
          ]),
          { steps: [{ say: "ok" }] },
        ],
      }),
      BAND_TEST_ACP_HTTP_LOG: join(tmpHome, "acp-http-log.jsonl"),
    },
  });
  const created = await trpc<{
    project: { id: string; coordinator: { chatId: string } };
  }>("projects.create", { name: "shop", repos: [{ repo: API }, { repo: CLIENT }] });
  // The coordinator has no worktree. Its turns are keyed by the project's scope id.
  coordinator = {
    worktreeId: `project:${created.project.id}`,
    chatId: created.project.coordinator.chatId,
  };
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test("a dispatch creates a worktree in the project at once, with no approval", async ({ page }) => {
  const projects = new ProjectsPage(page, server.url, TOKEN);
  await projects.gotoProject("shop");
  await expect(projects.coordinator()).toHaveAttribute("data-state", "started");

  await ask("dispatch-one");
  await expect(projects.worktree(`${API}-feat-one`)).toBeVisible({ timeout: 20_000 });
  await expect(projects.sidebarWorktrees("shop")).toHaveCount(1);
});

test("work in two repos is one worker per repo, each listed under the project", async ({
  page,
}) => {
  const projects = new ProjectsPage(page, server.url, TOKEN);
  await projects.gotoProject("shop");

  await ask("dispatch-pair");
  await expect(projects.worktree(`${API}-feat-shared`)).toBeVisible({ timeout: 20_000 });
  await expect(projects.worktree(`${CLIENT}-feat-shared`)).toBeVisible();

  // The coordinator is subscribed to its workers, and a worker finishing its first turn shows as a wake-up.
  await projects.showTab("activity");
  await expect(projects.subscriptions()).toHaveCount(1);
  await expect(projects.subscriptions().first()).toHaveAttribute("data-kind", "project");
  await expect(projects.wakeups().filter({ hasText: "finished its turn" }).first()).toBeVisible({
    timeout: 30_000,
  });
});
