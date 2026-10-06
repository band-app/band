/**
 * The scheduled retro (plan step 6.5). The retro agent is the scripted ACP stub: its turn calls
 * `retro_propose` through the MCP entry Band gave the session. The project page shows the schedule and,
 * after a run, each proposed edit with its diff to accept or reject.
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

const TOKEN = "e2e-retro-token";
const API = "api";

let server: ServerHandle;
let tmpHome: string;

async function trpc<T>(procedure: string, input: unknown): Promise<T> {
  const res = await fetch(`${server.url}/trpc/${procedure}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `band_token=${TOKEN}` },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`${procedure}: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { result: { data: T } }).result.data;
}

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const path = join(tmpHome, API);
  mkdirSync(path, { recursive: true });
  git(path, ["init", "-b", "main"], tmpHome);
  writeFileSync(join(path, "README.md"), `# ${API}\n`);
  git(path, ["add", "."], tmpHome);
  git(path, ["commit", "-m", "seed"], tmpHome);
  seedState(tmpHome, {
    repos: [{ name: API, path, defaultBranch: "main", worktrees: [{ branch: "main", path }] }],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({
    tmpHome,
    env: {
      ...acpStubEnv(tmpHome, {
        turns: [
          {
            match: "^Retro for the Band project",
            steps: [
              {
                mcpCall: {
                  name: "retro",
                  server: "band-retro",
                  tool: "retro_propose",
                  args: {
                    summary: "The notes can be shorter.",
                    items: [
                      {
                        target: "project-context",
                        path: "notes.md",
                        content: "# Notes\n\nShort and current.\n",
                        rationale: "Finished work is dropped.",
                      },
                      {
                        target: "repo",
                        repo: API,
                        path: "CLAUDE.md",
                        change: "Add a line about running the checks.",
                        rationale: "A push skipped them.",
                      },
                    ],
                  },
                },
              },
              { say: "proposed" },
            ],
          },
          { steps: [{ say: "ok" }] },
        ],
      }),
      BAND_TEST_ACP_HTTP_LOG: join(tmpHome, "acp-http-log.jsonl"),
    },
  });
  await trpc("projects.create", { name: "shop", repos: [{ repo: API }] });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test("the schedule is off until it is turned on, and its cron is editable", async ({ page }) => {
  const projects = new ProjectsPage(page, server.url, TOKEN);
  await projects.goto();
  await projects.open();
  await projects.openProject("shop");
  await expect(projects.retroScheduled()).toHaveAttribute("data-scheduled", "false");

  await projects.setRetroSchedule({ enabled: true, cron: "30 8 * * 2" });
  await expect(projects.retroScheduled()).toHaveAttribute("data-scheduled", "true");

  await projects.setRetroSchedule({ enabled: false, cron: "30 8 * * 2" });
  await expect(projects.retroScheduled()).toHaveAttribute("data-scheduled", "false");
});

test("a retro shows its proposed edits with diffs, accepting and rejecting each", async ({
  page,
}) => {
  const projects = new ProjectsPage(page, server.url, TOKEN);
  await projects.goto();
  await projects.open();
  await projects.openProject("shop");
  await expect(projects.retroItems()).toHaveCount(0);

  await projects.runRetro();
  await expect(projects.retroItem("notes.md")).toBeVisible({ timeout: 30_000 });
  await expect(projects.retroItem("notes.md")).toContainText("+Short and current.");
  await expect(projects.retroItem("CLAUDE.md")).toContainText(
    "Add a line about running the checks.",
  );

  await projects.acceptRetroItem("notes.md");
  await expect(projects.retroItem("notes.md")).toHaveAttribute("data-status", "accepted");
  await projects.rejectRetroItem("CLAUDE.md");
  await expect(projects.retroItem("CLAUDE.md")).toHaveAttribute("data-status", "rejected");
});
