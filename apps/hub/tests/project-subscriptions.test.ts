/**
 * Project-wide subscriptions (plan step 6.4): events about anything in a project wake its coordinator chat.
 *
 * Runs in-process against a real SQLite database under a temp `BAND_HOME`, real git repos and worktrees, the
 * scripted ACP stub agent and the `gh` Express stub, in the style of `subscriptions-github-poll.test.ts`. Events
 * enter where the hub's own producers put them: the branch-status event the poller emits on the status bus, the
 * poll of `GithubPollService`, a worker chat's turn through `submitOrQueueTask`, and a commit on the project
 * context's bare repo followed by the `syncSoon` call that every hub-side write (and the git HTTP endpoint after a
 * push) makes. Every assertion reads the prompts the stub agent received.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "../src/server/infra/db/connection";
import { ProjectTaskQueries } from "../src/server/infra/db/queries/project-tasks";
import { emit } from "../src/server/infra/events/status-event-bus";
import { agentSessionService } from "../src/server/services/agent-session-service";
import { chatService } from "../src/server/services/chat-service";
import { contextRepoPath, contextService } from "../src/server/services/context-service";
import { contextToolsService } from "../src/server/services/context-tools-service";
import { githubPollService } from "../src/server/services/github-poll-service";
import { projectCoordinatorService } from "../src/server/services/project-coordinator-service";
import { projectService } from "../src/server/services/project-service";
import { projectSubscriptionService } from "../src/server/services/project-subscription-service";
import { subscriptionService } from "../src/server/services/subscription-service";
import { submitOrQueueTask } from "../src/server/services/task-service";
import { worktreeService } from "../src/server/services/worktree-service";
import { type GhStub, ghStub } from "./fixtures/gh-stub";
import { type StubRequest, stubRequests, TEST_TOKEN, writeStubScenario } from "./helpers/acp-chat";
import { assertTempBandHome } from "./helpers/band-home";
import { seedSettings, seedState } from "./helpers/seed-state";
import { createTmpHome } from "./helpers/server";
import { waitFor } from "./helpers/wait-for";

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv, stdio: "pipe" });

const ENV_KEYS = [
  "BAND_HOME",
  "BAND_GH_BIN",
  "BAND_GH_STUB_URL",
  "BAND_PUBLIC_URL",
  "BAND_GITHUB_WEBHOOK_SECRET",
  "BAND_PROJECT_COALESCE_SECONDS",
  "BAND_PROJECT_EVENT_MIN_GAP_MS",
  "BAND_TEST_ACP_LOG",
  "BAND_TEST_ACP_STATE",
  "BAND_TEST_ACP_SCENARIO",
  "BAND_CONTEXT_ALLOW_LOCAL_REMOTES",
] as const;
const originalEnv: Record<string, string | undefined> = {};

let home: string;
let stub: GhStub;
let seq = 0;
/** Chats whose agent process the suite stops at the end. */
const stoppable = new Set<string>();
const scratch: string[] = [];

interface Fixture {
  projectId: string;
  contextName: string;
  coordinatorChatId: string;
  workerWorktreeId: string;
  workerChatId: string;
  branch: string;
  repo: { owner: string; name: string; full: string };
}

const prompts = (chatId: string): string[] =>
  stubRequests(home, "session/prompt")
    .filter((r: StubRequest) => r.env.BAND_CHAT_ID === chatId)
    .map((r) => (r.params.prompt as Array<{ text?: string }>)[0]?.text ?? "");

const promptsAbout = (chatId: string, needle: string) =>
  prompts(chatId).filter((p) => p.includes(needle));

const wakeups = (f: Fixture) =>
  prompts(f.coordinatorChatId).filter((p) => p.startsWith("Subscription update"));

/** A project with a coordinator, one worker worktree with a chat, and a task group naming it. */
async function newProject(): Promise<Fixture> {
  seq += 1;
  const repoName = `api${seq}`;
  const repoDir = join(home, repoName);
  mkdirSync(repoDir, { recursive: true });
  git(repoDir, "init", "-q", "-b", "main");
  writeFileSync(join(repoDir, "README.md"), "x\n");
  git(repoDir, "add", ".");
  git(repoDir, "commit", "-q", "-m", "init");
  seedState(home, {
    repos: [
      {
        name: repoName,
        path: repoDir,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: repoDir }],
      },
    ],
  });
  const project = await projectService.create({ name: `proj${seq}`, repos: [{ repo: repoName }] });
  await projectCoordinatorService.ensureCoordinator(project.id);
  const row = projectService.row(project.id);
  const branch = `feat-${seq}`;
  await worktreeService.create({ repo: repoName, branch, projectId: project.id });
  const workerWorktreeId = toWorktreeId(repoName, branch);
  const workerChat = chatService.getOrCreateDefault(workerWorktreeId);
  // A task with a folder is one the coordinator tracks. This one has a brief path and the worker's worktree.
  const tasks = new ProjectTaskQueries();
  // The create above made the worktree a one-member task of its own. The worker moves into the tracked task.
  tasks.forgetWorktree(workerWorktreeId);
  tasks.insert(
    {
      id: `grp-${seq}`,
      projectId: project.id,
      name: `group-${seq}`,
      branch,
      briefPath: join(home, `group-${seq}`, "BRIEF.md"),
      hostId: "local",
      status: "active",
      createdAt: Date.now(),
    },
    [
      {
        taskId: `grp-${seq}`,
        repoName,
        worktreeId: workerWorktreeId,
        role: null,
        mergeOrder: 0,
        prNumber: null,
      },
    ],
  );
  tasks.setWorktreeTask(repoName, branch, `grp-${seq}`);
  await projectSubscriptionService.reconcile(project.id);
  stoppable.add(workerChat.id);
  stoppable.add(row.coordinatorChatId as string);
  return {
    projectId: project.id,
    contextName: row.contextName,
    coordinatorChatId: row.coordinatorChatId as string,
    workerWorktreeId,
    workerChatId: workerChat.id,
    branch,
    repo: { owner: "acme", name: `widgets${seq}`, full: `acme/widgets${seq}` },
  };
}

/** What the branch-status poller emits when it stores a PR for a worktree. */
function emitPr(f: Fixture, number: number, state: "open" | "merged" | "closed") {
  emit({
    kind: "branch-status",
    worktreeId: f.workerWorktreeId,
    git: { dirty: false, conflict: false, ahead: 0, behind: 0, sync_state: "synced" },
    ci: {
      state: "pending",
      url: null,
      pr: {
        number,
        title: "Add widgets",
        url: `https://github.com/${f.repo.full}/pull/${number}`,
        state,
        isDraft: false,
      },
    },
  });
}

const projectSubs = (f: Fixture) =>
  subscriptionService.list({ chatId: f.coordinatorChatId }).filter((s) => s.source === "github");

const future = (ms: number) => new Date(Date.now() + ms).toISOString();

function prAnswer(f: Fixture, comments: { id: string; body: string; createdAt: string }[]) {
  return {
    url: `https://github.com/${f.repo.full}/pull/7`,
    comments: {
      nodes: comments.map((c) => ({
        ...c,
        url: `https://github.com/c/${c.id}`,
        author: { login: "acme" },
      })),
    },
    reviews: { nodes: [] },
    reviewThreads: { nodes: [] },
  };
}

/** Pushes one commit to the project context the way a host's sync does, then makes the call the hub makes after a push. */
function pushToContext(f: Fixture, change: (wc: string) => void, message: string): void {
  const wc = mkdtempSync(join(tmpdir(), "band-ctx-wc-"));
  scratch.push(wc);
  git(wc, "clone", "-q", contextRepoPath(f.contextName), ".");
  change(wc);
  git(wc, "add", "-A");
  git(wc, "commit", "-q", "-m", message);
  git(wc, "push", "-q", "origin", "HEAD");
  contextService.syncSoon(f.contextName);
}

beforeAll(async () => {
  for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
  home = realpathSync(createTmpHome("band-project-subscriptions-"));
  process.env.BAND_HOME = join(home, ".band");
  assertTempBandHome();
  delete process.env.BAND_PUBLIC_URL;
  process.env.BAND_GITHUB_WEBHOOK_SECRET = "project-subscriptions-secret";
  process.env.BAND_PROJECT_COALESCE_SECONDS = "1";
  process.env.BAND_PROJECT_EVENT_MIN_GAP_MS = "0";
  seedState(home, { repos: [] });
  seedSettings(home, {
    tokenSecret: TEST_TOKEN,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
    defaultCodingAgent: "claude-code",
  });
  stub = await ghStub.start();
  Object.assign(process.env, stub.env);
  process.env.BAND_TEST_ACP_LOG = join(home, "acp-stub-log.jsonl");
  process.env.BAND_TEST_ACP_STATE = join(home, "acp-stub-state");
  process.env.BAND_TEST_ACP_SCENARIO = writeStubScenario(home, [
    { match: "make it fail", steps: [{ fail: "agent exploded" }] },
    { steps: [{ say: "ok" }] },
  ]);
  subscriptionService.start();
  projectSubscriptionService.start();
});

afterAll(async () => {
  assertTempBandHome();
  projectSubscriptionService.stop();
  subscriptionService.stop();
  for (const id of stoppable) agentSessionService.stop(id);
  await stub.stop();
  closeDb();
  for (const key of ENV_KEYS) {
    // An agent process that exits after this hook still reaches the database. With BAND_HOME
    // restored it would open (and migrate) the real ~/.band, so the temp home stays set.
    if (key === "BAND_HOME") continue;
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

afterEach(() => {
  stub.requests.splice(0);
});

describe("project subscriptions", () => {
  it("S1: a review comment on a member's PR wakes the coordinator once, coalesced", async () => {
    const f = await newProject();
    expect(projectSubs(f)).toHaveLength(0);
    let comments: { id: string; body: string; createdAt: string }[] = [];
    // The stub keeps the first answer registered for a repo, so the answer reads a variable.
    stub.setPrActivityQuery(f.repo, () => prAnswer(f, comments));
    emitPr(f, 7, "open");
    await waitFor(async () => projectSubs(f).length === 2, { label: "pr and ci subscriptions" });
    const keys = projectSubs(f).map((s) => s.filterKey);
    expect(keys).toContain(`github:pr:${f.repo.full}#7`);
    expect(keys).toContain(`github:ci:${f.repo.full}@${f.branch}`);
    // The poller serves a repo once its subscriptions have recorded that no webhook exists.
    await waitFor(
      async () => projectSubs(f).every((s) => s.config.webhook?.status === "waiting-for-url"),
      {
        label: "webhook status recorded",
      },
    );
    // Emitting the same state again adds nothing.
    emitPr(f, 7, "open");
    await new Promise((r) => setTimeout(r, 200));
    expect(projectSubs(f)).toHaveLength(2);
    expect(
      new ProjectTaskQueries()
        .membersOfProject(f.projectId)
        .find((m) => m.worktreeId === f.workerWorktreeId)?.prNumber,
    ).toBe(7);

    await githubPollService.poll();
    comments = [
      { id: "C1", body: "please rename the helper", createdAt: future(2000) },
      { id: "C2", body: "and add a test", createdAt: future(2500) },
    ];
    await githubPollService.poll();
    await waitFor(
      async () => promptsAbout(f.coordinatorChatId, "please rename the helper").length === 1,
      {
        label: "coordinator wake-up",
        timeoutMs: 20_000,
      },
    );
    const [message] = promptsAbout(f.coordinatorChatId, "please rename the helper");
    expect(message).toContain("and add a test");
    await githubPollService.poll();
    await new Promise((r) => setTimeout(r, 1500));
    expect(promptsAbout(f.coordinatorChatId, "please rename the helper")).toHaveLength(1);
    // The worker chat itself was not woken.
    expect(promptsAbout(f.workerChatId, "please rename the helper")).toHaveLength(0);
  });

  it("S2: a worker chat ending with an error wakes the coordinator with its chat id, a chat outside the project does not", async () => {
    const f = await newProject();
    submitOrQueueTask({
      worktreeId: f.workerWorktreeId,
      chatId: f.workerChatId,
      prompt: "make it fail",
    });
    await waitFor(async () => promptsAbout(f.coordinatorChatId, "agent exploded").length === 1, {
      label: "coordinator wake-up for the failed worker",
      timeoutMs: 20_000,
    });
    const [message] = promptsAbout(f.coordinatorChatId, "agent exploded");
    expect(message).toContain(f.workerChatId);

    // A repo outside every project: its chat fails and nothing wakes a coordinator.
    seq += 1;
    const outsideName = `outside${seq}`;
    const outsideDir = join(home, outsideName);
    mkdirSync(outsideDir, { recursive: true });
    git(outsideDir, "init", "-q", "-b", "main");
    writeFileSync(join(outsideDir, "README.md"), "x\n");
    git(outsideDir, "add", ".");
    git(outsideDir, "commit", "-q", "-m", "init");
    seedState(home, {
      repos: [
        {
          name: outsideName,
          path: outsideDir,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: outsideDir }],
        },
      ],
    });
    const outsideWorktree = toWorktreeId(outsideName, "main");
    const outsideChat = chatService.getOrCreateDefault(outsideWorktree);
    const before = wakeups(f).length;
    submitOrQueueTask({
      worktreeId: outsideWorktree,
      chatId: outsideChat.id,
      prompt: "make it fail",
    });
    await waitFor(
      async () =>
        stubRequests(home, "session/prompt").some((r) => r.env.BAND_CHAT_ID === outsideChat.id),
      { label: "outside chat prompt" },
    );
    await new Promise((r) => setTimeout(r, 2500));
    expect(wakeups(f).length).toBe(before);
    expect(prompts(f.coordinatorChatId).some((p) => p.includes(outsideChat.id))).toBe(false);
  });

  it("S3: a handoff pushed to the project context wakes the coordinator with its path, and moving it to inbox/done/ does not wake again", async () => {
    const f = await newProject();
    const handoff = await contextToolsService.handoff(
      { chatId: f.workerChatId, worktreeId: f.workerWorktreeId },
      { to: "coordinator", summary: "Finished the parser." },
    );
    await waitFor(async () => promptsAbout(f.coordinatorChatId, handoff.path).length === 1, {
      label: "coordinator wake-up for the handoff",
      timeoutMs: 20_000,
    });
    const [message] = promptsAbout(f.coordinatorChatId, handoff.path);
    expect(message).toContain("inbox/done/");
    const woken = wakeups(f).length;

    pushToContext(
      f,
      (wc) => {
        mkdirSync(join(wc, "inbox/done"), { recursive: true });
        git(wc, "mv", handoff.path, `inbox/done/${handoff.path.split("/").pop()}`);
      },
      "handled",
    );
    await new Promise((r) => setTimeout(r, 2500));
    expect(wakeups(f).length).toBe(woken);

    // A later new file still wakes, so the quiet above was the move and not a broken listener.
    pushToContext(
      f,
      (wc) => writeFileSync(join(wc, "inbox/review-needed.md"), "Please review the API change.\n"),
      "new inbox item",
    );
    await waitFor(
      async () => promptsAbout(f.coordinatorChatId, "inbox/review-needed.md").length === 1,
      {
        label: "coordinator wake-up for the inbox file",
        timeoutMs: 20_000,
      },
    );
  });

  it("S4: a merged PR removes its subscriptions after telling the coordinator", async () => {
    const f = await newProject();
    stub.setPrActivityQuery(f.repo, () => prAnswer(f, []));
    emitPr(f, 9, "open");
    await waitFor(async () => projectSubs(f).length === 2, { label: "pr and ci subscriptions" });
    emitPr(f, 9, "merged");
    await waitFor(async () => projectSubs(f).length === 0, { label: "subscriptions removed" });
    await waitFor(async () => promptsAbout(f.coordinatorChatId, "was merged").length === 1, {
      label: "merge wake-up",
      timeoutMs: 20_000,
    });
    // The project subscription stays for the coordinator's other work.
    expect(
      subscriptionService.list({ chatId: f.coordinatorChatId }).some((s) => s.source === "project"),
    ).toBe(true);
    // A merged PR seen again subscribes nothing.
    emitPr(f, 9, "merged");
    await new Promise((r) => setTimeout(r, 300));
    expect(projectSubs(f)).toHaveLength(0);
  });

  it("lists the subscriptions and recent wake-ups for the project page", async () => {
    const f = await newProject();
    submitOrQueueTask({
      worktreeId: f.workerWorktreeId,
      chatId: f.workerChatId,
      prompt: "make it fail",
    });
    await waitFor(async () => promptsAbout(f.coordinatorChatId, "agent exploded").length === 1, {
      label: "wake-up",
      timeoutMs: 20_000,
    });
    const view = projectSubscriptionService.describe(projectService.row(f.projectId));
    expect(view.subscriptions.map((s) => s.kind)).toContain("project");
    expect(
      view.wakeups.some((w) => w.summary.includes("agent exploded") && w.deliveredAt !== null),
    ).toBe(true);
    expect(view.subscriptions.find((s) => s.kind === "project")?.wakeups).toBeGreaterThan(0);
  });
});
