// Tests for the bundled `hetzner` and `contabo` runner hooks (plan step 3.8). Each hook runs as the
// subprocess the hub would start, with the hook contract's environment, against an Express stub of the
// provider's API on a random port (HCLOUD_API_URL, CONTABO_AUTH_URL and CONTABO_API_URL are read on
// every call). No real cloud is called. The cloud-init the hooks send is checked against the
// cloud-config shape, and against `cloud-init schema` when that tool is installed.
//
// The live test against the real providers is in the last describe block. It needs credentials in
// BAND_LIVE_HCLOUD_TOKEN, so it is skipped everywhere else, CI included.

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderCloudInit } from "../../../runners/_shared/cloud-init.mjs";
import { type ContaboStub, startContaboStub } from "./fixtures/contabo-stub";
import { type HetznerStub, startHetznerStub } from "./fixtures/hetzner-stub";

const RUNNERS = join(import.meta.dirname, "../../../runners");
const BOOTSTRAP_TOKEN = "bwb_testtoken0123456789";
const HCLOUD_TOKEN = "hcloud-secret-token";

const scratch: string[] = [];
const tmp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

interface HookResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run `runners/<name>/<hook>.sh` with only the contract's environment plus `extra`. It is async because the
 * stub API runs in this process, and a blocking spawn would stop it from answering.
 */
function hook(
  name: string,
  which: "spawn" | "destroy" | "status" | "snapshot" | "restore" | "snapshot-delete",
  extra: Record<string, string>,
  runnerDir: string,
): Promise<HookResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(join(RUNNERS, name, `${which}.sh`), [], {
      cwd: runnerDir,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: runnerDir,
        BAND_NODE: process.execPath,
        BAND_HUB_URL: "https://hub.example.com",
        BAND_WORKER_ID: "h-0123456789ab",
        BAND_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
        BAND_LABELS: "pool=vm,gpu=none",
        BAND_RUNNER_ID: "vm-runner",
        BAND_REQUEST_ID: "req-1",
        BAND_PROJECT: "proj",
        BAND_REPO_URLS: "https://github.com/example/proj.git",
        BAND_RUNNER_DIR: runnerDir,
        ...extra,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

/** The cloud-config document a hook sent: the `#cloud-config` header, then JSON. */
function parseCloudConfig(userData: string) {
  expect(userData.startsWith("#cloud-config\n")).toBe(true);
  return JSON.parse(userData.slice("#cloud-config\n".length)) as {
    packages: string[];
    write_files: Array<{ path: string; permissions: string; content: string }>;
    runcmd: string[][];
  };
}
const file = (cfg: ReturnType<typeof parseCloudConfig>, path: string) => {
  const found = cfg.write_files.find((f) => f.path === path);
  if (!found) throw new Error(`cloud-init writes no ${path}`);
  return found;
};

describe("hetzner hook", () => {
  let stub: HetznerStub;
  let dir: string;
  const env = () => ({
    HCLOUD_API_URL: stub.url,
    HCLOUD_TOKEN,
    HCLOUD_SERVER_TYPE: "cx32",
    HCLOUD_LOCATION: "nbg1",
    HCLOUD_SSH_KEYS: "ops-key,77",
  });

  beforeEach(async () => {
    stub = await startHetznerStub(HCLOUD_TOKEN);
    dir = tmp("hetzner-hook-");
  });
  afterEach(() => stub.close());

  it("spawn creates a labelled server whose user data starts the worker, and prints the handle", async () => {
    const res = await hook("hetzner", "spawn", env(), dir);
    expect(res.status, res.stderr).toBe(0);
    expect(stub.servers).toHaveLength(1);
    const server = stub.servers[0];
    expect(res.stdout).toContain(`BAND_MACHINE_HANDLE=${server.id}\n`);
    expect(res.stdout).toContain("BAND_HOST_PROJECT_PATH=/home/band/work/proj\n");
    expect(server).toMatchObject({
      name: "band-h-0123456789ab",
      server_type: "cx32",
      image: "ubuntu-24.04",
      location: "nbg1",
      ssh_keys: ["ops-key", 77],
      labels: {
        "band.runner": "vm-runner",
        "band.request": "req-1",
        "band.worker": "h-0123456789ab",
      },
    });
    expect(stub.requests.every((r) => r.authorization === `Bearer ${HCLOUD_TOKEN}`)).toBe(true);

    const cfg = parseCloudConfig(server.user_data);
    const unit = file(cfg, "/etc/systemd/system/band-worker.service").content;
    expect(unit).toContain("ExecStart=/usr/bin/band-worker --ephemeral");
    expect(unit).toContain("ExecStopPost=+/usr/sbin/poweroff");
    const workerEnv = file(cfg, "/etc/band-worker.env");
    expect(workerEnv.permissions).toBe("0600");
    expect(workerEnv.content).toContain('BAND_HUB_URL="https://hub.example.com"');
    expect(workerEnv.content).toContain('BAND_WORKER_ID="h-0123456789ab"');
    expect(workerEnv.content).toContain(`BAND_BOOTSTRAP_TOKEN="${BOOTSTRAP_TOKEN}"`);
    expect(workerEnv.content).toContain('BAND_WORKER_LABELS="pool=vm,gpu=none"');
    expect(file(cfg, "/usr/local/sbin/band-bootstrap.sh").content).toContain("git clone");
  });

  it("never prints the bootstrap token or the API token", async () => {
    const res = await hook("hetzner", "spawn", env(), dir);
    expect(res.status, res.stderr).toBe(0);
    for (const text of [res.stdout, res.stderr]) {
      expect(text).not.toContain(BOOTSTRAP_TOKEN);
      expect(text).not.toContain(HCLOUD_TOKEN);
    }
  });

  it("status lists the server by its labels and destroy deletes it", async () => {
    expect((await hook("hetzner", "spawn", env(), dir)).status).toBe(0);
    const id = stub.servers[0].id;

    const status = await hook("hetzner", "status", env(), dir);
    expect(status.stdout).toBe(
      `BAND_MACHINE_HANDLE=${id} worker=h-0123456789ab request=req-1 state=initializing\n`,
    );

    const destroy = await hook("hetzner", "destroy", env(), dir);
    expect(destroy.status, destroy.stderr).toBe(0);
    expect(stub.servers).toHaveLength(0);
    expect((await hook("hetzner", "status", env(), dir)).stdout).toBe("");
  });

  it("destroy succeeds when there is nothing to delete", async () => {
    const res = await hook("hetzner", "destroy", env(), dir);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("no server to delete");
  });

  it("spawn for a worker id that already has a server replaces it", async () => {
    expect((await hook("hetzner", "spawn", env(), dir)).status).toBe(0);
    const first = stub.servers[0].id;
    expect((await hook("hetzner", "spawn", env(), dir)).status).toBe(0);
    expect(stub.servers).toHaveLength(1);
    expect(stub.servers[0].id).not.toBe(first);
  });

  it("fails the attempt, naming the API's reason, when the token is wrong", async () => {
    const res = await hook("hetzner", "spawn", { ...env(), HCLOUD_TOKEN: "wrong" }, dir);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("401");
    expect(res.stderr).toContain("unable to authenticate");
    expect(stub.servers).toHaveLength(0);
  });

  it("fails when HCLOUD_TOKEN is not in the runner's env", async () => {
    const res = await hook("hetzner", "spawn", { HCLOUD_API_URL: stub.url }, dir);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("HCLOUD_TOKEN is required");
  });

  describe("snapshot, restore and snapshot-delete (plan step 3.10)", () => {
    const polling = () => ({ ...env(), BAND_RUNNER_POLL_MS: "20" });

    it("snapshot makes a labelled image of the server, waits for it and prints its id and size", async () => {
      expect((await hook("hetzner", "spawn", env(), dir)).status).toBe(0);
      const server = stub.servers[0];
      stub.actionPolls.running = 2;
      const res = await hook(
        "hetzner",
        "snapshot",
        { ...polling(), BAND_MACHINE_HANDLE: String(server.id) },
        dir,
      );
      expect(res.status, res.stderr).toBe(0);
      expect(stub.images).toHaveLength(1);
      const image = stub.images[0];
      expect(res.stdout).toContain(`BAND_SNAPSHOT_ID=${image.id}\n`);
      expect(res.stdout).toContain("BAND_SNAPSHOT_SIZE=2500000000\n");
      expect(image).toMatchObject({
        created_from: server.id,
        labels: {
          "band.runner": "vm-runner",
          "band.worker": "h-0123456789ab",
          "band.snapshot": "1",
        },
      });
      // It polled the action until it succeeded.
      expect(stub.requests.filter((r) => r.line.startsWith("GET /actions/"))).toHaveLength(3);
    });

    it("snapshot finds the server by its worker label when it has no handle", async () => {
      expect((await hook("hetzner", "spawn", env(), dir)).status).toBe(0);
      const res = await hook("hetzner", "snapshot", polling(), dir);
      expect(res.status, res.stderr).toBe(0);
      expect(stub.images[0]?.created_from).toBe(stub.servers[0]?.id);
    });

    it("snapshot fails, naming the reason, and deletes the half-made image", async () => {
      expect((await hook("hetzner", "spawn", env(), dir)).status).toBe(0);
      stub.actionPolls.fail = true;
      const res = await hook("hetzner", "snapshot", polling(), dir);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("snapshot failed");
      expect(res.stdout).not.toContain("BAND_SNAPSHOT_ID");
      expect(stub.images).toHaveLength(0);
    });

    it("snapshot fails when the worker has no server", async () => {
      const res = await hook("hetzner", "snapshot", polling(), dir);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("no server for worker h-0123456789ab");
    });

    it("restore creates a server from the image, with cloud-init that skips the install and the clone", async () => {
      expect((await hook("hetzner", "spawn", env(), dir)).status).toBe(0);
      const handle = String(stub.servers[0]?.id);
      expect((await hook("hetzner", "snapshot", polling(), dir)).status).toBe(0);
      const imageId = stub.images[0]?.id as number;
      // The machine was destroyed after its snapshot.
      expect((await hook("hetzner", "destroy", env(), dir)).status).toBe(0);
      expect(stub.servers).toHaveLength(0);

      const res = await hook(
        "hetzner",
        "restore",
        {
          ...env(),
          BAND_SNAPSHOT_ID: String(imageId),
          BAND_BOOTSTRAP_TOKEN: "bwb_newtoken9876543210",
        },
        dir,
      );
      expect(res.status, res.stderr).toBe(0);
      expect(stub.servers).toHaveLength(1);
      const server = stub.servers[0] as (typeof stub.servers)[number];
      expect(server.id).not.toBe(Number(handle));
      expect(server.image).toBe(String(imageId));
      expect(server.labels["band.worker"]).toBe("h-0123456789ab");
      expect(res.stdout).toContain(`BAND_MACHINE_HANDLE=${server.id}\n`);
      // The repository is on the snapshot's disk already.
      expect(res.stdout).not.toContain("BAND_HOST_PROJECT_PATH");

      const cfg = parseCloudConfig(server.user_data);
      expect(file(cfg, "/etc/band-worker.env").content).toContain(
        'BAND_BOOTSTRAP_TOKEN="bwb_newtoken9876543210"',
      );
      const script = file(cfg, "/usr/local/sbin/band-bootstrap.sh").content;
      expect(script).toContain("rm -f '/home/band/work/.band-worker/session-token'");
      expect(script).toContain("systemctl start band-worker.service");
      for (const step of ["git clone", "useradd", "npm install", "apt-get"]) {
        expect(script).not.toContain(step);
      }
      for (const text of [res.stdout, res.stderr]) expect(text).not.toContain("bwb_newtoken");
    });

    it("restore replaces a server the worker id still has, and refuses an id that is not an image", async () => {
      expect((await hook("hetzner", "spawn", env(), dir)).status).toBe(0);
      expect((await hook("hetzner", "snapshot", polling(), dir)).status).toBe(0);
      const imageId = String(stub.images[0]?.id);
      const res = await hook("hetzner", "restore", { ...env(), BAND_SNAPSHOT_ID: imageId }, dir);
      expect(res.status, res.stderr).toBe(0);
      expect(stub.servers).toHaveLength(1);

      const bad = await hook(
        "hetzner",
        "restore",
        { ...env(), BAND_SNAPSHOT_ID: "ubuntu-24.04" },
        dir,
      );
      expect(bad.status).toBe(1);
      expect(bad.stderr).toContain("must be a Hetzner image id");
      const missing = await hook("hetzner", "restore", env(), dir);
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain("BAND_SNAPSHOT_ID is required");
    });

    it("snapshot-delete removes the image and succeeds when it is gone already", async () => {
      expect((await hook("hetzner", "spawn", env(), dir)).status).toBe(0);
      expect((await hook("hetzner", "snapshot", polling(), dir)).status).toBe(0);
      const imageId = String(stub.images[0]?.id);
      const first = await hook(
        "hetzner",
        "snapshot-delete",
        { ...env(), BAND_SNAPSHOT_ID: imageId },
        dir,
      );
      expect(first.status, first.stderr).toBe(0);
      expect(stub.images).toHaveLength(0);
      const again = await hook(
        "hetzner",
        "snapshot-delete",
        { ...env(), BAND_SNAPSHOT_ID: imageId },
        dir,
      );
      expect(again.status, again.stderr).toBe(0);
      expect(again.stdout).toContain("already gone");
    });
  });

  it("docker mode runs the image and the clone path is the container's", async () => {
    const res = await hook(
      "hetzner",
      "spawn",
      { ...env(), BAND_VM_WORKER: "docker", BAND_VM_WORKER_IMAGE: "ghcr.io/example/band-worker:1" },
      dir,
    );
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("BAND_HOST_PROJECT_PATH=/work/proj\n");
    const cfg = parseCloudConfig(stub.servers[0].user_data);
    expect(file(cfg, "/etc/systemd/system/band-worker.service").content).toContain(
      "ghcr.io/example/band-worker:1",
    );
    // docker's --env-file keeps quotes, so the values are bare there
    expect(file(cfg, "/etc/band-worker.env").content).toContain(
      `BAND_BOOTSTRAP_TOKEN=${BOOTSTRAP_TOKEN}\n`,
    );
  });
});

describe("contabo hook", () => {
  const creds = {
    clientId: "cid",
    clientSecret: "csecret",
    user: "ops@example.com",
    password: "pw",
  };
  let stub: ContaboStub;
  let dir: string;
  const env = (extra: Record<string, string> = {}) => ({
    CONTABO_AUTH_URL: `${stub.url}/auth/token`,
    CONTABO_API_URL: `${stub.url}/v1`,
    CONTABO_CLIENT_ID: creds.clientId,
    CONTABO_CLIENT_SECRET: creds.clientSecret,
    CONTABO_API_USER: creds.user,
    CONTABO_API_PASSWORD: creds.password,
    CONTABO_IMAGE_ID: "image-ubuntu",
    CONTABO_POOL: "101,102",
    ...extra,
  });

  beforeEach(async () => {
    stub = await startContaboStub(creds, [
      { instanceId: 101, displayName: "pool-a" },
      { instanceId: 102, displayName: "band-busy-h-someone-else" },
    ]);
    dir = tmp("contabo-hook-");
  });
  afterEach(() => stub.close());

  it("authenticates with the client credentials and reinstalls an idle pool instance with the user data", async () => {
    const res = await hook("contabo", "spawn", env(), dir);
    expect(res.status, res.stderr).toBe(0);
    expect(stub.tokenRequests).toEqual([
      {
        grant_type: "password",
        client_id: "cid",
        client_secret: "csecret",
        username: "ops@example.com",
        password: "pw",
      },
    ]);
    expect(res.stdout).toContain("BAND_MACHINE_HANDLE=101\n");
    const taken = stub.instances.find((i) => i.instanceId === 101);
    expect(taken).toMatchObject({
      displayName: "band-busy-h-0123456789ab",
      imageId: "image-ubuntu",
    });
    const cfg = parseCloudConfig(taken?.userData ?? "");
    expect(file(cfg, "/etc/band-worker.env").content).toContain(
      `BAND_BOOTSTRAP_TOKEN="${BOOTSTRAP_TOKEN}"`,
    );
    expect(file(cfg, "/etc/systemd/system/band-worker.service").content).toContain(
      "ExecStopPost=+/usr/sbin/poweroff",
    );
    // the instance that was busy was not touched
    expect(stub.instances.find((i) => i.instanceId === 102)).toMatchObject({
      imageId: "image-original",
      userData: null,
    });
    expect(res.stdout + res.stderr).not.toContain(BOOTSTRAP_TOKEN);
  });

  it("destroy reinstalls with no user data and returns the instance to the pool", async () => {
    expect((await hook("contabo", "spawn", env(), dir)).status).toBe(0);
    const res = await hook("contabo", "destroy", env(), dir);
    expect(res.status, res.stderr).toBe(0);
    expect(stub.instances.find((i) => i.instanceId === 101)).toMatchObject({
      displayName: "band-idle",
      userData: null,
    });
    // while the reinstall runs the instance is not offered, and once it ends the next spawn can use it
    expect(
      (await hook("contabo", "spawn", env({ BAND_WORKER_ID: "h-ffffffffffff" }), dir)).stderr,
    ).toContain("no idle instance");
    stub.finishInstalls();
    expect(
      (await hook("contabo", "spawn", env({ BAND_WORKER_ID: "h-ffffffffffff" }), dir)).stdout,
    ).toContain("BAND_MACHINE_HANDLE=101\n");
  });

  it("status lists the pool with busy and idle instances", async () => {
    expect((await hook("contabo", "spawn", env(), dir)).status).toBe(0);
    const lines = (await hook("contabo", "status", env(), dir)).stdout.trim().split("\n");
    expect(lines).toEqual([
      "BAND_MACHINE_HANDLE=101 worker=h-0123456789ab request= state=installing",
      "BAND_MACHINE_HANDLE=102 worker=h-someone-else request= state=running",
    ]);
  });

  it("spawn fails when every pool instance is busy", async () => {
    const res = await hook("contabo", "spawn", env({ CONTABO_POOL: "102" }), dir);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("no idle instance");
  });

  it("a worker id that wakes reuses its own instance", async () => {
    expect((await hook("contabo", "spawn", env(), dir)).status).toBe(0);
    const res = await hook("contabo", "spawn", env(), dir);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("BAND_MACHINE_HANDLE=101\n");
  });

  it("new mode buys an instance, and destroy cancels it", async () => {
    const newEnv = env({ CONTABO_MODE: "new", CONTABO_PRODUCT_ID: "V92", CONTABO_POOL: "" });
    const spawned = await hook("contabo", "spawn", newEnv, dir);
    expect(spawned.status, spawned.stderr).toBe(0);
    const bought = stub.instances.find(
      (i) => i.displayName === "band-busy-h-0123456789ab" && i.instanceId >= 900,
    );
    expect(bought?.userData).toContain("#cloud-config");
    expect(spawned.stdout).toContain(`BAND_MACHINE_HANDLE=${bought?.instanceId}\n`);

    const destroyed = await hook("contabo", "destroy", newEnv, dir);
    expect(destroyed.status, destroyed.stderr).toBe(0);
    expect(bought?.cancelDate).toBeDefined();
    expect(destroyed.stdout).toContain("billed until the end of its period");
    // a second destroy is not an error
    expect((await hook("contabo", "destroy", newEnv, dir)).status).toBe(0);
  });

  it("fails the attempt when the credentials are wrong", async () => {
    const res = await hook("contabo", "spawn", env({ CONTABO_API_PASSWORD: "nope" }), dir);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("401");
    expect(res.stderr).toContain("Invalid user credentials");
  });

  it("fails when a credential is missing from the runner's env", async () => {
    const res = await hook("contabo", "spawn", { ...env(), CONTABO_CLIENT_SECRET: "" }, dir);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("CONTABO_CLIENT_SECRET is required");
  });
});

describe("cloud-init template", () => {
  const base = {
    BAND_HUB_URL: "https://hub.example.com",
    BAND_WORKER_ID: "h-0123456789ab",
    BAND_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
    BAND_LABELS: "pool=vm",
    BAND_PROJECT: "proj",
    BAND_REPO_URLS: "https://github.com/example/proj.git",
  };
  const KEYS = ["package_update", "packages", "write_files", "runcmd"];
  const FILE_KEYS = ["path", "permissions", "owner", "content"];

  const variants: Array<[string, Record<string, string>]> = [
    ["npm", base],
    [
      "npm with idle exit and no repository",
      { ...base, BAND_IDLE_EXIT: "90s", BAND_REPO_URLS: "" },
    ],
    [
      "docker",
      { ...base, BAND_VM_WORKER: "docker", BAND_VM_WORKER_IMAGE: "ghcr.io/example/band-worker:1" },
    ],
  ];

  it.each(variants)("renders a valid cloud-config for %s", (_name, env) => {
    const cfg = parseCloudConfig(renderCloudInit(env));
    expect(Object.keys(cfg).sort()).toEqual([...KEYS].sort());
    for (const f of cfg.write_files) {
      expect(Object.keys(f).sort()).toEqual([...FILE_KEYS].sort());
      expect(f.path.startsWith("/")).toBe(true);
      expect(f.permissions).toMatch(/^0[0-7]{3}$/);
    }
    expect(cfg.packages.every((p) => /^[a-z0-9.+-]+$/.test(p))).toBe(true);
    expect(cfg.runcmd[0]).toEqual(["sh", "-c", "/usr/local/sbin/band-bootstrap.sh || poweroff"]);
    const unit = file(cfg, "/etc/systemd/system/band-worker.service").content;
    expect(unit).toContain("ExecStopPost=+/usr/sbin/poweroff");
    expect(unit).toContain("RuntimeMaxSec=43200");
    // the token leaves the VM once the unit has read it
    expect(file(cfg, "/usr/local/sbin/band-bootstrap.sh").content).toContain(
      "rm -f /etc/band-worker.env",
    );
  });

  it("passes cloud-init schema when the tool is installed", (ctx) => {
    try {
      execFileSync("cloud-init", ["--version"], { stdio: "ignore" });
    } catch {
      ctx.skip("cloud-init is not installed here, so the shape check above is the coverage");
    }
    const dir = tmp("cloud-init-schema-");
    for (const [name, env] of variants) {
      const path = join(dir, `${name.replace(/\W+/g, "-")}.yaml`);
      writeFileSync(path, renderCloudInit(env));
      execFileSync("cloud-init", ["schema", "--config-file", path], { stdio: "pipe" });
    }
  });

  it("refuses values that could break the environment file or the unit", async () => {
    expect(() => renderCloudInit({ ...base, BAND_LABELS: 'a="b"\nEVIL=1' })).toThrow(
      /cannot go in the worker's environment file/,
    );
    expect(() => renderCloudInit({ ...base, BAND_VM_WORKER: "docker" })).toThrow(
      /BAND_VM_WORKER_IMAGE is required/,
    );
    expect(() =>
      renderCloudInit({ ...base, BAND_VM_WORKER: "docker", BAND_VM_WORKER_IMAGE: "x; rm -rf /" }),
    ).toThrow(/not an image name/);
    expect(() => renderCloudInit({ ...base, BAND_VM_WORKER_PACKAGE: "x'; poweroff #" })).toThrow(
      /not a package spec/,
    );
  });
});

// Live test (acceptance S4). It creates and deletes one real Hetzner server, which costs a few cents, so it
// runs only when BAND_LIVE_HCLOUD_TOKEN is set. CI never sets it.
describe.skipIf(!process.env.BAND_LIVE_HCLOUD_TOKEN)("hetzner hook against the real API", () => {
  it("creates, lists and deletes a server", async () => {
    const dir = tmp("hetzner-live-");
    const env = {
      HCLOUD_TOKEN: process.env.BAND_LIVE_HCLOUD_TOKEN ?? "",
      BAND_WORKER_ID: `h-live${Date.now().toString(16)}`,
      BAND_HUB_URL: "https://hub.example.com",
      BAND_REPO_URLS: "",
    };
    try {
      const spawned = await hook("hetzner", "spawn", env, dir);
      expect(spawned.status, spawned.stderr).toBe(0);
      expect((await hook("hetzner", "status", env, dir)).stdout).toContain(env.BAND_WORKER_ID);
    } finally {
      const destroyed = await hook("hetzner", "destroy", env, dir);
      expect(destroyed.status, destroyed.stderr).toBe(0);
    }
  });
});

beforeAll(() => {
  // The hooks are shell scripts that must be executable, or the hub's spawn fails with EACCES.
  for (const name of ["hetzner", "contabo"]) {
    for (const which of ["spawn", "destroy", "status"]) {
      execFileSync("test", ["-x", join(RUNNERS, name, `${which}.sh`)]);
    }
  }
});
