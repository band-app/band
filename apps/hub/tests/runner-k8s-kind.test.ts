// Integration test for the bundled `k8s` runner hook against a real cluster (plan step 3.9). A real
// hub (the production bundle, temp BAND_HOME) runs `runners/k8s` with kubectl. The hook starts the
// band-worker image as a Pod, the worker dials the hub over TLS, and the worktree becomes ready on
// it. Destroy then removes the Pod and its token Secret.
//
// It needs a cluster that already has the worker image (the CI `k8s (kind)` job builds it and runs
// `kind load docker-image`) and the namespace and RBAC from deploy/k8s. Set BAND_K8S_TEST_IMAGE to the
// image name and BAND_K8S_TEST_KUBECONFIG to an admin kubeconfig to run it; without them the file is
// skipped. The hook itself runs as the band-hub service account, through a kubeconfig this test
// builds from a token for that account, so the RBAC in deploy/k8s/rbac.yaml is what it really runs
// under.
//
// A worker takes plain http only for a loopback hub, so the hub sits behind a TLS terminator in this
// file: a node `tls` server on 0.0.0.0 that pipes the decrypted bytes to the hub (HTTP and WebSocket
// alike). Its certificate is self-signed (openssl), and the pods trust it through a ConfigMap
// (BAND_K8S_CA_CONFIGMAP). Pods reach this machine at BAND_K8S_TEST_HUB_HOST, by default the gateway
// of docker's `kind` network. The repo's origin is a `git daemon` on 0.0.0.0, because the pod clones
// the repository itself.

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTlsServer, type Server as TlsServer } from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";
import { waitFor } from "./helpers/wait-for";

const IMAGE = process.env.BAND_K8S_TEST_IMAGE ?? "";
const ADMIN_KUBECONFIG = process.env.BAND_K8S_TEST_KUBECONFIG ?? "";
const NAMESPACE = "band-workers";
const TOKEN = "k8s-runner-shared-secret";
const CA_CONFIGMAP = "band-hub-ca";

interface CreateResult {
  path: string;
  provisioning?: { requestId: string };
}
interface ReposList {
  repos: Array<{ name: string; worktrees: Array<{ name: string; hostId?: string }> }>;
}
interface HostsList {
  hosts: Array<{ id: string; status: string }>;
}
interface PodJson {
  metadata: { name: string; labels: Record<string, string> };
  spec: {
    automountServiceAccountToken?: boolean;
    securityContext: {
      runAsNonRoot?: boolean;
      runAsUser?: number;
      seccompProfile?: { type: string };
    };
    containers: Array<{
      resources: { limits?: Record<string, string> };
      securityContext: { readOnlyRootFilesystem?: boolean; capabilities?: { drop?: string[] } };
      env: Array<{ name: string; value?: string; valueFrom?: unknown }>;
    }>;
    volumes: Array<{ name: string; projected?: unknown }>;
  };
  status: { phase: string };
}

const scratch: string[] = [];
const tmp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};

const run = (cmd: string, args: string[], env: Record<string, string> = {}) =>
  execFileSync(cmd, args, {
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const admin = (...args: string[]) =>
  run("kubectl", ["--namespace", NAMESPACE, ...args], { KUBECONFIG: ADMIN_KUBECONFIG });

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createTcpServer();
    srv.listen(0, "0.0.0.0", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

/** The address pods use to reach this machine: the gateway of docker's `kind` network. */
function podReachableHost(): string {
  if (process.env.BAND_K8S_TEST_HUB_HOST) return process.env.BAND_K8S_TEST_HUB_HOST;
  const gateways = run("docker", [
    "network",
    "inspect",
    "kind",
    "--format",
    "{{range .IPAM.Config}}{{.Gateway}} {{end}}",
  ]).split(/\s+/);
  const v4 = gateways.find((g) => /^\d+\.\d+\.\d+\.\d+$/.test(g));
  if (!v4) throw new Error(`no IPv4 gateway on the kind network: ${gateways.join(" ")}`);
  return v4;
}

let server: ServerHandle;
let gitDaemon: ReturnType<typeof spawn> | undefined;
let tlsProxy: TlsServer | undefined;
let hubHome: string;
let runnerKubeconfig: string;
const sockets = new Set<import("node:net").Socket>();

const q = <T>(procedure: string, input?: unknown) =>
  trpcQuery(server.url, procedure, input, TOKEN).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });
const m = <T>(procedure: string, input: unknown) =>
  trpcMutate(server.url, procedure, input, TOKEN).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });
/** Waits for a worktree. On a timeout the error carries the runner's log and the pods. */
const worktree = async (name: string) => {
  try {
    return await waitFor(
      async () => {
        const found = (await q<ReposList>("repos.list")).repos
          .find((p) => p.name === "proj")
          ?.worktrees.find((w) => w.name === name);
        if (found) return found;
        // A failed request will not turn into a worktree, so stop waiting.
        const { requests } = await q<{ requests: Array<{ branch: string; status: string }> }>(
          "hostRequests.list",
        );
        if (requests.some((r) => r.branch === name && r.status === "failed")) {
          throw new Error(`the host request for ${name} failed`);
        }
        return undefined;
      },
      { label: `worktree ${name} exists`, timeoutMs: 240_000, intervalMs: 1000 },
    );
  } catch (err) {
    const requests = await q<{
      requests: Array<{ id: string; branch: string; error: string | null }>;
    }>("hostRequests.list").catch(() => ({ requests: [] }));
    const mine = requests.requests.find((r) => r.branch === name);
    const log = mine
      ? await q<{ log: string | null }>("runners.log", { requestId: mine.id }).catch(() => null)
      : null;
    let pods = "";
    try {
      pods = admin("get", "pods", "-o", "wide") + admin("describe", "pods");
    } catch {
      // The cluster does not answer.
    }
    throw new Error(
      `${err instanceof Error ? err.message : err}\nrequest: ${JSON.stringify(mine)}\nlog:\n${log?.log ?? "(none)"}\npods:\n${pods}`,
    );
  }
};
const podsOf = (hostId: string): PodJson[] =>
  (
    JSON.parse(admin("get", "pods", "--selector", `band.worker=${hostId}`, "-o", "json")) as {
      items: PodJson[];
    }
  ).items;

/** TLS in front of the hub. The worker dials this, the bytes go on to the hub in the clear on loopback. */
function startTlsProxy(
  port: number,
  hubPort: number,
  key: string,
  cert: string,
): Promise<TlsServer> {
  return new Promise((resolve, reject) => {
    const proxy = createTlsServer({ key, cert }, (client) => {
      const upstream = connect(hubPort, "127.0.0.1");
      sockets.add(client);
      sockets.add(upstream);
      client.pipe(upstream);
      upstream.pipe(client);
      const end = () => {
        client.destroy();
        upstream.destroy();
        sockets.delete(client);
        sockets.delete(upstream);
      };
      client.on("error", end);
      upstream.on("error", end);
      client.on("close", end);
      upstream.on("close", end);
    });
    proxy.on("error", reject);
    proxy.listen(port, "0.0.0.0", () => resolve(proxy));
  });
}

describe.skipIf(!IMAGE || !ADMIN_KUBECONFIG)("the k8s hook on a cluster", () => {
  let hubUrl = "";

  beforeAll(async () => {
    hubHome = createTmpHome("band-k8s-hub-");
    scratch.push(hubHome);
    const host = podReachableHost();
    const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(host);

    // A self-signed certificate for that address. It is its own CA, and the pods trust exactly it.
    const certDir = tmp("band-k8s-cert-");
    run("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(certDir, "key.pem"),
      "-out",
      join(certDir, "ca.crt"),
      "-days",
      "1",
      "-subj",
      "/CN=band-hub",
      "-addext",
      `subjectAltName=${isIp ? "IP" : "DNS"}:${host}`,
    ]);
    // Replace a leftover from an earlier run on a long-lived cluster.
    admin("delete", "configmap", CA_CONFIGMAP, "--ignore-not-found");
    admin("create", "configmap", CA_CONFIGMAP, `--from-file=ca.crt=${join(certDir, "ca.crt")}`);

    // The hook runs as the band-hub service account, with only what deploy/k8s/rbac.yaml grants it.
    const view = JSON.parse(
      run("kubectl", ["config", "view", "--raw", "--minify", "-o", "json"], {
        KUBECONFIG: ADMIN_KUBECONFIG,
      }),
    ) as {
      clusters: Array<{ cluster: { server: string; "certificate-authority-data"?: string } }>;
    };
    const cluster = view.clusters[0].cluster;
    const saToken = run("kubectl", ["--namespace", "band", "create", "token", "band-hub"], {
      KUBECONFIG: ADMIN_KUBECONFIG,
    });
    runnerKubeconfig = join(tmp("band-k8s-kubeconfig-"), "config");
    writeFileSync(
      runnerKubeconfig,
      JSON.stringify({
        apiVersion: "v1",
        kind: "Config",
        clusters: [{ name: "kind", cluster }],
        users: [{ name: "band-hub", user: { token: saToken } }],
        contexts: [{ name: "band-hub", context: { cluster: "kind", user: "band-hub" } }],
        "current-context": "band-hub",
      }),
      { mode: 0o600 },
    );

    const origin = tmp("band-k8s-origin-");
    const bare = join(origin, "proj");
    mkdirSync(bare, { recursive: true });
    const seed = join(tmp("band-k8s-seed-"), "proj");
    mkdirSync(seed, { recursive: true });
    git(seed, "init", "-q", "-b", "main");
    writeFileSync(join(seed, "hello.txt"), "hello\n");
    git(seed, "add", ".");
    git(seed, "commit", "-q", "-m", "init");
    git(origin, "clone", "-q", "--bare", seed, bare);

    const gitPort = await freePort();
    gitDaemon = spawn(
      "git",
      [
        "daemon",
        `--base-path=${origin}`,
        "--export-all",
        `--port=${gitPort}`,
        "--listen=0.0.0.0",
        origin,
      ],
      { stdio: "ignore" },
    );
    await new Promise((r) => setTimeout(r, 500));
    git(seed, "remote", "add", "origin", `git://${host}:${gitPort}/proj`);

    seedSettings(hubHome, { tokenSecret: TOKEN });
    seedState(hubHome, {
      repos: [
        {
          name: "proj",
          path: seed,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: seed }],
        },
      ],
    });
    server = await startServer({
      tmpHome: hubHome,
      remoteHost: false,
      env: { BAND_SERVE_UI: "false" },
    });

    const tlsPort = await freePort();
    tlsProxy = await startTlsProxy(
      tlsPort,
      Number(new URL(server.url).port),
      readFileSync(join(certDir, "key.pem"), "utf8"),
      readFileSync(join(certDir, "ca.crt"), "utf8"),
    );
    hubUrl = `https://${host}:${tlsPort}`;

    await m("settings.update", {
      runners: [
        {
          id: "k8s",
          spawn: "bundled:k8s",
          destroy: "bundled:k8s",
          labels: { pool: "k8s" },
          isolation: "container",
          maxConcurrent: 1,
          timeoutSec: 240,
          env: {
            KUBECONFIG: runnerKubeconfig,
            BAND_K8S_NAMESPACE: NAMESPACE,
            BAND_K8S_IMAGE: IMAGE,
            BAND_K8S_PULL_POLICY: "IfNotPresent",
            BAND_K8S_CA_CONFIGMAP: CA_CONFIGMAP,
            BAND_HUB_URL: hubUrl,
            BAND_IDLE_EXIT: "600s",
          },
        },
      ],
    });
  }, 180_000);

  afterAll(async () => {
    try {
      admin("delete", "pods,secrets", "--selector", "band.runner=k8s", "--wait=false");
    } catch {
      // Nothing to clean up, or no cluster.
    }
    try {
      admin("delete", "configmap", CA_CONFIGMAP, "--ignore-not-found");
    } catch {
      // Same.
    }
    gitDaemon?.kill();
    for (const s of sockets) s.destroy();
    tlsProxy?.close();
    await server?.close();
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
  });

  it("starts a hardened worker Pod that says hello over TLS (S2)", async () => {
    const created = await m<CreateResult>("worktrees.create", {
      repo: "proj",
      branch: "k8s-a",
      placement: {
        labels: { pool: "k8s" },
        environment: { isolation: "container", resources: { cpu: 0.25, memory: "512Mi" } },
      },
    });
    expect(created.provisioning?.requestId).toBeTruthy();
    const w = await worktree("k8s-a");
    const hostId = w.hostId as string;
    expect(hostId).toBeTruthy();
    expect((await q<HostsList>("hosts.list")).hosts.find((h) => h.id === hostId)?.status).toBe(
      "online",
    );

    const pods = podsOf(hostId);
    expect(pods).toHaveLength(1);
    const [pod] = pods;
    expect(pod.status.phase).toBe("Running");
    expect(pod.metadata.name).toBe(`band-${hostId}`);
    expect(pod.metadata.labels).toMatchObject({ "band.runner": "k8s", "band.worker": hostId });
    expect(pod.spec.automountServiceAccountToken).toBe(false);
    expect(pod.spec.securityContext).toMatchObject({
      runAsNonRoot: true,
      runAsUser: 65532,
      seccompProfile: { type: "RuntimeDefault" },
    });
    const [container] = pod.spec.containers;
    expect(container.securityContext.readOnlyRootFilesystem).toBe(true);
    expect(container.securityContext.capabilities?.drop).toEqual(["ALL"]);
    expect(container.resources.limits).toMatchObject({ cpu: "250m", memory: "512Mi" });
    // No service account token volume, and the bootstrap token is only a Secret reference.
    expect(pod.spec.volumes.some((v) => v.projected)).toBe(false);
    const tokenEnv = container.env.find((e) => e.name === "BAND_BOOTSTRAP_TOKEN");
    expect(tokenEnv?.value).toBeUndefined();
    expect(tokenEnv?.valueFrom).toBeTruthy();

    // Inside: the uid, the read-only root, and no service account token on disk.
    const exec = (...cmd: string[]) => admin("exec", pod.metadata.name, "--", ...cmd);
    expect(exec("id", "-u")).toBe("65532");
    expect(() => exec("touch", "/etc/band-probe")).toThrow();
    exec("touch", "/work/band-probe");
    exec("touch", "/tmp/band-probe");
    expect(() => exec("ls", "/var/run/secrets/kubernetes.io/serviceaccount")).toThrow();

    // The Secret is owned by the Pod, so the garbage collector removes it with the Pod.
    const secret = JSON.parse(admin("get", "secret", pod.metadata.name, "-o", "json")) as {
      metadata: { ownerReferences: Array<{ kind: string; name: string }> };
    };
    expect(secret.metadata.ownerReferences).toMatchObject([
      { kind: "Pod", name: pod.metadata.name },
    ]);
  }, 360_000);

  it("removes the Pod and its Secret on destroy (S2)", async () => {
    const w = await worktree("k8s-a");
    const hostId = w.hostId as string;
    expect(podsOf(hostId)).toHaveLength(1);
    const hook = join(import.meta.dirname, "../../../runners/k8s/destroy.sh");
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      KUBECONFIG: runnerKubeconfig,
      BAND_K8S_NAMESPACE: NAMESPACE,
      BAND_WORKER_ID: hostId,
    };
    execFileSync("sh", [hook], { env });
    await waitFor(async () => (podsOf(hostId).length === 0 ? true : undefined), {
      label: "pod deleted",
      timeoutMs: 90_000,
      intervalMs: 1000,
    });
    await waitFor(
      async () => {
        try {
          admin("get", "secret", `band-${hostId}`);
          return undefined;
        } catch {
          return true;
        }
      },
      { label: "secret collected", timeoutMs: 90_000, intervalMs: 1000 },
    );
    // Running destroy again succeeds.
    execFileSync("sh", [hook], { env });
  }, 240_000);
});
