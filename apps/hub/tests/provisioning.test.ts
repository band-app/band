// Integration tests for one-line host provisioning. A real hub (the
// production bundle, temp BAND_HOME) serves the real shell script, and the tests run it with
// `sh` in a temp HOME. The worker is the real `band-worker` from this checkout. The script
// installs it through `BAND_WORKER_CMD`, a documented setting: the wrapper below stands in for
// the service manager and starts the worker as a plain background process, because a test must
// not install a launchd or systemd unit. Provisioning repos are local bare repos, and the
// private one sits behind the basic-auth git stub with a vault git credential.

import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type GitHttpAuthStub, startGitHttpAuthStub } from "./fixtures/git-http-auth-stub";
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

const TOKEN = "provisioning-shared-secret";
const GIT_TOKEN = "gitpat_provision_0123456789abcdef";
const WORKER_BIN = join(import.meta.dirname, "../../worker/bin/band-worker.mjs");

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
  execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...identity } }).trim();

const makeServer = async (prefix: string, env: Record<string, string> = {}) => {
  const home = createTmpHome(prefix);
  scratch.push(home);
  seedSettings(home, { tokenSecret: TOKEN });
  return startServer({ tmpHome: home, remoteHost: false, env: { BAND_SERVE_UI: "false", ...env } });
};

const call = (url: string, token = TOKEN) => ({
  q: <T>(procedure: string, input?: unknown) =>
    trpcQuery(url, procedure, input, token).then(async (res) => {
      if (res.status !== 200)
        throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
      return trpcData<T>(res);
    }),
  m: <T>(procedure: string, input: unknown) =>
    trpcMutate(url, procedure, input, token).then(async (res) => {
      if (res.status !== 200)
        throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
      return trpcData<T>(res);
    }),
});

interface Command {
  id: string;
  command: string;
  cloudInit: string;
  expiresAt: number;
  commitSha: string | null;
}
interface View {
  id: string;
  status: string;
  hostId: string | null;
  exitCode: number | null;
  log: string;
  commitSha: string | null;
}

/** A machine for the script: a temp HOME, the wrapper that starts the worker, and a pid list. */
interface Machine {
  home: string;
  env: Record<string, string>;
}
const pids: number[] = [];

function makeMachine(): Machine {
  const home = tmp("band-provision-machine-");
  const root = join(home, "worker-root");
  const state = join(home, "worker-state");
  mkdirSync(root);
  const wrapper = join(home, "band-worker-wrapper.sh");
  writeFileSync(
    wrapper,
    `#!/bin/sh
case "$1" in
  install-service)
    nohup "${process.execPath}" "${WORKER_BIN}" --hub "$BAND_HUB_URL" --token "$BAND_WORKER_TOKEN" \\
      --root "${root}" --state-dir "${state}" >"${home}/worker.log" 2>&1 </dev/null &
    echo $! >"${home}/worker.pid"
    echo install-service >>"${home}/wrapper-calls"
    ;;
  status)
    [ -f "${home}/worker.pid" ] && kill -0 "$(cat "${home}/worker.pid")" 2>/dev/null
    ;;
esac
`,
  );
  chmodSync(wrapper, 0o755);
  // Only the variables a fresh machine would have. No BAND_* from the test process.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    TMPDIR: home,
    BAND_WORKER_CMD: wrapper,
    BAND_PROVISION_ROOT_STEPS: "off",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  return { home, env };
}

function readPid(machine: Machine) {
  const file = join(machine.home, "worker.pid");
  if (existsSync(file)) pids.push(Number(readFileSync(file, "utf8").trim()));
}

/** Runs a pasted command line and returns its exit code and output. */
function run(machine: Machine, line: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", line], {
      env: machine.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c: Buffer) => {
      out += c;
    });
    child.stderr.on("data", (c: Buffer) => {
      out += c;
    });
    child.on("close", (code) => {
      readPid(machine);
      resolve({ code: code ?? -1, out });
    });
  });
}

/** A bare provisioning repo whose start command is `body`. Returns the bare repo's path. */
function makeRepo(base: string, name: string, body: string): { bare: string; work: string } {
  const work = join(base, `${name}-work`);
  const bare = join(base, `${name}.git`);
  mkdirSync(join(work, "band"), { recursive: true });
  git(work, "init", "-q", "-b", "main");
  writeFileSync(join(work, "band", "provision.sh"), body);
  chmodSync(join(work, "band", "provision.sh"), 0o755);
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "init");
  git(base, "clone", "-q", "--bare", work, bare);
  return { bare, work };
}

const startWorkerLine = `nohup "${process.execPath}" "${WORKER_BIN}" --hub "$BAND_HUB_URL" --token "$BAND_BOOTSTRAP_TOKEN" --root "$OUT/root" --state-dir "$OUT/state" >"$OUT/worker.log" 2>&1 </dev/null &
echo $! >"$OUT/worker.pid"
cp "$OUT/worker.pid" "$HOME/worker.pid"
mkdir -p "$HOME/.band/worker-service" "$HOME/Library/LaunchAgents"
echo "BAND_WORKER_ID=\\"$BAND_WORKER_ID\\"" >"$HOME/.band/worker-service/worker.env"
echo "<string>$BAND_WORKER_ID</string>" >"$HOME/Library/LaunchAgents/app.band.worker.plist"`;

let server: ServerHandle;
let api: ReturnType<typeof call>;
let base: string;
let stub: GitHttpAuthStub;

const hostsList = () =>
  api.q<{ hosts: Array<{ id: string; status: string }> }>("hosts.list").then((r) => r.hosts);
const waitOnline = (hostId: string) =>
  waitFor(
    async () =>
      (await hostsList()).find((h) => h.id === hostId)?.status === "online" ? true : undefined,
    { label: `host ${hostId} online`, timeoutMs: 45_000 },
  );
const create = (hostName?: string) =>
  api.m<Command>("provisioning.createCommand", { hubUrl: server.url, hostName });
const status = async (id: string) =>
  (await api.q<{ commands: View[] }>("provisioning.status", { id })).commands[0];

beforeAll(async () => {
  base = tmp("band-provision-");
  server = await makeServer("band-provision-hub-");
  api = call(server.url);
}, 120_000);

afterAll(async () => {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  await server?.close();
  await stub?.stop();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

describe("the command and the script (S1)", () => {
  it("shows a curl line with its expiry and serves a script with no secret that spends nothing", async () => {
    const made = await create("first");
    expect(made.command).toMatch(
      new RegExp(
        `^curl -fsSL ${server.url.replace(/[.]/g, "\\.")}/api/provision/bpc_[\\w-]+/script \\| sh$`,
      ),
    );
    expect(made.expiresAt - Date.now()).toBeGreaterThan(55 * 60_000);
    expect(made.expiresAt - Date.now()).toBeLessThanOrEqual(60 * 60_000);
    expect(made.cloudInit).toContain("#cloud-config");
    expect(made.cloudInit).toContain("runcmd:");
    expect(made.cloudInit).toContain(made.command);

    const url = made.command.split(" ")[2];
    const first = await fetch(url);
    const second = await fetch(url);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const script = await first.text();
    expect(await second.text()).toBe(script);
    expect(script.startsWith("#!/bin/sh")).toBe(true);
    for (const prefix of ["bwb_", "bws_", "bpr_", "bdt_"]) expect(script).not.toContain(prefix);
    expect((await status(made.id)).status).toBe("waiting");
    expect((await fetch(`${server.url}/api/provision/bpc_unknown/script`)).status).toBe(404);
  });
});

const hasShellcheck = (() => {
  try {
    execFileSync("shellcheck", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("the script's syntax (S8)", () => {
  it("parses as POSIX sh", async () => {
    const made = await create("syntax");
    const file = join(tmp("band-provision-lint-"), "provision.sh");
    writeFileSync(file, await (await fetch(made.command.split(" ")[2])).text());
    execFileSync("sh", ["-n", file]);
  });

  it.skipIf(!hasShellcheck)("passes shellcheck", async () => {
    const made = await create("shellcheck");
    const file = join(tmp("band-provision-lint-"), "provision.sh");
    writeFileSync(file, await (await fetch(made.command.split(" ")[2])).text());
    execFileSync("shellcheck", ["--shell=sh", file]);
  });
});

describe("the default install (S2)", () => {
  it("exchanges the code, installs a worker that goes online, and refuses a second run", async () => {
    const made = await create("plain");
    const machine = makeMachine();
    const first = await run(machine, made.command);
    expect(first.out).toContain("Done.");
    expect(first.code).toBe(0);

    const view = await status(made.id);
    expect(view.hostId).toMatch(/^h-/);
    await waitOnline(view.hostId as string);
    expect((await status(made.id)).status).toBe("online");
    expect((await status(made.id)).log).toContain("No provisioning repo");

    const again = await run(machine, made.command);
    expect(again.code).not.toBe(0);
    expect(again.out).toContain("already used or has expired");
    const hostIds = (await hostsList()).map((h) => h.id);
    expect(hostIds.filter((id) => id === view.hostId)).toHaveLength(1);
  }, 90_000);
});

describe("a provisioning repo (S3)", () => {
  it("runs the start command from the commit pinned when the command was made", async () => {
    const out = tmp("band-provision-out-");
    const repo = makeRepo(
      base,
      "public",
      `#!/bin/sh
OUT="${out}"
mkdir -p "$OUT/root"
env | cut -d= -f1 | sort >"$OUT/env-names"
echo v1 >"$OUT/version"
${startWorkerLine}
`,
    );
    const pinned = git(repo.bare, "rev-parse", "main");
    await api.m("provisioning.updateSettings", {
      repoUrl: `file://${repo.bare}`,
      branch: "main",
      command: "band/provision.sh",
    });
    const made = await create("custom");
    expect(made.commitSha).toBe(pinned);

    // A later push must not change what this command runs.
    writeFileSync(join(repo.work, "band", "provision.sh"), "#!/bin/sh\nexit 3\n");
    git(repo.work, "commit", "-aq", "-m", "v2");
    git(repo.work, "push", "-q", repo.bare, "main");

    const machine = makeMachine();
    const result = await run(machine, made.command);
    expect(result.code).toBe(0);
    expect(readFileSync(join(out, "version"), "utf8").trim()).toBe("v1");
    const names = readFileSync(join(out, "env-names"), "utf8").split("\n");
    for (const name of [
      "BAND_HUB_URL",
      "BAND_BOOTSTRAP_TOKEN",
      "BAND_WORKER_ID",
      "BAND_WORKER_LABELS",
      "BAND_HOST_LABELS",
      "BAND_PROVISION_DIR",
    ]) {
      expect(names).toContain(name);
    }
    pids.push(Number(readFileSync(join(out, "worker.pid"), "utf8").trim()));
    const view = await status(made.id);
    expect(view.commitSha).toBe(pinned);
    await waitOnline(view.hostId as string);
  }, 90_000);
});

describe("the pinned worker after a provisioning repo (S1, S2)", () => {
  it("installs the hub's worker version after a start command that only writes a marker", async () => {
    const pinned = await makeServer("band-provision-pinned-", { BAND_HUB_VERSION: "0.1.1" });
    try {
      const pinnedApi = call(pinned.url);
      const out = tmp("band-provision-pinned-out-");
      const repo = makeRepo(
        base,
        "marker",
        `#!/bin/sh
OUT="${out}"
echo marker >"$OUT/marker"
env | grep -E '^BAND_(WORKER_VERSION|WORKER_ID)=' >"$OUT/env"
`,
      );
      await pinnedApi.m("provisioning.updateSettings", {
        repoUrl: `file://${repo.bare}`,
        branch: "main",
        command: "band/provision.sh",
      });
      const made = await pinnedApi.m<Command>("provisioning.createCommand", {
        hubUrl: pinned.url,
      });
      const machine = makeMachine();
      // Install through npm like a real machine, with an npm that records what it was asked for.
      delete machine.env.BAND_WORKER_CMD;
      const bin = join(machine.home, "fake-bin");
      mkdirSync(bin);
      const npmLog = join(machine.home, "npm-args");
      writeFileSync(
        join(bin, "npm"),
        `#!/bin/sh
echo "$*" >"${npmLog}"
PREFIX=""
while [ $# -gt 0 ]; do [ "$1" = --prefix ] && PREFIX="$2"; shift; done
mkdir -p "$PREFIX/bin"
cp "${join(machine.home, "band-worker-wrapper.sh")}" "$PREFIX/bin/band-worker"
`,
      );
      chmodSync(join(bin, "npm"), 0o755);
      machine.env.PATH = `${bin}:${machine.env.PATH}`;
      const result = await run(machine, made.command);
      expect(result.code).toBe(0);
      expect(existsSync(join(out, "marker"))).toBe(true);
      const names = readFileSync(join(out, "env"), "utf8");
      expect(names).toContain("BAND_WORKER_VERSION=0.1.1");
      expect(readFileSync(npmLog, "utf8")).toContain("@band-app/worker@0.1.1");
      const view = (await pinnedApi.q<{ commands: View[] }>("provisioning.status", { id: made.id }))
        .commands[0];
      expect(view.log).toContain("Installing the worker 0.1.1");
      await waitFor(
        async () =>
          (
            await pinnedApi.q<{
              hosts: Array<{ id: string; status: string; workerVersion?: string }>;
            }>("hosts.list")
          ).hosts.find((h) => h.id === view.hostId && h.status === "online"),
        { label: "pinned host online", timeoutMs: 45_000 },
      );
      expect(readFileSync(join(machine.home, "wrapper-calls"), "utf8").trim()).toBe(
        "install-service",
      );
    } finally {
      await pinned.close();
    }
  }, 90_000);
});

describe("a start command that installs the service itself (S3)", () => {
  it("skips Band's own install and leaves one service", async () => {
    const out = tmp("band-provision-self-out-");
    const repo = makeRepo(
      base,
      "self",
      `#!/bin/sh
OUT="${out}"
mkdir -p "$OUT/root" "$HOME/.band/worker-service"
echo "BAND_WORKER_ID="$BAND_WORKER_ID"" >"$HOME/.band/worker-service/worker.env"
${startWorkerLine}
`,
    );
    await api.m("provisioning.updateSettings", {
      repoUrl: `file://${repo.bare}`,
      branch: "main",
      command: "band/provision.sh",
    });
    const made = await create("self");
    const machine = makeMachine();
    // The start command starts the worker itself, so the machine's status reports it running.
    const wrapper = machine.env.BAND_WORKER_CMD;
    writeFileSync(
      wrapper,
      `#!/bin/sh
case "$1" in
  status) kill -0 "$(cat "${out}/worker.pid")" 2>/dev/null ;;
  *) echo "$*" >>"${machine.home}/wrapper-calls" ;;
esac
`,
    );
    const result = await run(machine, made.command);
    expect(result.code).toBe(0);
    pids.push(Number(readFileSync(join(out, "worker.pid"), "utf8").trim()));
    expect(existsSync(join(machine.home, "wrapper-calls"))).toBe(false);
    const view = await status(made.id);
    expect(view.log).toContain("already installed and running: skipping Band's worker install");
    await waitOnline(view.hostId as string);
  }, 90_000);
});

describe("root steps after a skipped install", () => {
  it("still enables lingering when the repo installed the service itself", async () => {
    const out = tmp("band-provision-linger-out-");
    const repo = makeRepo(
      base,
      "linger",
      `#!/bin/sh
OUT="${out}"
mkdir -p "$OUT/root"
${startWorkerLine}
`,
    );
    await api.m("provisioning.updateSettings", {
      repoUrl: `file://${repo.bare}`,
      branch: "main",
      command: "band/provision.sh",
    });
    const made = await create("linger");
    const machine = makeMachine();
    // The root steps run on Linux only, so pose as Linux with a fake uname, and give the machine
    // a sudo that works without a password and records what it was asked to run.
    const bin = join(machine.home, "fake-bin");
    mkdirSync(bin);
    const sudoLog = join(machine.home, "sudo-calls");
    writeFileSync(
      join(bin, "uname"),
      '#!/bin/sh\n[ "$1" = -s ] && echo Linux || /usr/bin/uname "$@"\n',
    );
    writeFileSync(
      join(bin, "sudo"),
      `#!/bin/sh\n[ "$2" = true ] && exit 0\necho "$*" >>"${sudoLog}"\n`,
    );
    chmodSync(join(bin, "uname"), 0o755);
    chmodSync(join(bin, "sudo"), 0o755);
    machine.env.PATH = `${bin}:${machine.env.PATH}`;
    machine.env.BAND_PROVISION_ROOT_STEPS = "on";
    const result = await run(machine, made.command);
    expect(result.code).toBe(0);
    pids.push(Number(readFileSync(join(out, "worker.pid"), "utf8").trim()));
    expect(existsSync(join(machine.home, "wrapper-calls"))).toBe(false);
    expect(readFileSync(sudoLog, "utf8")).toMatch(/^-n loginctl enable-linger /m);
    await waitOnline((await status(made.id)).hostId as string);
  }, 90_000);
});

describe("a private provisioning repo (S4)", () => {
  it("fetches it with the vault credential on a machine that has none", async () => {
    const out = tmp("band-provision-private-out-");
    const remotes = join(base, "remotes");
    mkdirSync(remotes, { recursive: true });
    makeRepo(
      remotes,
      "proj",
      `#!/bin/sh
OUT="${out}"
mkdir -p "$OUT/root"
echo private >"$OUT/marker"
${startWorkerLine}
`,
    );
    stub = await startGitHttpAuthStub(remotes, { username: "band-bot", password: GIT_TOKEN });
    await api.m("provisioning.updateSettings", {
      repoUrl: `${stub.url}/proj.git`,
      branch: "main",
      command: "band/provision.sh",
    });

    // No credential in the vault yet: making the command fails and says why.
    await expect(create("private")).rejects.toThrow(/Could not fetch the provisioning repo/);

    await api.m("vault.put", {
      name: "provisioning-git",
      kind: "git",
      host: stub.host,
      pathPattern: "proj",
      username: "band-bot",
      value: GIT_TOKEN,
    });
    const made = await create("private");
    const machine = makeMachine();
    const result = await run(machine, made.command);
    expect(result.code).toBe(0);
    expect(readFileSync(join(out, "marker"), "utf8").trim()).toBe("private");
    expect(stub.authenticated.length).toBeGreaterThan(0);
    expect(result.out).not.toContain(GIT_TOKEN);
    expect(JSON.stringify(await api.q("provisioning.status"))).not.toContain(GIT_TOKEN);
    pids.push(Number(readFileSync(join(out, "worker.pid"), "utf8").trim()));
    await waitOnline((await status(made.id)).hostId as string);
  }, 90_000);
});

describe("a start command that fails (S6)", () => {
  it("shows the host as failed with a log that holds no token", async () => {
    const repo = makeRepo(
      base,
      "failing",
      `#!/bin/sh
echo "token is $BAND_BOOTSTRAP_TOKEN"
echo "could not install the toolchain" >&2
exit 1
`,
    );
    await api.m("provisioning.updateSettings", {
      repoUrl: `file://${repo.bare}`,
      branch: "main",
      command: "band/provision.sh",
    });
    const made = await create("failing");
    const machine = makeMachine();
    const result = await run(machine, made.command);
    expect(result.code).toBe(1);
    const token = /token is (bwb_[\w-]+)/.exec(result.out)?.[1];
    expect(token).toBeTruthy();

    const view = await waitFor(
      async () => {
        const v = await status(made.id);
        return v.status === "failed" ? v : undefined;
      },
      { label: "failed status", timeoutMs: 15_000 },
    );
    expect(view.exitCode).toBe(1);
    expect(view.log).toContain("could not install the toolchain");
    expect(view.log).toContain("token is [redacted]");
    expect(view.log).not.toContain(token as string);
    expect(JSON.stringify(await api.q("provisioning.status"))).not.toContain(token as string);
    const host = (await hostsList()).find((h) => h.id === view.hostId);
    expect(host?.status).not.toBe("online");
  }, 60_000);
});

describe("an expired code (S5)", () => {
  it("is refused at the exchange and leaves no host behind", async () => {
    const short = await makeServer("band-provision-short-", { BAND_PROVISION_TTL_MS: "1200" });
    try {
      const shortApi = call(short.url);
      const made = await shortApi.m<Command>("provisioning.createCommand", { hubUrl: short.url });
      await new Promise((r) => setTimeout(r, 1800));
      const before = (await shortApi.q<{ hosts: unknown[] }>("hosts.list")).hosts.length;
      const result = await run(makeMachine(), made.command);
      expect(result.code).not.toBe(0);
      expect(result.out).toContain("already used or has expired");
      expect((await shortApi.q<{ hosts: unknown[] }>("hosts.list")).hosts).toHaveLength(before);
      const id = made.id;
      const view = (await shortApi.q<{ commands: View[] }>("provisioning.status", { id }))
        .commands[0];
      expect(view.status).toBe("expired");
    } finally {
      await short.close();
    }
  }, 60_000);
});

describe("a run that never says hello", () => {
  it("is marked failed, with its log, after BAND_PROVISION_TIMEOUT_MS", async () => {
    const short = await makeServer("band-provision-timeout-", {
      BAND_PROVISION_TIMEOUT_MS: "1500",
    });
    try {
      const shortApi = call(short.url);
      const made = await shortApi.m<Command>("provisioning.createCommand", { hubUrl: short.url });
      // A worker command that installs nothing and exits 0, so the run ends and no hello follows.
      const machine = makeMachine();
      writeFileSync(machine.env.BAND_WORKER_CMD, "#!/bin/sh\necho installed nothing\nexit 0\n");
      const result = await run(machine, made.command);
      expect(result.code).toBe(0);
      const read = async () =>
        (await shortApi.q<{ commands: View[] }>("provisioning.status", { id: made.id }))
          .commands[0];
      expect((await read()).status).toBe("provisioning");
      const failed = await waitFor(
        async () => {
          const v = await read();
          return v.status === "failed" ? v : undefined;
        },
        { label: "timed out", timeoutMs: 15_000 },
      );
      expect(failed.exitCode).toBe(0);
      expect(failed.log).toContain("installed nothing");
      expect(failed.log).toContain("did not say hello");
    } finally {
      await short.close();
    }
  }, 60_000);
});

describe("the worker relay (S7)", () => {
  it("refuses provisioning.* from an agent at every trust level", async () => {
    const { checkRelayRequest } = await import("../src/server/services/relay-scope");
    const lookups: Parameters<typeof checkRelayRequest>[2] = {
      hostOfWorktree: () => "h-a",
      worktreeOfChat: () => null,
      worktreeOfCwd: () => null,
      hostOfTerminal: () => null,
      worktreeOfBrowser: () => null,
      worktreeOfSubscription: () => null,
      crossHostRefusal: () => null,
      repoHostRefusal: () => null,
    };
    for (const trust of ["restricted", "standard", "admin"] as const) {
      for (const procedure of ["createCommand", "status", "settings", "updateSettings"]) {
        const verdict = checkRelayRequest(
          {
            scope: { worktreeId: "proj-main@h-a" },
            method: "POST",
            path: `/trpc/provisioning.${procedure}`,
            headers: {},
            body: Buffer.from("{}", "utf8").toString("base64"),
          },
          "h-a",
          { ...lookups, trustOf: () => trust },
        );
        expect(verdict.ok, `${trust} ${procedure}`).toBe(false);
        expect(!verdict.ok && verdict.status).toBe(403);
      }
    }
  });
});

describe("access (S7)", () => {
  it("refuses a non-admin device token, the log and bundle without the run token, and leaves MCP out", async () => {
    const created = await api.m<{ token: string }>("tokens.createDevice", { label: "phone" });
    for (const [procedure, input] of [
      ["provisioning.createCommand", { hubUrl: server.url }],
      ["provisioning.updateSettings", { repoUrl: "" }],
      ["provisioning.status", undefined],
      ["provisioning.settings", undefined],
    ] as const) {
      const res =
        procedure === "provisioning.status" || procedure === "provisioning.settings"
          ? await trpcQuery(server.url, procedure, input, created.token)
          : await trpcMutate(server.url, procedure, input, created.token);
      expect(res.status, procedure).toBe(403);
    }
    expect((await trpcQuery(server.url, "provisioning.status", undefined, "")).status).toBe(401);
    expect(
      (await trpcMutate(server.url, "provisioning.createCommand", { hubUrl: server.url }, ""))
        .status,
    ).toBe(401);
    const update = await trpcMutate(
      server.url,
      "settings.update",
      { provisioning: { repoUrl: "file:///x" } },
      created.token,
    );
    expect(update.status).toBe(403);

    const made = await create("guarded");
    const code = made.command.split("/")[5];
    expect((await fetch(`${server.url}/api/provision/${code}/bundle`)).status).toBe(401);
    expect(
      (await fetch(`${server.url}/api/provision/${code}/log`, { method: "POST", body: "x" }))
        .status,
    ).toBe(401);

    const mcp = await fetch(`${server.url}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(await mcp.text()).not.toContain("band_provisioning_");
  });
});
