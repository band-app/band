// Integration tests for worker profiles: the admin API, validation, and profile secrets (vault items
// mapped to environment variables and files on the worker). A real hub (the production bundle, temp
// BAND_HOME, no local worker) and a real `band-worker` with its own temp HOME and the scripted ACP
// agent. The remote is a local git HTTP server that needs basic auth. The provisioning side of
// profiles is in `provisioning.test.ts`.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
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
// Plain words, so the values are easy to find in output and look like no real credential.
const STUB_PASSWORD = "stub-password-for-git";
const AGENT_VALUE_1 = "agent-value-one";
const AGENT_VALUE_2 = "agent-value-two";

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
let workerHome = "";
let stubLog = "";
let deviceToken = "";

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

interface SecretFilesReport {
  written: string[];
  refused: Array<{ path: string; reason: string }>;
}
interface HostRow {
  id: string;
  status: string;
  trust: string;
  profile: string | null;
  secretFiles: SecretFilesReport | null;
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
/** The value of a variable in a new terminal on the worker, or "" when unset. */
const terminalEnv = async (name: string) => {
  const out = await inWorkerShell(`echo "VAL<$${name}>END"`);
  return /VAL<([^>]*)>END/.exec(
    out
      .split("\n")
      .filter((l) => !l.includes("echo"))
      .join("\n"),
  )?.[1];
};

const putItem = (name: string, value: string) => m("vault.put", { name, kind: "api_key", value });
const attach = (profile: string | null) =>
  m("workerProfiles.setWorkerProfile", { hostId, profile });
const setSecrets = (name: string, secrets: unknown[]) =>
  m("workerProfiles.update", { name, profile: { name, secrets } });

const home = (rel: string) => join(workerHome, rel);
const modeOf = (path: string) => (lstatSync(path).mode & 0o777).toString(8);

beforeAll(async () => {
  const hubHome = createTmpHome("band-wprofiles-hub-");
  scratch.push(hubHome);
  const base = tmp("band-wprofiles-");
  workerHome = tmp("band-wprofiles-whome-");
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
  stub = await startGitHttpAuthStub(remotes, { username: "band-bot", password: STUB_PASSWORD });
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
          "GIT_ASKPASS",
          "SSH_ASKPASS",
        ].includes(k),
    ),
  );
  worker = spawn(
    process.execPath,
    [
      WORKER_BIN,
      "--hub",
      server.url,
      "--token",
      issued.token,
      "--root",
      workerRoot,
      "--state-dir",
      tmp("band-wprofiles-state-"),
    ],
    {
      env: {
        ...clean,
        ...identity,
        HOME: workerHome,
        BAND_HOME: join(workerHome, ".band"),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        BAND_TERMINAL_DAEMON: "0",
        SHELL_SESSIONS_DISABLE: "1",
        HISTFILE: "/dev/null",
        BAND_AGENT_BIN_DIRS: binDir,
        BAND_TEST_ACP_AGENT: STUB_AGENT_PATH,
        BAND_TEST_ACP_STATE: join(workerHome, "acp-state"),
        BAND_TEST_ACP_LOG: stubLog,
        BAND_TEST_ACP_LOG_ENV: "CLAUDE_CODE_OAUTH_TOKEN",
      },
      stdio: "ignore",
    },
  );
  await waitFor(async () => ((await hostRow())?.status === "online" ? true : undefined), {
    label: "worker online",
    timeoutMs: 30_000,
  });
  await m("repos.addFromWorker", { hostId, path: checkout });
  await m("worktrees.create", { repo: "proj", branch: "feat", hostId });
  worktreeId = toWorktreeId("proj", "feat", hostId);

  await putItem("agent-token", AGENT_VALUE_1);
  await putItem("plain-env", "plain-value");
  await putItem("config-file", "first contents\n");
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

describe("the profile editor API (S1)", () => {
  it("stores, lists, updates and deletes a profile, naming the field of a bad value", async () => {
    await m("workerProfiles.create", {
      name: "basic",
      trust: "standard",
      labels: ["gui=1"],
      secrets: [
        { item: "agent-token", env: "CLAUDE_CODE_OAUTH_TOKEN" },
        { item: "config-file", file: "~/.config/tool/config", mode: "0600" },
      ],
    });
    const listed = await q<{
      profiles: Array<{ name: string; secrets?: unknown[] }>;
    }>("workerProfiles.list");
    expect(listed.profiles.find((p) => p.name === "basic")?.secrets).toHaveLength(2);

    await m("workerProfiles.update", {
      name: "basic",
      profile: { name: "basic", trust: "restricted" },
    });
    const bad = async (profile: object, field: RegExp) => {
      await expect(m("workerProfiles.create", profile)).rejects.toThrow(field);
    };
    await bad({ name: "t1", trust: "root" }, /trust/);
    await bad({ name: "t2", env: { FOO: "1" } }, /env.*BAND_WORKER_/);
    await bad({ name: "t3", secrets: [{ item: "nope", env: "FOO" }] }, /secrets\.0\.item.*nope/);
    await bad({ name: "t4", secrets: [{ item: "agent-token", env: "lower-case" }] }, /secrets\.0/);
    await bad({ name: "t5", secrets: [{ item: "agent-token", env: "PATH" }] }, /PATH/);
    await bad({ name: "t6", secrets: [{ item: "agent-token", env: "BAND_TOKEN" }] }, /BAND_/);
    for (const [i, reserved] of ["HOME", "USER", "SHELL"].entries()) {
      await bad(
        { name: `t6r${i}`, secrets: [{ item: "agent-token", env: reserved }] },
        /secrets\.0/,
      );
    }
    await bad(
      { name: "t6m1", secrets: [{ item: "config-file", file: "~/x", mode: "0777" }] },
      /mode/,
    );
    await bad(
      { name: "t6m2", secrets: [{ item: "config-file", file: "~/x", mode: "09" }] },
      /mode/,
    );
    await bad(
      { name: "t7", secrets: [{ item: "config-file", file: "~/../etc/passwd" }] },
      /secrets\.0\.file/,
    );
    await bad({ name: "t8", secrets: [{ item: "config-file", file: "/etc/x" }] }, /~\//);
    await bad(
      { name: "t9", secrets: [{ item: "config-file", file: "~/x", mode: "0644" }] },
      /mode/,
    );
    await bad(
      {
        name: "t10",
        secrets: [
          { item: "agent-token", env: "SAME" },
          { item: "plain-env", env: "SAME" },
        ],
      },
      /SAME/,
    );
    await bad(
      {
        name: "t11",
        secrets: [
          { item: "config-file", file: "~/a" },
          { item: "plain-env", file: "~/./a" },
        ],
      },
      /~\/\.\/a is mapped twice/,
    );
    await bad({ name: "t12", provisioning: { tokenItem: "nope" } }, /provisioning\.tokenItem/);
    await bad(
      { name: "t13", provisioning: { repoUrl: "https://user:pw@example.com/r.git" } },
      /provisioning\.repoUrl/,
    );
    await bad({ name: "basic" }, /already exists/);
    await bad({ name: "t14", credentials: { gh: "agent-token" } }, /credentials/);

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

  it("reports an invalid entry from the settings file and does not apply it", async () => {
    // settings.update validates, so only a hand-edited file holds an invalid entry.
    const file = join(server.home, ".band", "settings.json");
    const settings = JSON.parse(readFileSync(file, "utf8"));
    settings.workerProfiles = [
      { name: "broken", trust: "root" },
      { name: "missing-item", secrets: [{ item: "gone", env: "FOO" }] },
    ];
    writeFileSync(file, JSON.stringify(settings));
    try {
      const listed = await q<{
        profiles: unknown[];
        invalid: Array<{ name: string; error: string }>;
      }>("workerProfiles.list");
      expect(listed.profiles).toEqual([]);
      expect(listed.invalid.find((i) => i.name === "broken")?.error).toContain("trust");
      expect(listed.invalid.find((i) => i.name === "missing-item")?.error).toContain("gone");
      await expect(attach("broken")).rejects.toThrow(/No profile/);
    } finally {
      settings.workerProfiles = [];
      writeFileSync(file, JSON.stringify(settings));
    }
  });
});

describe("who may read or change profiles (S7)", () => {
  it("answers a non-admin device token with 403 and hides profiles and reports", async () => {
    await m("workerProfiles.create", {
      name: "secretive",
      secrets: [{ item: "agent-token", env: "CLAUDE_CODE_OAUTH_TOKEN" }],
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
      await trpcQuery(server.url, "vault.list", undefined, deviceToken),
    ]) {
      expect(res.status).toBe(403);
    }
    const viewer = JSON.stringify(await call("q", "settings.get", undefined, deviceToken));
    expect(viewer).not.toContain("secretive");
    expect(viewer).not.toContain("agent-token");
    const hosts = await call<{ hosts: HostRow[] }>("q", "hosts.list", undefined, deviceToken);
    expect(hosts.hosts.find((h) => h.id === hostId)?.secretFiles ?? null).toBeNull();
    const admin = JSON.stringify(await q("settings.get"));
    expect(admin).toContain("secretive");
    await m("workerProfiles.delete", { name: "secretive" });
  });
});

describe("profile secrets on the worker (S2, S3, S4)", () => {
  let startedBefore = 0;
  const sessions = () =>
    existsSync(stubLog)
      ? readFileSync(stubLog, "utf8")
          .split("\n")
          .filter(Boolean)
          .map(
            (l) =>
              JSON.parse(l) as { method: string; env: { NAMED: Record<string, string | null> } },
          )
          .filter((r) => r.method === "session/new")
      : [];
  const startAgent = async (chatId: string) => {
    startedBefore = sessions().length;
    await m("chats.create", { worktreeId, id: chatId });
    const res = await fetch(`${server.url}/api/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `band_token=${TOKEN}` },
      body: JSON.stringify({ worktreeId, text: "hello" }),
    });
    expect(res.ok).toBe(true);
    return waitFor(
      () => {
        const found = sessions();
        return found.length > startedBefore ? found[found.length - 1] : undefined;
      },
      { label: "agent started", timeoutMs: 30_000 },
    );
  };

  it("S2: a mapped item reaches terminals and agents, and no profile means none", async () => {
    expect(await terminalEnv("PROFILE_PLAIN")).toBe("");
    const before = await startAgent("no-profile-chat");
    expect(before.env.NAMED.CLAUDE_CODE_OAUTH_TOKEN).toBeNull();

    await m("workerProfiles.create", {
      name: "envs",
      secrets: [
        { item: "plain-env", env: "PROFILE_PLAIN" },
        { item: "agent-token", env: "CLAUDE_CODE_OAUTH_TOKEN" },
      ],
    });
    await attach("envs");
    expect(await terminalEnv("PROFILE_PLAIN")).toBe("plain-value");
    const withProfile = await startAgent("profile-chat");
    expect(withProfile.env.NAMED.CLAUDE_CODE_OAUTH_TOKEN).toBe(AGENT_VALUE_1);

    // S4: rotating the item reaches the next process, with no worker restart.
    await putItem("agent-token", AGENT_VALUE_2);
    const rotated = await startAgent("rotated-chat");
    expect(rotated.env.NAMED.CLAUDE_CODE_OAUTH_TOKEN).toBe(AGENT_VALUE_2);

    await attach(null);
    expect(await terminalEnv("PROFILE_PLAIN")).toBe("");
  }, 180_000);

  it("S2: git the hub runs on the worker gets the profile env and files", async () => {
    const pullInput = { repo: "proj", name: "feat", hostId };
    // An askpass script (a file secret, mode 0700) answers git with the password from another item.
    await putItem(
      "askpass-script",
      `#!/bin/sh\ncase "$1" in\n  Username*) echo band-bot ;;\n  *) echo "$STUB_GIT_PASSWORD" ;;\nesac\n`,
    );
    await putItem("askpass-path", home("bin/askpass"));
    await putItem("git-password", STUB_PASSWORD);
    await inWorkerShell("git branch --set-upstream-to=origin/main >/dev/null 2>&1");
    const rejectedBefore = stub.rejected;
    await expect(m("worktrees.gitPull", pullInput)).rejects.toThrow();
    expect(stub.rejected).toBeGreaterThan(rejectedBefore);

    await m("workerProfiles.create", {
      name: "git-auth",
      secrets: [
        { item: "askpass-script", file: "~/bin/askpass", mode: "0700" },
        { item: "askpass-path", env: "GIT_ASKPASS" },
        { item: "git-password", env: "STUB_GIT_PASSWORD" },
      ],
    });
    await attach("git-auth");
    await waitFor(() => (existsSync(home("bin/askpass")) ? true : undefined), {
      label: "askpass written",
      timeoutMs: 30_000,
    });
    expect(modeOf(home("bin/askpass"))).toBe("700");
    const authedBefore = stub.authenticated.length;
    await m("worktrees.gitPull", pullInput);
    expect(stub.authenticated.slice(authedBefore)).toContain("band-bot");

    await attach(null);
    await waitFor(() => (existsSync(home("bin/askpass")) ? undefined : true), {
      label: "askpass deleted",
      timeoutMs: 30_000,
    });
  }, 180_000);

  it("S3: files are written with their mode, rewritten, deleted, and other files never touched", async () => {
    const config = home(".config/tool/config");
    const foreign = home(".foreign");
    writeFileSync(foreign, "mine\n");
    const outside = tmp("band-wprofiles-outside-");
    symlinkSync(outside, home("escape"));

    await m("workerProfiles.create", {
      name: "files",
      secrets: [
        { item: "config-file", file: "~/.config/tool/config" },
        { item: "plain-env", file: "~/.foreign" },
        { item: "plain-env", file: "~/escape/secret" },
      ],
    });
    await attach("files");
    await waitFor(() => (existsSync(config) ? true : undefined), {
      label: "config written",
      timeoutMs: 30_000,
    });
    expect(readFileSync(config, "utf8")).toBe("first contents\n");
    expect(modeOf(config)).toBe("600");
    // A file Band did not create is left alone, and so is a path through a symlink out of home.
    expect(readFileSync(foreign, "utf8")).toBe("mine\n");
    expect(existsSync(join(outside, "secret"))).toBe(false);
    const report = await waitFor(
      async () => {
        const r = (await hostRow())?.secretFiles;
        return r && r.refused.length === 2 ? r : undefined;
      },
      { label: "refusals reported", timeoutMs: 30_000 },
    );
    expect(report.written).toEqual(["~/.config/tool/config"]);
    expect(report.refused.find((r) => r.path === "~/.foreign")?.reason).toMatch(/did not create/);
    expect(report.refused.find((r) => r.path === "~/escape/secret")?.reason).toMatch(/symlink/);

    // A changed item rewrites the file.
    await putItem("config-file", "second contents\n");
    await waitFor(() => (readFileSync(config, "utf8") === "second contents\n" ? true : undefined), {
      label: "config rewritten",
      timeoutMs: 30_000,
    });
    expect(modeOf(config)).toBe("600");

    // Removing the mapping deletes the file Band wrote, and only that one.
    await setSecrets("files", [{ item: "plain-env", file: "~/.foreign" }]);
    await waitFor(() => (existsSync(config) ? undefined : true), {
      label: "config deleted",
      timeoutMs: 30_000,
    });
    expect(readFileSync(foreign, "utf8")).toBe("mine\n");
    await attach(null);
  }, 180_000);
});

describe("trust", () => {
  it("attaching a profile applies its trust, and none restores today's behaviour", async () => {
    await m("hosts.setTrust", { hostId, trust: "standard" });
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
