/**
 * The project dashboard (plan step 6.6): agents with live status, task groups with each member's PR and CI
 * state in merge order, pending approvals and the quick actions. The coordinator's agent is the scripted ACP
 * stub (a message makes it call `worktrees_create`, or hold a turn until it is stopped). `gh` is the Express
 * stub, answering the branch-status poller's query for the PRs. No tRPC mocking.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  branchRepository,
  prNode,
  workflowSuite,
} from "../../hub/tests/fixtures/branch-status-data";
import { type GhStub, ghStub } from "../../hub/tests/fixtures/gh-stub";
import { FAKE_REPO } from "../../hub/tests/fixtures/github-review-data";
import { acpStubEnv } from "./helpers/acp-stub";
import { git, gitCommit } from "./helpers/git";
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
// The tests share one server and the second needs the workers the first dispatched.
test.describe.configure({ mode: "serial" });

const TOKEN = "e2e-dashboard-token";
const API = "api";
const CLIENT = "client";
const BRANCH = "feat-shared";
const CLIENT_COORDS = { owner: FAKE_REPO.owner, name: "client-repo" };

let server: ServerHandle;
let stub: GhStub;
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

function seedRepo(name: string, coords: { owner: string; name: string }) {
  const path = join(tmpHome, name);
  mkdirSync(path, { recursive: true });
  git(path, ["init", "-b", "main"]);
  writeFileSync(join(path, "README.md"), `# ${name}\n`);
  gitCommit(path, "init");
  git(path, ["remote", "add", "origin", `https://github.com/${coords.owner}/${coords.name}.git`]);
  return { name, path, defaultBranch: "main", worktrees: [{ branch: "main", path }] };
}

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
  seedState(tmpHome, {
    repos: [seedRepo(API, FAKE_REPO), seedRepo(CLIENT, CLIENT_COORDS)],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  stub = await ghStub.start();
  stub.setBranchStatusQuery(FAKE_REPO, (branch) =>
    branch === BRANCH
      ? branchRepository({
          pullRequests: [prNode({ number: 201, title: "api side" })],
          suites: [workflowSuite({ workflow: "CI", conclusion: "SUCCESS" })],
        })
      : undefined,
  );
  stub.setBranchStatusQuery(CLIENT_COORDS, (branch) =>
    branch === BRANCH
      ? branchRepository({
          pullRequests: [prNode({ number: 101, title: "client side" })],
          suites: [workflowSuite({ workflow: "CI", conclusion: "FAILURE" })],
        })
      : undefined,
  );
  server = await startServer({
    tmpHome,
    env: {
      ...stub.env,
      ...acpStubEnv(tmpHome, {
        turns: [
          {
            match: "^dispatch-group",
            steps: [
              {
                mcpCall: {
                  name: "dispatch-group",
                  server: "band-coordinator",
                  tool: "worktrees_create",
                  args: {
                    group: {
                      repos: [{ repo: API }, { repo: CLIENT }],
                      mode: "split",
                      mergeOrder: [CLIENT, API],
                    },
                    branch: BRANCH,
                    title: "Shared change",
                    brief: "Change both sides.",
                    scenarios: ["both sides agree"],
                  },
                },
              },
              { say: "dispatch requested" },
            ],
          },
          { match: "^hold", steps: [{ waitForCancel: true }] },
          { steps: [{ say: "ok" }] },
        ],
      }),
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
  await server?.close();
  await stub?.stop();
  cleanupTmpHome(tmpHome);
});

test("an approved group shows both PRs with CI state in merge order, and approving works from the dashboard", async ({
  page,
}) => {
  // The branch-status poller ticks about 30 s apart, longer than the default 30 s test timeout.
  test.setTimeout(150_000);
  const projects = new ProjectsPage(page, server.url, TOKEN);
  await projects.goto();
  await projects.open();
  await projects.openProject("shop");

  await ask("dispatch-group");
  await expect(projects.dashboardApprovals()).toHaveCount(1, { timeout: 20_000 });
  await projects.approveFromDashboard();
  await expect(projects.dashboardApprovals()).toHaveCount(0);

  await expect(projects.dashboardMembers()).toHaveCount(2);
  await expect(projects.dashboardMembers().nth(0)).toHaveAttribute("data-repo", CLIENT);
  await expect(projects.dashboardMembers().nth(1)).toHaveAttribute("data-repo", API);
  await expect(projects.dashboardMember(CLIENT)).toContainText("PR #101", { timeout: 60_000 });
  await expect(projects.dashboardMember(CLIENT)).toHaveAttribute("data-ci", "failure");
  await expect(projects.dashboardMember(API)).toContainText("PR #201", { timeout: 60_000 });
  await expect(projects.dashboardMember(API)).toHaveAttribute("data-ci", "success");
});

test("agents list the coordinator and workers, and a running agent can be stopped", async ({
  page,
}) => {
  const projects = new ProjectsPage(page, server.url, TOKEN);
  await projects.goto();
  await projects.open();
  await projects.openProject("shop");

  await expect(projects.dashboardAgent("coordinator")).toHaveCount(1);
  await expect(projects.dashboardAgent("worker").first()).toBeVisible({ timeout: 20_000 });

  await ask("hold");
  await expect(projects.dashboardAgent("coordinator")).toHaveAttribute("data-status", "running", {
    timeout: 20_000,
  });
  await projects.stopAgent("coordinator");
  await expect(projects.dashboardAgent("coordinator")).toHaveAttribute("data-status", "idle", {
    timeout: 20_000,
  });
});
