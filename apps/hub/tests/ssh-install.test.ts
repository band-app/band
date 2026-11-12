// Integration tests for installing a worker over ssh. A real hub (the production bundle, temp
// HOME) runs ssh through its own local worker. `ssh` and `ssh-keyscan` are stub scripts the hub
// finds through BAND_SSH_BIN and BAND_SSH_KEYSCAN_BIN: the ssh stub records every call and, for
// an install, runs the remote command on this machine in a temp HOME, so the real provisioning
// script and the real `band-worker` run. `ssh-keygen` is the real one, on temp files. Nothing
// connects to a real host and nothing reads the real ~/.ssh.

import { execFileSync } from "node:child_process";
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
import { WORKER_BIN } from "./helpers/worker-bin";

const TOKEN = "ssh-install-shared-secret";

const scratch: string[] = [];
const tmp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};

let server: ServerHandle;
let hubHome: string;
let stubs: string;
let machineHome: string;
const pids: number[] = [];

const call = (token = TOKEN) => ({
  q: async <T>(procedure: string, input?: unknown) => {
    const res = await trpcQuery(server.url, procedure, input, token);
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  },
  m: async <T>(procedure: string, input: unknown) => {
    const res = await trpcMutate(server.url, procedure, input, token);
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  },
  raw: (procedure: string, input: unknown, mutate = true) =>
    mutate
      ? trpcMutate(server.url, procedure, input, token)
      : trpcQuery(server.url, procedure, input, token),
});
const api = () => call();

/** A public key "type blob" from a real ssh-keygen. */
function newKey(name: string): { type: string; blob: string } {
  const file = join(stubs, `key-${name}`);
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "t", "-f", file]);
  const [type, blob] = readFileSync(`${file}.pub`, "utf8").trim().split(" ");
  return { type: type as string, blob: blob as string };
}

/** Makes `host` answer ssh-keyscan with a fresh key, and returns it. */
function serveKey(host: string) {
  const key = newKey(host);
  mkdirSync(join(stubs, "hostkeys"), { recursive: true });
  writeFileSync(join(stubs, "hostkeys", host), `${key.type} ${key.blob}\n`);
  return key;
}

const knownHostsFile = () => join(hubHome, ".ssh", "known_hosts");
const readKnownHosts = () =>
  existsSync(knownHostsFile()) ? readFileSync(knownHostsFile(), "utf8") : "";
const sshCalls = () => {
  const file = join(stubs, "ssh-calls");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
};
const installCalls = () => sshCalls().filter((l) => l.startsWith("install "));

interface RunView {
  status: string;
  hostId: string | null;
  log: string;
}
const waitStatus = (id: string, status: string, timeoutMs: number) =>
  waitFor(
    async () => {
      const { commands } = await api().q<{ commands: RunView[] }>("provisioning.status", { id });
      return commands[0]?.status === status ? commands[0] : undefined;
    },
    { label: `command ${id} is ${status}`, timeoutMs },
  );

function writeStubs() {
  const wrapper = join(machineHome, "band-worker-wrapper.sh");
  const root = join(machineHome, "worker-root");
  mkdirSync(root);
  writeFileSync(
    wrapper,
    `#!/bin/sh
case "$1" in
  install-service)
    nohup "${process.execPath}" "${WORKER_BIN}" --hub "$BAND_HUB_URL" --token "$BAND_WORKER_TOKEN" \\
      --root "${root}" --state-dir "${join(machineHome, "worker-state")}" >"${machineHome}/worker.log" 2>&1 </dev/null &
    echo $! >"${machineHome}/worker.pid"
    ;;
  status)
    [ -f "${machineHome}/worker.pid" ] && kill -0 "$(cat "${machineHome}/worker.pid")" 2>/dev/null
    ;;
esac
`,
  );
  chmodSync(wrapper, 0o755);
  const ssh = join(stubs, "ssh");
  writeFileSync(
    ssh,
    `#!/bin/sh
if [ "$1" = "-G" ]; then
  target="$3"; host="\${target#*@}"
  echo "hostname $host"
  echo "port 22"
  echo "userknownhostsfile ${knownHostsFile()}"
  echo "globalknownhostsfile /nonexistent/known_hosts"
  exit 0
fi
for last; do :; done
cmd="$last"
prev=""; target=""
for a; do
  if [ "$prev" = "--" ]; then target="$a"; break; fi
  prev="$a"
done
echo "install $target" >>"${stubs}/ssh-calls"
echo "args $*" >>"${stubs}/ssh-calls"
case "$target" in
  *denied.example) echo "$target: Permission denied (publickey)." >&2; exit 255 ;;
esac
exec env -i PATH="$PATH" HOME="${machineHome}" TMPDIR="${machineHome}" BAND_WORKER_CMD="${wrapper}" \\
  BAND_PROVISION_ROOT_STEPS=off GIT_CONFIG_NOSYSTEM=1 sh -c "$cmd"
`,
  );
  chmodSync(ssh, 0o755);
  const keyscan = join(stubs, "ssh-keyscan");
  writeFileSync(
    keyscan,
    `#!/bin/sh
for host; do :; done
file="${stubs}/hostkeys/$host"
[ -f "$file" ] || { echo "no route to host" >&2; exit 1; }
echo "$host $(cat "$file")"
`,
  );
  chmodSync(keyscan, 0o755);
}

beforeAll(async () => {
  hubHome = createTmpHome("band-ssh-hub-");
  scratch.push(hubHome);
  stubs = tmp("band-ssh-stubs-");
  machineHome = tmp("band-ssh-machine-");
  writeStubs();
  seedSettings(hubHome, { tokenSecret: TOKEN });
  server = await startServer({
    tmpHome: hubHome,
    remoteHost: false,
    env: {
      BAND_SERVE_UI: "false",
      BAND_SSH_BIN: join(stubs, "ssh"),
      BAND_SSH_KEYSCAN_BIN: join(stubs, "ssh-keyscan"),
    },
  });
}, 120_000);

afterAll(async () => {
  const pidFile = join(machineHome, "worker.pid");
  if (existsSync(pidFile)) pids.push(Number(readFileSync(pidFile, "utf8").trim()));
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  await server?.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

describe("the hosts in the ssh config (S1)", () => {
  it("lists concrete hosts with user@hostname, follows Include, and skips wildcards", async () => {
    mkdirSync(join(hubHome, ".ssh", "config.d"), { recursive: true });
    writeFileSync(
      join(hubHome, ".ssh", "config"),
      `Include config.d/*.conf

Host colima
  User amir
  HostName 192.168.5.15

Host rc-preview
  HostName preview.example.com

Host *
  ServerAliveInterval 30
`,
    );
    writeFileSync(
      join(hubHome, ".ssh", "config.d", "extra.conf"),
      "Host included-box\n  User ops\n  HostName box.example.com\n",
    );
    const hosts = await api().q<Array<{ name: string; label: string }>>("provisioning.sshHosts", {
      workerId: "local",
    });
    expect(hosts.map((h) => h.name).sort()).toEqual(["colima", "included-box", "rc-preview"]);
    expect(hosts.find((h) => h.name === "colima")?.label).toBe("amir@192.168.5.15");
    expect(hosts.find((h) => h.name === "included-box")?.label).toBe("ops@box.example.com");
  });
});

describe("a typed target (S2)", () => {
  it("refuses options, spaces and shell characters before anything runs", async () => {
    for (const target of ["-oProxyCommand=x", "a b", "host;rm", "$(id)", "a`id`", "-J x"]) {
      const inspect = await api().raw("provisioning.sshInspect", { workerId: "local", target });
      expect(inspect.status, target).toBe(400);
      const install = await api().raw("provisioning.sshInstall", {
        workerId: "local",
        target,
        hubUrl: server.url,
      });
      expect(install.status, target).toBe(400);
    }
    expect(sshCalls()).toEqual([]);
  });
});

describe("a host key that is not known yet (S3, S4)", () => {
  it("runs nothing until the fingerprint is confirmed, then installs a worker that goes online", async () => {
    const key = serveKey("fresh.example");
    const inspect = await api().m<{ state: string; fingerprints: Array<{ fingerprint: string }> }>(
      "provisioning.sshInspect",
      { workerId: "local", target: "me@fresh.example" },
    );
    expect(inspect.state).toBe("unknown");
    expect(inspect.fingerprints[0]?.fingerprint).toMatch(/^SHA256:/);

    const input = { workerId: "local", target: "me@fresh.example", hubUrl: server.url };
    expect((await api().raw("provisioning.sshInstall", input)).status).toBe(412);
    const wrong = await api().raw("provisioning.sshInstall", {
      ...input,
      trustFingerprints: ["SHA256:notthekey"],
    });
    expect(wrong.status).toBe(412);
    expect(installCalls()).toEqual([]);
    expect(readKnownHosts()).toBe("");

    const started = await api().m<{ id: string }>("provisioning.sshInstall", {
      ...input,
      hostName: "over-ssh",
      trustFingerprints: inspect.fingerprints.map((f) => f.fingerprint),
    });
    expect(readKnownHosts()).toContain(`fresh.example ${key.type} ${key.blob}`);

    const view = await waitStatus(started.id, "online", 60_000);
    expect(view.log).toContain("No provisioning repo");
    expect(installCalls()).toEqual(["install me@fresh.example"]);
    const args = sshCalls().find((l) => l.startsWith("args "));
    expect(args).toContain("BatchMode=yes");
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).toContain("-- me@fresh.example curl -fsSL");

    const again = await api().m<{ state: string }>("provisioning.sshInspect", {
      workerId: "local",
      target: "me@fresh.example",
    });
    expect(again.state).toBe("known");
  }, 120_000);
});

describe("ssh needs input (S5)", () => {
  it("fails with ssh's message and the hint, and no worker joins", async () => {
    const key = serveKey("denied.example");
    writeFileSync(knownHostsFile(), `${readKnownHosts()}denied.example ${key.type} ${key.blob}\n`);
    const started = await api().m<{ id: string }>("provisioning.sshInstall", {
      workerId: "local",
      target: "me@denied.example",
      hubUrl: server.url,
    });
    const view = await waitStatus(started.id, "failed", 30_000);
    expect(view.log).toContain("Permission denied (publickey)");
    expect(view.log).toContain("ssh-agent");
    expect(view.hostId).toBeNull();
  }, 60_000);
});

describe("a host key that changed (S6)", () => {
  it("refuses to install and runs nothing", async () => {
    const old = newKey("old");
    serveKey("changed.example");
    writeFileSync(knownHostsFile(), `${readKnownHosts()}changed.example ${old.type} ${old.blob}\n`);
    const before = installCalls().length;
    const res = await api().raw("provisioning.sshInstall", {
      workerId: "local",
      target: "changed.example",
      hubUrl: server.url,
      trustFingerprints: ["SHA256:whatever"],
    });
    expect(res.status).toBe(412);
    expect(await res.text()).toContain("host key");
    expect(installCalls().length).toBe(before);
    const inspect = await api().m<{ state: string }>("provisioning.sshInspect", {
      workerId: "local",
      target: "changed.example",
    });
    expect(inspect.state).toBe("changed");
  });
});

describe("access (S7)", () => {
  it("refuses a device token and an agent on the relay, and leaves MCP out", async () => {
    const created = await api().m<{ token: string }>("tokens.createDevice", { label: "phone" });
    const device = call(created.token);
    const before = sshCalls().length;
    expect((await device.raw("provisioning.sshHosts", { workerId: "local" }, false)).status).toBe(
      403,
    );
    expect(
      (await device.raw("provisioning.sshInspect", { workerId: "local", target: "x.example" }))
        .status,
    ).toBe(403);
    expect(
      (
        await device.raw("provisioning.sshInstall", {
          workerId: "local",
          target: "x.example",
          hubUrl: server.url,
        })
      ).status,
    ).toBe(403);
    expect(sshCalls().length).toBe(before);

    const { checkRelayRequest } = await import("../src/server/services/relay-scope");
    for (const trust of ["restricted", "standard", "admin"] as const) {
      for (const procedure of ["sshHosts", "sshInspect", "sshInstall"]) {
        const verdict = checkRelayRequest(
          {
            scope: { worktreeId: "proj-main@h-a" },
            method: "POST",
            path: `/trpc/provisioning.${procedure}`,
            headers: {},
            body: Buffer.from("{}", "utf8").toString("base64"),
          },
          "h-a",
          {
            hostOfWorktree: () => "h-a",
            worktreeOfChat: () => null,
            worktreeOfCwd: () => null,
            hostOfTerminal: () => null,
            worktreeOfBrowser: () => null,
            worktreeOfSubscription: () => null,
            crossHostRefusal: () => null,
            repoHostRefusal: () => null,
            trustOf: () => trust,
          },
        );
        expect(verdict.ok, `${trust} ${procedure}`).toBe(false);
      }
    }

    const mcp = await fetch(`${server.url}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(await mcp.text()).not.toContain("band_provisioning_ssh");
  });
});
