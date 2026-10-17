// Account usage limits for the sidebar popover, read per host.
//
// Every machine reads its own Claude and Codex logins and calls the provider's usage endpoint
// (a stub here, through BAND_CLAUDE_USAGE_URL and BAND_CODEX_USAGE_URL). The hub merges what the
// hosts report: the same account on two hosts is one row naming both, and a host without a login
// or with a failing endpoint becomes a short reason next to the other rows.

import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { startUsageStub, type UsageStub } from "./fixtures/usage-stub";
import { seedSettings } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";
import { waitFor } from "./helpers/wait-for";

const TOKEN = "account-usage-token";
const WORKER_BIN = join(import.meta.dirname, "../../worker/bin/band-worker.mjs");
// Secrets that must never appear in an answer.
const CLAUDE_X = "sk-ant-oat-secret-x";
const CLAUDE_Y = "sk-ant-oat-secret-y";
const CLAUDE_EXPIRED = "sk-ant-oat-secret-expired";
const CODEX_OK = "codex-secret-ok";
const CODEX_BAD = "codex-secret-bad";

const claudeBody = (five: number, week: number, fable: number) => ({
  five_hour: { utilization: five, resets_at: new Date(Date.now() + 2 * 3_600_000).toISOString() },
  seven_day: { utilization: week, resets_at: new Date(Date.now() + 5 * 86_400_000).toISOString() },
  limits: [
    {
      kind: "weekly_scoped",
      percent: fable,
      resets_at: new Date(Date.now() + 5 * 86_400_000).toISOString(),
      scope: { model: { display_name: "Fable" } },
    },
  ],
});

const idToken = (email: string) =>
  `h.${Buffer.from(JSON.stringify({ email })).toString("base64url")}.s`;

interface Row {
  provider: string;
  account: string | null;
  plan: string | null;
  windows: { label: string; percent: number; resetsAt: number | null }[];
  hosts: string[];
}
interface Problem {
  provider: string;
  reason: string;
  message: string;
  hosts: string[];
}
interface Report {
  rows: Row[];
  problems: Problem[];
}

function writeClaudeLogin(home: string, token: string, email: string): void {
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: token, subscriptionType: "max" } }),
  );
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({ oauthAccount: { emailAddress: email, accountUuid: `uuid-${email}` } }),
  );
}

function writeCodexLogin(home: string, token: string, email: string): void {
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(
    join(home, ".codex", "auth.json"),
    JSON.stringify({
      tokens: { access_token: token, account_id: "acct-1", id_token: idToken(email) },
    }),
  );
}

describe("account usage across hosts", () => {
  const scratch: string[] = [];
  const tmp = (prefix: string) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    scratch.push(dir);
    return dir;
  };

  let stub: UsageStub;
  let server: ServerHandle;
  const workers: ChildProcess[] = [];

  const list = async (input?: { refresh?: boolean }) => {
    const res = await trpcQuery(server.url, "accountUsage.list", input, TOKEN);
    if (res.status !== 200) throw new Error(`accountUsage.list: HTTP ${res.status}`);
    return { raw: JSON.stringify(await res.clone().json()), report: await trpcData<Report>(res) };
  };

  async function startWorker(name: string, home: string): Promise<void> {
    const issued = await trpcMutate(
      server.url,
      "tokens.issueWorkerBootstrap",
      { hostName: name, labels: ["test"] },
      TOKEN,
    ).then((r) => trpcData<{ token: string; hostId: string }>(r));
    const worker = spawn(
      process.execPath,
      [
        WORKER_BIN,
        "--hub",
        server.url,
        "--token",
        issued.token,
        "--worker-id",
        issued.hostId,
        "--root",
        tmp("band-usage-root-"),
        "--state-dir",
        tmp("band-usage-state-"),
      ],
      {
        env: {
          ...process.env,
          HOME: home,
          BAND_HOME: join(home, ".band"),
          BAND_CLAUDE_USAGE_URL: stub.claudeUrl,
          BAND_CODEX_USAGE_URL: stub.codexUrl,
          BAND_USAGE_KEYCHAIN: "off",
        },
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
    workers.push(worker);
    await waitFor(
      async () => {
        const res = await trpcQuery(server.url, "hosts.list", undefined, TOKEN);
        const { hosts } = await trpcData<{ hosts: { id: string; status: string }[] }>(res);
        return hosts.some((h) => h.id === issued.hostId && h.status === "online")
          ? true
          : undefined;
      },
      { label: `${name} online`, timeoutMs: 30_000 },
    );
  }

  beforeAll(async () => {
    stub = await startUsageStub({
      claude: {
        [CLAUDE_X]: { status: 200, body: claudeBody(17, 3, 0) },
        [CLAUDE_Y]: { status: 200, body: claudeBody(80, 41, 12) },
        [CLAUDE_EXPIRED]: { status: 401 },
      },
      codex: {
        [CODEX_OK]: {
          status: 200,
          body: {
            plan_type: "plus",
            rate_limit: {
              primary_window: {
                used_percent: 25,
                limit_window_seconds: 18000,
                reset_at: Math.floor(Date.now() / 1000) + 3600,
              },
              secondary_window: {
                used_percent: 9,
                limit_window_seconds: 604800,
                reset_at: Math.floor(Date.now() / 1000) + 86400,
              },
            },
          },
        },
        [CODEX_BAD]: { status: 500 },
      },
    });

    const hubHome = createTmpHome("band-account-usage-");
    scratch.push(hubHome);
    seedSettings(hubHome, { tokenSecret: TOKEN });
    // The hub's own machine: Claude account X and a working Codex login.
    writeClaudeLogin(hubHome, CLAUDE_X, "x@example.com");
    writeCodexLogin(hubHome, CODEX_OK, "x@example.com");
    server = await startServer({
      tmpHome: hubHome,
      remoteHost: false,
      env: {
        BAND_CLAUDE_USAGE_URL: stub.claudeUrl,
        BAND_CODEX_USAGE_URL: stub.codexUrl,
        BAND_USAGE_KEYCHAIN: "off",
      },
    });

    // alpha: the same Claude account as the hub, no Codex.
    const alpha = tmp("band-usage-alpha-");
    writeClaudeLogin(alpha, CLAUDE_X, "X@example.com");
    // beta: another Claude account and a Codex login the endpoint fails on.
    const beta = tmp("band-usage-beta-");
    writeClaudeLogin(beta, CLAUDE_Y, "y@example.com");
    writeCodexLogin(beta, CODEX_BAD, "y@example.com");
    // gamma: an expired Claude login and no Codex.
    const gamma = tmp("band-usage-gamma-");
    writeClaudeLogin(gamma, CLAUDE_EXPIRED, "z@example.com");
    // delta: no login at all.
    const delta = tmp("band-usage-delta-");

    await startWorker("alpha", alpha);
    await startWorker("beta", beta);
    await startWorker("gamma", gamma);
    await startWorker("delta", delta);
  }, 180_000);

  afterAll(async () => {
    for (const w of workers) w.kill("SIGKILL");
    await server?.close();
    await stub?.close();
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
  });

  it("shows a Claude row with 5h, wk and Fable windows and the plan", async () => {
    const { report } = await list();
    const x = report.rows.find((r) => r.provider === "claude" && r.account === "x@example.com");
    expect(x?.plan).toBe("Max");
    expect(x?.windows.map((w) => [w.label, w.percent])).toEqual([
      ["5h", 17],
      ["wk", 3],
      ["Fable", 0],
    ]);
    const fiveHour = x?.windows[0]?.resetsAt ?? 0;
    expect(fiveHour).toBeGreaterThan(Date.now());
  });

  it("shows a Codex row with its windows", async () => {
    const { report } = await list();
    const codex = report.rows.filter((r) => r.provider === "codex");
    expect(codex).toHaveLength(1);
    expect(codex[0]?.plan).toBe("Plus");
    expect(codex[0]?.account).toBe("x@example.com");
    expect(codex[0]?.windows.map((w) => [w.label, w.percent])).toEqual([
      ["5h", 25],
      ["wk", 9],
    ]);
    expect(stub.lastCodexHeaders()["chatgpt-account-id"]).toBe("acct-1");
  });

  it("merges the same account on two hosts and keeps a different account apart", async () => {
    const { report } = await list();
    const claude = report.rows.filter((r) => r.provider === "claude");
    expect(claude).toHaveLength(2);
    const x = claude.find((r) => r.account?.toLowerCase() === "x@example.com");
    const y = claude.find((r) => r.account === "y@example.com");
    expect(x?.hosts).toHaveLength(2);
    expect(x?.hosts).toContain("alpha");
    expect(y?.hosts).toEqual(["beta"]);
    expect(y?.windows.map((w) => w.percent)).toEqual([80, 41, 12]);
  });

  it("refuses a request without a device token", async () => {
    const res = await fetch(`${server.url}/trpc/accountUsage.list`);
    expect(res.status).toBe(401);
  });

  it("explains a missing login, an expired login and a failing endpoint, and keeps the other rows", async () => {
    const { report } = await list();
    const problem = (provider: string, reason: string) =>
      report.problems.find((p) => p.provider === provider && p.reason === reason);
    expect(problem("claude", "expired")).toMatchObject({
      hosts: ["gamma"],
      message: "Login expired on gamma",
    });
    expect(problem("claude", "not-logged-in")).toMatchObject({
      hosts: ["delta"],
      message: "Not logged in on delta",
    });
    expect(problem("codex", "error")).toMatchObject({
      hosts: ["beta"],
      message: "Couldn't refresh usage on beta",
    });
    expect(problem("codex", "not-logged-in")?.hosts.sort()).toEqual(["alpha", "delta", "gamma"]);
    expect(report.rows).toHaveLength(3);
  });

  it("answers from the hosts' caches until a refresh is asked for", async () => {
    await list();
    const before = stub.requests.claude.length;
    await list();
    expect(stub.requests.claude.length).toBe(before);

    await list({ refresh: true });
    expect(stub.requests.claude.length).toBeGreaterThan(before);
  });

  it("never carries a token, only percentages, times, plan and identity", async () => {
    const { raw, report } = await list({ refresh: true });
    for (const secret of [CLAUDE_X, CLAUDE_Y, CLAUDE_EXPIRED, CODEX_OK, CODEX_BAD]) {
      expect(raw).not.toContain(secret);
    }
    for (const row of report.rows) {
      expect(Object.keys(row).sort()).toEqual(
        ["account", "hosts", "plan", "provider", "updatedAt", "windows"].sort(),
      );
      for (const w of row.windows) {
        expect(Object.keys(w).sort()).toEqual(["label", "percent", "resetsAt"]);
      }
    }
  });
});
