// Tests for the bundled `k8s` runner hook (plan step 3.9). The scripts under `runners/k8s` run as the
// hub runs them: a minimal environment, the contract variables, and the runner's own settings. The
// only stub is the cluster boundary, `kubectl` (`BAND_KUBECTL_BIN`, fixtures/kubectl-stub-bin.mjs),
// which records the manifests the hook pipes to it. A live cluster is not needed to read what the
// hook asks for, and no cluster exists in the unit test job, so the cluster run is manual.

import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const hookDir = resolve(here, "../../../runners/k8s");
const kubectlStub = resolve(here, "fixtures/kubectl-stub-bin.mjs");
const TOKEN = "bwb_k8s-hook-secret-token";

const scratch = mkdtempSync(join(tmpdir(), "band-k8s-hook-"));
const statePath = join(scratch, "kubectl.json");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Call {
  args: string[];
  stdin: string;
  tokenInEnv: string | null;
}
const writeState = (state: Record<string, unknown> = {}) =>
  writeFileSync(statePath, JSON.stringify(state));
const calls = (): Call[] => JSON.parse(readFileSync(statePath, "utf8")).calls ?? [];
const created = () =>
  calls()
    .filter((c) => c.args.includes("create"))
    .map((c) => JSON.parse(c.stdin) as Record<string, any>);

// kubectl is a script with a node shebang; the stub is run through a wrapper so the hook can exec it.
const kubectlBin = join(scratch, "kubectl");
writeFileSync(kubectlBin, `#!/bin/sh\nexec "${process.execPath}" "${kubectlStub}" "$@"\n`, {
  mode: 0o755,
});

const contract = (extra: Record<string, string> = {}): Record<string, string> => ({
  PATH: process.env.PATH ?? "",
  HOME: scratch,
  BAND_NODE: process.execPath,
  BAND_KUBECTL_BIN: kubectlBin,
  STUB_KUBECTL_STATE: statePath,
  BAND_HUB_URL: "https://hub.example.com",
  BAND_WORKER_ID: "h-0123456789ab",
  BAND_BOOTSTRAP_TOKEN: TOKEN,
  BAND_RUNNER_ID: "k8s",
  BAND_REQUEST_ID: "req-1",
  BAND_PROJECT: "my-project",
  BAND_LABELS: "pool=k8s",
  BAND_ENVIRONMENT: "{}",
  ...extra,
});

const hook = (script: string, env: Record<string, string>) =>
  run("sh", [join(hookDir, script)], { env, encoding: "utf8" }).then(
    (r) => ({ code: 0, stdout: r.stdout, stderr: r.stderr }),
    (e: { code: number; stdout: string; stderr: string }) => ({
      code: e.code,
      stdout: e.stdout,
      stderr: e.stderr,
    }),
  );

beforeEach(() => writeState());

describe("k8s runner hook: spawn", () => {
  it("creates a hardened Pod, then a Secret owned by it", async () => {
    const res = await hook(
      "spawn.sh",
      contract({
        BAND_REPO_URLS: "https://github.com/acme/app.git",
        BAND_ENVIRONMENT: JSON.stringify({ resources: { cpu: 2, memory: "8Gi" } }),
        BAND_PROJECT_IMAGE: "registry.example.com/app:abc",
        BAND_IDLE_EXIT: "90s",
      }),
    );
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toContain("BAND_MACHINE_HANDLE=band-workers/band-h-0123456789ab");
    expect(res.stdout).toContain("BAND_HOST_PROJECT_PATH=/work/my-project");

    const [pod, secret] = created();
    expect(pod).toMatchObject({
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: "band-h-0123456789ab",
        namespace: "band-workers",
        labels: { "band.runner": "k8s", "band.request": "req-1", "band.worker": "h-0123456789ab" },
      },
    });
    const spec = pod.spec;
    expect(spec.automountServiceAccountToken).toBe(false);
    expect(spec.restartPolicy).toBe("Never");
    expect(spec.securityContext).toMatchObject({
      runAsNonRoot: true,
      runAsUser: 65532,
      seccompProfile: { type: "RuntimeDefault" },
    });
    expect(spec.runtimeClassName).toBeUndefined();
    const [container] = spec.containers;
    expect(container.image).toBe("registry.example.com/app:abc");
    expect(container.securityContext).toEqual({
      allowPrivilegeEscalation: false,
      privileged: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
    });
    expect(container.resources).toEqual({
      requests: { cpu: "2", memory: "8Gi" },
      limits: { cpu: "2", memory: "8Gi" },
    });
    expect(spec.volumes.map((v: { name: string }) => v.name).sort()).toEqual(["tmp", "work"]);
    expect(container.volumeMounts.map((m: { mountPath: string }) => m.mountPath).sort()).toEqual([
      "/tmp",
      "/work",
    ]);
    const env = Object.fromEntries(
      container.env.map((e: { name: string }) => [e.name, e]),
    ) as Record<string, any>;
    expect(env.BAND_WORKER_ID.value).toBe("h-0123456789ab");
    expect(env.BAND_WORKER_IDLE_EXIT.value).toBe("90s");
    expect(env.BAND_BOOTSTRAP_TOKEN.value).toBeUndefined();
    expect(env.BAND_BOOTSTRAP_TOKEN.valueFrom.secretKeyRef).toEqual({
      name: "band-h-0123456789ab",
      key: "token",
    });

    expect(secret).toMatchObject({
      kind: "Secret",
      metadata: {
        name: "band-h-0123456789ab",
        ownerReferences: [
          {
            apiVersion: "v1",
            kind: "Pod",
            name: "band-h-0123456789ab",
            uid: "uid-pod-band-h-0123456789ab",
          },
        ],
      },
      stringData: { token: TOKEN },
    });
  });

  it("keeps the token out of every kubectl argument and out of the Pod manifest", async () => {
    const res = await hook("spawn.sh", contract());
    expect(res.code, res.stderr).toBe(0);
    for (const call of calls()) {
      expect(call.args.join(" ")).not.toContain(TOKEN);
      expect(call.tokenInEnv).toBe(TOKEN); // inherited by the hook's own environment only
    }
    const [pod] = created();
    expect(JSON.stringify(pod)).not.toContain(TOKEN);
    expect(res.stdout + res.stderr).not.toContain(TOKEN);
  });

  it("uses the worker base image and no resources when the request sets none", async () => {
    const res = await hook(
      "spawn.sh",
      contract({ BAND_K8S_IMAGE: "ghcr.io/example/band-worker:1", BAND_K8S_NAMESPACE: "ci" }),
    );
    expect(res.code, res.stderr).toBe(0);
    const [pod] = created();
    expect(pod.metadata.namespace).toBe("ci");
    expect(pod.spec.containers[0].image).toBe("ghcr.io/example/band-worker:1");
    expect(pod.spec.containers[0].resources).toEqual({});
    for (const call of calls()) expect(call.args[call.args.indexOf("--namespace") + 1]).toBe("ci");
    expect(pod.spec.hostNetwork).toBeUndefined();
    expect(pod.spec.hostPID).toBeUndefined();
    expect(pod.spec.hostIPC).toBeUndefined();
  });

  it("renders a Job whose pod template is hardened the same way", async () => {
    const res = await hook("spawn.sh", contract({ BAND_K8S_KIND: "job" }));
    expect(res.code, res.stderr).toBe(0);
    const [job, secret] = created();
    expect(job).toMatchObject({ apiVersion: "batch/v1", kind: "Job", spec: { backoffLimit: 0 } });
    expect(job.spec.template.metadata.labels["band.worker"]).toBe("h-0123456789ab");
    expect(job.spec.template.spec.automountServiceAccountToken).toBe(false);
    expect(job.spec.template.spec.securityContext.runAsNonRoot).toBe(true);
    expect(secret.metadata.ownerReferences[0]).toMatchObject({
      apiVersion: "batch/v1",
      kind: "Job",
      uid: "uid-job-band-h-0123456789ab",
    });
  });

  it("renders an agent-sandbox Sandbox with the pod template", async () => {
    const res = await hook("spawn.sh", contract({ BAND_K8S_KIND: "sandbox" }));
    expect(res.code, res.stderr).toBe(0);
    const [sandbox, secret] = created();
    expect(sandbox).toMatchObject({ apiVersion: "agents.x-k8s.io/v1alpha1", kind: "Sandbox" });
    expect(sandbox.spec.podTemplate.spec.securityContext.runAsUser).toBe(65532);
    expect(secret.metadata.ownerReferences[0].kind).toBe("Sandbox");
  });

  it("mounts the hub's CA from a ConfigMap and points NODE_EXTRA_CA_CERTS at it", async () => {
    const res = await hook(
      "spawn.sh",
      contract({ BAND_K8S_CA_CONFIGMAP: "band-hub-ca", BAND_K8S_CA_KEY: "root.pem" }),
    );
    expect(res.code, res.stderr).toBe(0);
    const [pod] = created();
    const [container] = pod.spec.containers;
    expect(pod.spec.volumes).toContainEqual({
      name: "ca",
      configMap: { name: "band-hub-ca", items: [{ key: "root.pem", path: "root.pem" }] },
    });
    expect(container.volumeMounts).toContainEqual({
      name: "ca",
      mountPath: "/etc/band-ca",
      readOnly: true,
    });
    expect(container.env).toContainEqual({
      name: "NODE_EXTRA_CA_CERTS",
      value: "/etc/band-ca/root.pem",
    });
  });

  it("sets the RuntimeClass for isolation vm, and refuses vm without one", async () => {
    const refused = await hook("spawn.sh", contract({ BAND_ISOLATION: "vm" }));
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("BAND_K8S_RUNTIME_CLASS");
    expect(calls()).toHaveLength(0);

    writeState();
    const res = await hook(
      "spawn.sh",
      contract({ BAND_ISOLATION: "vm", BAND_K8S_RUNTIME_CLASS: "kata" }),
    );
    expect(res.code, res.stderr).toBe(0);
    expect(created()[0].spec.runtimeClassName).toBe("kata");
  });

  it("leaves a pod that still runs alone, and replaces a finished one", async () => {
    writeState({ phases: ["Running"] });
    const busy = await hook("spawn.sh", contract());
    expect(busy.code).toBe(1);
    expect(busy.stderr).toContain("still running");
    expect(created()).toHaveLength(0);

    writeState({ phases: ["Succeeded"] });
    const woken = await hook("spawn.sh", contract());
    expect(woken.code, woken.stderr).toBe(0);
    const verbs = calls().map((c) => c.args.find((a) => ["get", "delete", "create"].includes(a)));
    expect(verbs).toEqual(["get", "delete", "create", "create"]);
  });

  it("removes the Pod when the Secret cannot be created", async () => {
    writeState({ failCreate: ["Secret"] });
    const res = await hook("spawn.sh", contract({ BAND_K8S_SECRET_WAIT: "0" }));
    expect(res.code).toBe(1);
    const last = calls().at(-1);
    expect(last?.args).toEqual(expect.arrayContaining(["delete", "pod", "band-h-0123456789ab"]));
  });

  it("refuses a repository that only has a path on the hub's machine", async () => {
    const res = await hook("spawn.sh", contract({ BAND_REPO_URLS: "/Users/me/app" }));
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("no origin URL");
    expect(calls()).toHaveLength(0);
  });
});

describe("k8s runner hook: destroy and status", () => {
  it("deletes the workload and leaves its Secret to the garbage collector", async () => {
    const res = await hook("destroy.sh", contract());
    expect(res.code, res.stderr).toBe(0);
    const all = calls().map((c) => c.args);
    const [pod] = all;
    expect(all).toHaveLength(1);
    expect(pod).toEqual(
      expect.arrayContaining(["delete", "pod", "band-h-0123456789ab", "--ignore-not-found"]),
    );
  });

  it("follows the machine handle and the kind", async () => {
    const res = await hook(
      "destroy.sh",
      contract({ BAND_MACHINE_HANDLE: "other-ns/band-x", BAND_K8S_KIND: "job" }),
    );
    expect(res.code, res.stderr).toBe(0);
    const [job] = calls().map((c) => c.args);
    expect(job).toEqual(expect.arrayContaining(["other-ns", "delete", "job.batch", "band-x"]));
  });

  it("fails when the cluster is unreachable, so the run log shows the leak", async () => {
    writeState({ failDelete: true });
    const res = await hook("destroy.sh", contract());
    expect(res.code).not.toBe(0);
  });

  it("lists pods by the worker label", async () => {
    writeState({ phases: ["Running"] });
    const res = await hook("status.sh", contract());
    expect(res.code, res.stderr).toBe(0);
    const [get] = calls().map((c) => c.args);
    expect(get).toEqual(expect.arrayContaining(["get", "pods", "band.worker=h-0123456789ab"]));
    expect(get.join(" ")).toContain(
      "BAND_MACHINE_HANDLE={.metadata.namespace}/{.metadata.name} worker=",
    );
  });
});
