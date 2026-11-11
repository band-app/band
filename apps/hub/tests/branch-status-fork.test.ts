/**
 * A worktree whose `origin` is a GitHub fork shows the PR its branch has in
 * the parent repo: the branch-status badge, its CI, the review panel and the
 * repo PR actions run against.
 *
 * Real server, a git repo with the origin `forker/widgets` (a fork of
 * `acme/widgets`), and the fake `gh` (`fixtures/gh-stub.ts`).
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { branchRepository, prNode, prUrl } from "./fixtures/branch-status-data";
import { type GhInvocation, type GhStub, ghStub } from "./fixtures/gh-stub";
import { FAKE_REPO, pullRequestNode, reviewQueryData } from "./fixtures/github-review-data";
import { seedSettings, seedState } from "./helpers/seed-state";
import { createTmpHome, type ServerHandle, startServer, trpcMutate } from "./helpers/server";
import { testWorktreeId } from "./helpers/test-host";
import { waitFor } from "./helpers/wait-for";

const TOKEN = "branch-status-fork-test-token";
const REPO = "widgets";
const FORK = { owner: "forker", name: "widgets" };
const PARENT_NODE = { name: FAKE_REPO.name, owner: { login: FAKE_REPO.owner } };

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf-8" });
}

const CASES = {
  failing: "feat/fork-failing",
  stranger: "feat/fork-stranger",
  own: "feat/fork-own",
} as const;

interface CIEvent {
  state: string;
  url?: string | null;
  pr?: { number: number; title: string; url: string; state: string; isDraft: boolean } | null;
}

function seedRepo(tmpHome: string): void {
  const repo = join(tmpHome, REPO);
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "hello\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "init"]);
  git(repo, ["remote", "add", "origin", `git@github.com:${FORK.owner}/${FORK.name}.git`]);
  const worktrees = Object.values(CASES).map((branch) => {
    const path = join(tmpHome, `wt-${branch.replaceAll("/", "-")}`);
    git(repo, ["worktree", "add", "-b", branch, path]);
    return { name: branch, branch, path };
  });
  seedState(tmpHome, {
    repos: [
      {
        name: REPO,
        path: repo,
        defaultBranch: "main",
        worktrees: [{ name: "main", branch: "main", path: repo }, ...worktrees],
      },
    ],
  });
}

/** A parent-repo PR node: head in `headOwner`'s fork, with the head commit's check rollup. */
function parentPr(number: number, headOwner: string, rollup: string | null) {
  return {
    ...prNode({ number, headOwner }),
    commits: { nodes: [{ commit: { statusCheckRollup: rollup ? { state: rollup } : null } }] },
  };
}

const parentUrl = prUrl;

describe("a fork worktree shows its PR from the parent repo", () => {
  let tmpHome: string;
  let server: ServerHandle;
  let stub: GhStub;
  const events = new Map<string, CIEvent[]>();
  let ws: WebSocket;
  const wsId = (branch: string) => testWorktreeId(REPO, branch);

  beforeAll(async () => {
    tmpHome = createTmpHome("band-branch-status-fork-");
    seedRepo(tmpHome);
    seedSettings(tmpHome, { tokenSecret: TOKEN });

    stub = await ghStub.start();
    // The fork's own repo: no PR, except for the `own` branch.
    stub.setBranchStatusQuery(FORK, (branch) => ({
      ...branchRepository({
        pullRequests: branch === CASES.own ? [prNode({ number: 11, headOwner: FORK.owner })] : [],
      }),
      owner: { login: FORK.owner },
      parent: PARENT_NODE,
    }));
    stub.setBranchStatusQuery(FAKE_REPO, (branch) => {
      if (branch === CASES.failing) {
        return { pullRequests: { nodes: [parentPr(42, FORK.owner, "FAILURE")] } };
      }
      if (branch === CASES.stranger) {
        return { pullRequests: { nodes: [parentPr(43, "someone-else", "SUCCESS")] } };
      }
      if (branch === CASES.own) {
        return { pullRequests: { nodes: [parentPr(99, FORK.owner, "SUCCESS")] } };
      }
      return { pullRequests: { nodes: [] } };
    });
    // The review panel: the fork has no PR, the parent has #42 from the fork.
    stub.setReviewQuery(FORK, CASES.failing, {
      repository: { parent: PARENT_NODE, pullRequests: { nodes: [] }, ref: null },
    });
    stub.setReviewQuery(
      FAKE_REPO,
      CASES.failing,
      reviewQueryData({
        pullRequests: [
          {
            ...pullRequestNode({ number: 42, isCrossRepository: true }),
            headRepositoryOwner: { login: FORK.owner },
          },
        ],
      }),
    );
    server = await startServer({ tmpHome, env: stub.env });

    ws = new WebSocket(`${server.url.replace(/^http/, "ws")}/trpc`, {
      headers: { Cookie: `band_token=${TOKEN}` },
    });
    ws.on("message", (raw: Buffer) => {
      const data = (
        JSON.parse(raw.toString()) as {
          result?: { data?: { kind?: string; worktreeId?: string; ci?: CIEvent } };
        }
      ).result?.data;
      if (data?.kind !== "branch-status" || !data.worktreeId || !data.ci) return;
      events.set(data.worktreeId, [...(events.get(data.worktreeId) ?? []), data.ci]);
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("error", reject);
      ws.once("open", () => {
        ws.send(
          JSON.stringify({
            id: 1,
            jsonrpc: "2.0",
            method: "subscription",
            params: { path: "status.stream", input: undefined },
          }),
        );
        resolve();
      });
    });
  }, 60_000);

  afterAll(async () => {
    ws?.close();
    await server?.close();
    await stub?.stop();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  async function latest(branch: string): Promise<CIEvent> {
    await waitFor(() => events.get(wsId(branch))?.some((e) => e.pr !== undefined) ?? false, {
      timeoutMs: 20_000,
    });
    return events.get(wsId(branch))?.at(-1) as CIEvent;
  }

  it("S1, S2: carries the parent's PR and the CI of its head commit", async () => {
    expect(await latest(CASES.failing)).toEqual({
      state: "failure",
      url: parentUrl(42),
      pr: {
        number: 42,
        title: "Pull request 42",
        url: parentUrl(42),
        state: "open",
        isDraft: false,
      },
    });
  });

  it("S3: ignores a same-named PR from someone else's fork", async () => {
    expect((await latest(CASES.stranger)).pr).toBeNull();
  });

  it("S5: the fork's own PR wins over the parent's", async () => {
    expect((await latest(CASES.own)).pr?.number).toBe(11);
  });

  it("S4: only branches without a PR in the fork are asked of the parent", async () => {
    await latest(CASES.own);
    const parentQueries = stub.requests
      .map((r) => r.fields.query)
      .filter((q): q is string => typeof q === "string")
      .filter((q) => q.includes("statusCheckRollup { state }"));
    expect(parentQueries.length).toBeGreaterThan(0);
    for (const q of parentQueries) {
      expect(q).toContain(`repository(owner: "${FAKE_REPO.owner}"`);
      expect(q).not.toContain(`headRefName: "${CASES.own}"`);
      expect(q).not.toContain('headRefName: "main"');
    }
  });

  it("S6: a PR action runs against the parent repo", async () => {
    const ready: GhInvocation[] = [];
    stub.setPrReady(42, { onRequest: (r) => ready.push(r) });
    const res = await trpcMutate(
      server.url,
      "reviews.runAction",
      { worktreeId: wsId(CASES.failing), actionId: "ready", args: {} },
      TOKEN,
    );
    expect(res.status).toBe(200);
    expect(ready.map((r) => r.args)).toEqual([
      ["pr", "ready", "42", "--repo", `github.com/${FAKE_REPO.owner}/${FAKE_REPO.name}`],
    ]);
  });
});
