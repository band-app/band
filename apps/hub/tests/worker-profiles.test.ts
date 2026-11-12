// Integration tests for worker profiles (admin API, validation, credential policy). A real hub
// (the production bundle, temp BAND_HOME, no local worker) and a real `band-worker` with its own
// temp HOME and the scripted ACP agent. The remote is a local git HTTP server that needs basic auth.
// The provisioning side of profiles is in `provisioning.test.ts`.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type GitHttpAuthStub, startGitHttpAuthStub } from "./fixtures/git-http-auth-stub";
import { STUB_AGENT_PATH } from "./helpers/acp-chat";
import { seedSettings } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";
import { TerminalSocket } from "./helpers/terminal-socket";
import { removeTmpHome } from "./helpers/tmp-home";
import { waitFor } from "./helpers/wait-for";
import { WORKER_BIN } from "./helpers/worker-bin";

const TOKEN = "worker-profiles-shared-secret";
const TOK_A = "gitpat_A_0123456789abcdefAAAA";
const TOK_B = "gitpat_B_0123456789abcdefBBBBBBBB";
const TOK_GH = "ghp_defaultGithubToken0123456789ZZ";
const LOGIN_1 = "sk-ant-oat01-LOGIN-ONE-plaintext-1111";
const LOGIN_2 = "sk-ant-oat01-LOGIN-TWO-plaintext-2222";

const scratch: string[] = [];
const tmp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};
const identity = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...identity } });

let server: ServerHandle;
let stub: GitHttpAuthStub;
let worker: ChildProcess;
let hostId = "";
let worktreeId = "";
let stubLog = "";
let login1 = "";
let login2 = "";
let deviceToken = "";
let restartWorker: (optIn: boolean) => Promise<void>;

const call = <T>(kind: "q" | "m", procedure: string, input?: unknown, token = TOKEN) =>
  (kind === "q"
    ? trpcQuery(server.url, procedure, input, token)
    : trpcMutate(server.url, procedure, input, token)
  ).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });
const q = <T>(procedure: string, input?: unknown) => call<T>("q", procedure, input);
const m = <T>(procedure: string, input?: unknown) => call<T>("m", procedure, input);

interface HostRow {
  id: string;
  status: string;
  trust: string;
  profile: string | null;
}
const hostRow = async () =>
  (await q<{ hosts: HostRow[] }>("hosts.list")).hosts.find((h) => h.id === hostId);

async function inWorkerShell(line: string): Promise<string> {
  const { terminalId } = await m<{ terminalId: string }>("terminal.create", { worktreeId });
  const socket = await TerminalSocket.open(server, { worktreeId, terminalId, token: TOKEN });
  try {
    socket.type(`${line}; echo END-$((6*7))\r`);
    await socket.waitForOutput("END-42", 30_000);
    return socket.output;
  } finally {
    await socket.close();
  }
}
const askGit = (path: string) =>
  inWorkerShell(
    `printf 'protocol=http\\nhost=${stub.host}\\npath=${path}\\n\\n' | GIT_TERMINAL_PROMPT=0 git credential fill 2>&1 | grep -v '^$' | head -6; true`,
  );
const ghLength = async () => {
  const out = await inWorkerShell('echo "GHLEN-$(printf %s "$GH_TOKEN" | wc -c | tr -d " ")-X"');
  return Number(/GHLEN-(\d+)-X/.exec(out)?.[1]);
};

const attach = (profile: string | null) =>
  m("workerProfiles.setWorkerProfile", { hostId, profile });

beforeAll(async () => {
  const hubHome = createTmpHome("band-wprofiles-hub-");
  scratch.push(hubHome);
  const base = tmp("band-wprofiles-");
  const workerHome = tmp("band-wprofiles-whome-");
  const workerRoot = tmp("band-wprofiles-root-");
  const remotes = join(base, "remotes");
  mkdirSync(remotes, { recursive: true });
  const seed = join(base, "seed");
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "hello.txt"), "hello\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "init");
  git(base, "clone", "-q", "--bare", seed, join(remotes, "proj.git"));
  stub = await startGitHttpAuthStub(remotes, { username: "band-bot", password: TOK_A });
  const checkout = join(workerRoot, "proj");
  git(base, "clone", "-q", join(remotes, "proj.git"), checkout);
  git(checkout, "remote", "set-url", "origin", `${stub.url}/proj.git`);

  seedSettings(hubHome, { tokenSecret: TOKEN });
  server = await startServer({
    tmpHome: hubHome,
    remoteHost: false,
    env: { BAND_LOCAL_HOST: "off", BAND_SERVE_UI: "false" },
  });
  const issued = await m<{ token: string; hostId: string }>("tokens.issueWorkerBootstrap", {
    hostName: "W",
  });
  hostId = issued.hostId;

  const binDir = tmp("band-wprofiles-bin-");
  const fakeClaude = join(binDir, "claude");
  writeFileSync(
    fakeClaude,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.0 (Claude Code)"; exit 0; fi\nexit 1\n',
  );
  chmodSync(fakeClaude, 0o755);
  stubLog = join(workerHome, "stub-log.jsonl");
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) =>
        !k.startsWith("BAND_") &&
        ![
          "GH_TOKEN",
          "GITHUB_TOKEN",
          "CLAUDE_CODE_OAUTH_TOKEN",
          "ANTHROPIC_API_KEY",
          "ANTHROPIC_AUTH_TOKEN",
        ].includes(k),
    ),
  );
  const stateDir = tmp("band-wprofiles-state-");
  // The first start uses the bootstrap token. A restart reads the session token from the state dir.
  const launch = (token: string | null, optIn: boolean) =>
    spawn(
      process.execPath,
      [
        WORKER_BIN,
        "--hub",
        server.url,
        ...(token ? ["--token", token] : []),
        "--root",
        workerRoot,
        "--state-dir",
        stateDir,
      ],
      {
        env: {
          ...clean,
          ...identity,
          HOME: workerHome,
          BAND_HOME: join(workerHome, ".band"),
          GIT_CONFIG_NOSYSTEM: "1",
          BAND_TERMINAL_DAEMON: "0",
          SHELL_SESSIONS_DISABLE: "1",
          HISTFILE: "/dev/null",
          // The opt-in an attached worker may send for a gh token. A profile with credentials ignores it.
          ...(optIn ? { BAND_WORKER_GH_TOKEN: "hub" } : {}),
          BAND_AGENT_BIN_DIRS: binDir,
          BAND_TEST_ACP_AGENT: STUB_AGENT_PATH,
          BAND_TEST_ACP_STATE: join(workerHome, "acp-state"),
          BAND_TEST_ACP_LOG: stubLog,
          BAND_TEST_ACP_LOG_ENV: "CLAUDE_CODE_OAUTH_TOKEN",
        },
        stdio: "ignore",
      },
    );
  worker = launch(issued.token, false);
  const online = () =>
    waitFor(async () => ((await hostRow())?.status === "online" ? true : undefined), {
      label: "worker online",
      timeoutMs: 30_000,
    });
  await online();
  restartWorker = async (optIn) => {
    const exited = new Promise<void>((resolve) => worker.once("exit", () => resolve()));
    worker.kill("SIGTERM");
    await exited;
    await waitFor(async () => ((await hostRow())?.status !== "online" ? true : undefined), {
      label: "worker offline",
      timeoutMs: 30_000,
    });
    worker = launch(null, optIn);
    await online();
  };
  await m("repos.addFromWorker", { hostId, path: checkout });
  await m("worktrees.create", { repo: "proj", branch: "feat", hostId });
  worktreeId = toWorktreeId("proj", "feat", hostId);

  // A matches every path in the repo, B only `proj`: without a profile B wins on specificity.
  const gitItem = (name: string, host: string, pathPattern: string, value: string) =>
    m("vault.put", { name, kind: "git", host, pathPattern, username: "band-bot", value });
  await gitItem("github-agents", stub.host, "**", TOK_A);
  await gitItem("github-personal", stub.host, "proj", TOK_B);
  await gitItem("github-default", "github.com", "**", TOK_GH);
  login1 = (
    await m<{ login: { id: string } }>("agentLogins.create", {
      agentType: "claude-code",
      kind: "setup-token",
      label: "claude-agents",
      secret: LOGIN_1,
    })
  ).login.id;
  login2 = (
    await m<{ login: { id: string } }>("agentLogins.create", {
      agentType: "claude-code",
      kind: "setup-token",
      label: "claude-personal",
      secret: LOGIN_2,
    })
  ).login.id;
  await m("agentLogins.setDefault", { agentType: "claude-code", loginId: login2 });
  deviceToken = (await m<{ token: string }>("tokens.createDevice", { label: "viewer" })).token;
}, 180_000);

afterAll(async () => {
  if (worker && worker.exitCode === null) {
    const exited = new Promise<void>((resolve) => worker.once("exit", () => resolve()));
    worker.kill("SIGTERM");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
  }
  await server?.close();
  await stub?.stop();
  for (const dir of scratch) removeTmpHome(dir);
});

describe("the profile editor API (S1, S3)", () => {
  it("stores, lists, updates and deletes a profile, naming the field of a bad value", async () => {
    await m("workerProfiles.create", {
      name: "basic",
      trust: "standard",
      labels: ["gui=1"],
      env: { BAND_WORKER_HUB_GIT_CREDENTIALS_ONLY: "1" },
      credentials: { git: ["github-agents"], gh: "github-agents", agentLogins: ["claude-agents"] },
    });
    const listed = await q<{ profiles: Array<{ name: string; workers: number }> }>(
      "workerProfiles.list",
    );
    expect(listed.profiles.map((p) => p.name)).toContain("basic");

    await m("workerProfiles.update", {
      name: "basic",
      profile: { name: "basic", trust: "restricted" },
    });
    const bad = async (profile: object, field: RegExp) => {
      await expect(m("workerProfiles.create", profile)).rejects.toThrow(field);
    };
    await bad({ name: "t1", trust: "root" }, /trust/);
    await bad({ name: "t2", env: { FOO: "1" } }, /env.*BAND_WORKER_/);
    await bad({ name: "t2b", env: { BAND_WORKER_TOKEN: "x" } }, /BAND_WORKER_TOKEN.*hub sets/);
    await bad({ name: "t3", credentials: { git: ["nope"] } }, /credentials\.git.*nope/);
    await bad({ name: "t4", credentials: { gh: "nope" } }, /credentials\.gh/);
    await bad({ name: "t5", credentials: { agentLogins: ["nope"] } }, /credentials\.agentLogins/);
    await bad(
      { name: "t6", provisioning: { repoUrl: "https://user:pw@example.com/r.git" } },
      /provisioning\.repoUrl/,
    );
    await bad({ name: "basic" }, /already exists/);
    await bad({ name: "t7", env: { BAND_WORKER_TOKEN: "x" } }, /BAND_WORKER_TOKEN/);

    await m("workerProfiles.delete", { name: "basic" });
    const after = await q<{ profiles: Array<{ name: string }> }>("workerProfiles.list");
    expect(after.profiles.map((p) => p.name)).not.toContain("basic");
  });

  it("refuses deleting a profile a worker uses", async () => {
    await m("workerProfiles.create", { name: "in-use" });
    await attach("in-use");
    await expect(m("workerProfiles.delete", { name: "in-use" })).rejects.toThrow(
      /used by 1 worker/,
    );
    await attach(null);
    await m("workerProfiles.delete", { name: "in-use" });
  });

  it("reports an invalid entry from the settings file and does not apply it (S1)", async () => {
    // settings.update validates, so only a hand-edited file holds an invalid entry.
    const file = join(server.home, ".band", "settings.json");
    const settings = JSON.parse(readFileSync(file, "utf8"));
    settings.workerProfiles = [{ name: "broken", trust: "root" }];
    writeFileSync(file, JSON.stringify(settings));
    try {
      const listed = await q<{
        profiles: unknown[];
        invalid: Array<{ name: string; error: string }>;
      }>("workerProfiles.list");
      expect(listed.profiles).toEqual([]);
      expect(listed.invalid[0]).toMatchObject({ name: "broken" });
      expect(listed.invalid[0].error).toContain("trust");
      await expect(attach("broken")).rejects.toThrow(/No profile/);
    } finally {
      settings.workerProfiles = [];
      writeFileSync(file, JSON.stringify(settings));
    }
  });
});

describe("who may read or change profiles (S8)", () => {
  it("answers a non-admin device token with 403 and hides profiles from settings.get", async () => {
    await m("workerProfiles.create", {
      name: "secretive",
      credentials: { git: ["github-agents"] },
    });
    for (const res of [
      await trpcQuery(server.url, "workerProfiles.list", undefined, deviceToken),
      await trpcMutate(server.url, "workerProfiles.create", { name: "x" }, deviceToken),
      await trpcMutate(
        server.url,
        "workerProfiles.setWorkerProfile",
        { hostId, profile: null },
        deviceToken,
      ),
      await trpcMutate(server.url, "workerProfiles.delete", { name: "secretive" }, deviceToken),
      await trpcMutate(server.url, "settings.update", { workerProfiles: [] }, deviceToken),
    ]) {
      expect(res.status).toBe(403);
    }
    const viewer = JSON.stringify(await call("q", "settings.get", undefined, deviceToken));
    expect(viewer).not.toContain("secretive");
    expect(viewer).not.toContain("github-agents");
    const admin = JSON.stringify(await q("settings.get"));
    expect(admin).toContain("secretive");
    await m("workerProfiles.delete", { name: "secretive" });
  });
});

describe("the credential policy (S4, S5, S6, S7)", () => {
  it("S4: without a profile git gets the most specific item, with a profile only the listed ones", async () => {
    expect(await askGit("proj.git")).toContain(`password=${TOK_B}`);

    await m("workerProfiles.create", { name: "only-a", credentials: { git: ["github-agents"] } });
    await attach("only-a");
    const withA = await askGit("proj.git");
    expect(withA).toContain(`password=${TOK_A}`);
    expect(withA).not.toContain(TOK_B);

    await m("workerProfiles.create", { name: "none-listed", credentials: {} });
    await attach("none-listed");
    const refused = await askGit("proj.git");
    expect(refused).not.toContain(TOK_A);
    expect(refused).not.toContain(TOK_B);

    // A profile without `credentials` keeps today's rules.
    await m("workerProfiles.create", { name: "plain" });
    await attach("plain");
    expect(await askGit("proj.git")).toContain(`password=${TOK_B}`);

    await attach(null);
    expect(await askGit("proj.git")).toContain(`password=${TOK_B}`);
  }, 120_000);

  it("S5: gh.token follows the profile's gh item, with or without the worker's opt-in", async () => {
    // The worker sets no BAND_WORKER_GH_TOKEN: it gets no token without a profile.
    expect(await ghLength()).toBe(0);

    await m("workerProfiles.create", { name: "gh-a", credentials: { gh: "github-agents" } });
    await attach("gh-a");
    expect(await ghLength()).toBe(TOK_A.length);

    await m("workerProfiles.create", { name: "no-gh", credentials: { git: ["github-agents"] } });
    await attach("no-gh");
    expect(await ghLength()).toBe(0);

    // Now the worker sends the opt-in. A profile without `gh` still gets nothing, one with it gets
    // its item, and no profile gets the github.com item as before.
    await restartWorker(true);
    expect(await ghLength()).toBe(0);
    await attach("gh-a");
    expect(await ghLength()).toBe(TOK_A.length);
    await attach(null);
    expect(await ghLength()).toBe(TOK_GH.length);
  }, 180_000);

  const startAgent = async (chatId: string, loginId?: string) => {
    await m("chats.create", { worktreeId, id: chatId });
    if (loginId) await m("chats.update", { chatId, loginId });
    const res = await fetch(`${server.url}/api/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `band_token=${TOKEN}` },
      body: JSON.stringify({ worktreeId, text: "hello" }),
    });
    expect(res.ok).toBe(true);
    return waitFor(
      () => {
        if (!existsSync(stubLog)) return undefined;
        const found = readFileSync(stubLog, "utf8")
          .split("\n")
          .filter(Boolean)
          .map(
            (l) =>
              JSON.parse(l) as { method: string; env: { NAMED: Record<string, string | null> } },
          )
          .filter((r) => r.method === "session/new");
        return found.length > startedBefore ? found[found.length - 1] : undefined;
      },
      { label: "agent started", timeoutMs: 30_000 },
    );
  };
  let startedBefore = 0;
  const startedCount = () =>
    existsSync(stubLog)
      ? readFileSync(stubLog, "utf8")
          .split("\n")
          .filter((l) => l.includes("session/new")).length
      : 0;

  it("S6: a login the profile does not allow is skipped, an allowed one works", async () => {
    // L2 is the default and is not allowed. L1 is allowed and only a chat can pick it.
    await m("workerProfiles.create", {
      name: "login-1",
      credentials: { agentLogins: ["claude-agents"] },
    });
    await attach("login-1");
    startedBefore = startedCount();
    const skipped = await startAgent("profile-chat-default");
    expect(skipped.env.NAMED.CLAUDE_CODE_OAUTH_TOKEN).toBeNull();

    startedBefore = startedCount();
    const picked = await startAgent("profile-chat-pick", login1);
    expect(picked.env.NAMED.CLAUDE_CODE_OAUTH_TOKEN).toBe(LOGIN_1);

    // A chat pick of the login the profile refuses is skipped too, and the default (also refused) follows.
    startedBefore = startedCount();
    const refusedPick = await startAgent("profile-chat-refused", login2);
    expect(refusedPick.env.NAMED.CLAUDE_CODE_OAUTH_TOKEN).toBeNull();

    await attach(null);
    startedBefore = startedCount();
    const open = await startAgent("profile-chat-open");
    expect(open.env.NAMED.CLAUDE_CODE_OAUTH_TOKEN).toBe(LOGIN_2);
  }, 180_000);

  it("S7: attaching a profile applies its trust, and none restores today's behaviour", async () => {
    expect((await hostRow())?.trust).toBe("standard");
    await m("workerProfiles.create", { name: "locked", trust: "restricted" });
    await attach("locked");
    expect(await hostRow()).toMatchObject({ trust: "restricted", profile: "locked" });
    // The per-worker trust selector still works afterwards.
    await m("hosts.setTrust", { hostId, trust: "standard" });
    expect((await hostRow())?.trust).toBe("standard");
    await attach(null);
    expect((await hostRow())?.profile).toBeNull();
    await expect(attach("missing")).rejects.toThrow(/No profile/);
  });
});
