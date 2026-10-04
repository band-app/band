#!/usr/bin/env node
// Renders the Kubernetes objects of the "k8s" runner hook from its environment and prints them as JSON
// (kubectl reads JSON as well as YAML). Used by spawn.sh. Contract: docs/runner-hooks.md.
//
//   render.mjs workload   the Pod, Job or Sandbox that runs the worker
//   render.mjs secret     the Secret that holds the bootstrap token, owned by the workload
//
// Nothing here talks to a cluster. The bootstrap token is only ever in the Secret manifest, which
// spawn.sh pipes to kubectl on stdin, so it is in no command line.
import { pathToFileURL } from "node:url";

export const WORKER_UID = 65532;

const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

function fail(message) {
  throw new Error(message);
}

/** A label value: at most 63 characters, starting and ending with an alphanumeric. */
export function labelValue(value) {
  const cleaned = String(value ?? "")
    .replace(/[^A-Za-z0-9_.-]/g, "_")
    .slice(0, 63)
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
  return cleaned;
}

function parseEnvironment(raw) {
  try {
    return JSON.parse(raw || "{}") ?? {};
  } catch {
    return fail("BAND_ENVIRONMENT is not valid JSON");
  }
}

/** Reads the settings from `env` and checks them. Throws an Error with a message for the run log. */
export function resolveConfig(env) {
  const need = (name) => env[name] || fail(`${name} is required`);
  const workerId = need("BAND_WORKER_ID");
  const name = `band-${workerId}`.toLowerCase();
  if (!DNS_LABEL.test(name) || name.length > 63) {
    fail(`worker id ${workerId} does not make a valid Kubernetes name`);
  }
  const kind = env.BAND_K8S_KIND || "pod";
  if (!["pod", "job", "sandbox"].includes(kind)) {
    fail(`BAND_K8S_KIND must be pod, job or sandbox (got ${kind})`);
  }
  const namespace = env.BAND_K8S_NAMESPACE || "band-workers";
  if (!DNS_LABEL.test(namespace)) fail(`BAND_K8S_NAMESPACE ${namespace} is not a valid namespace`);

  const environment = parseEnvironment(env.BAND_ENVIRONMENT);
  const isolation = env.BAND_ISOLATION || environment.isolation || "worktree";
  const runtimeClass = env.BAND_K8S_RUNTIME_CLASS || "";
  // A runner that offers "vm" must say how: running a vm request on the node's default runtime would
  // hand out a shared-kernel container under a stronger name.
  if (isolation === "vm" && !runtimeClass) {
    fail("isolation vm needs BAND_K8S_RUNTIME_CLASS (a RuntimeClass such as kata or gvisor)");
  }

  const repo = (env.BAND_REPO_URLS || "").split(",")[0] || "";
  if (repo.startsWith("/")) {
    fail(`the project has no origin URL a pod can clone (got ${repo})`);
  }
  const project = String(env.BAND_PROJECT || "repo").replace(/[^A-Za-z0-9_.-]/g, "_");
  const repoName = ["", ".", ".."].includes(project) ? "repo" : project;

  return {
    name,
    kind,
    namespace,
    workerId,
    hubUrl: need("BAND_HUB_URL"),
    token: env.BAND_BOOTSTRAP_TOKEN || "",
    image: env.BAND_PROJECT_IMAGE || env.BAND_K8S_IMAGE || "band-worker",
    pullPolicy: env.BAND_K8S_PULL_POLICY || "",
    pullSecret: env.BAND_K8S_PULL_SECRET || "",
    caConfigMap: env.BAND_K8S_CA_CONFIGMAP || "",
    caKey: env.BAND_K8S_CA_KEY || "ca.crt",
    runtimeClass: runtimeClass || undefined,
    isolation,
    cpu: environment.resources?.cpu,
    memory: environment.resources?.memory,
    tmpSize: env.BAND_K8S_TMP_SIZE || "512Mi",
    workSize: env.BAND_K8S_WORK_SIZE || "10Gi",
    idleExit: env.BAND_IDLE_EXIT || "",
    labels: env.BAND_LABELS || "",
    runnerId: env.BAND_RUNNER_ID || "",
    requestId: env.BAND_REQUEST_ID || "",
    repo,
    repoName,
  };
}

export function labelsFor(c) {
  return {
    "band.runner": labelValue(c.runnerId),
    "band.request": labelValue(c.requestId),
    "band.worker": labelValue(c.workerId),
  };
}

// The same steps as the docker hook: the repository is cloned under /work before the worker starts,
// and the clone has no bootstrap token in its environment.
const START = `set -e
# The worker image keeps its git identity and safe.directory in /home/worker, which HOME no longer is.
if [ -f /home/worker/.gitconfig ]; then export GIT_CONFIG_GLOBAL=/home/worker/.gitconfig; fi
mkdir -p "$HOME" "$BAND_WORKER_STATE_DIR"
if [ -n "$BAND_CLONE_URL" ]; then env -u BAND_BOOTSTRAP_TOKEN GIT_ALLOW_PROTOCOL=https:ssh:git git clone --quiet -- "$BAND_CLONE_URL" "/work/$BAND_CLONE_NAME"; fi
exec band-worker`;

/** The pod spec shared by the Pod, the Job's template and the Sandbox's podTemplate. */
export function podSpec(c) {
  const resources = {};
  if (c.cpu !== undefined || c.memory !== undefined) {
    // Requests equal limits, so the pod is Guaranteed and the scheduler places it on what it gets.
    const amounts = {};
    if (c.cpu !== undefined) amounts.cpu = String(c.cpu);
    if (c.memory !== undefined) amounts.memory = String(c.memory);
    resources.requests = { ...amounts };
    resources.limits = { ...amounts };
  }
  const env = [
    { name: "BAND_HUB_URL", value: c.hubUrl },
    { name: "BAND_WORKER_ID", value: c.workerId },
    {
      name: "BAND_BOOTSTRAP_TOKEN",
      valueFrom: { secretKeyRef: { name: c.name, key: "token" } },
    },
    { name: "BAND_WORKER_LABELS", value: c.labels },
    { name: "BAND_WORKER_EPHEMERAL", value: "1" },
    { name: "HOME", value: "/work/home" },
    { name: "BAND_WORKER_ROOTS", value: "/work" },
    { name: "BAND_WORKER_STATE_DIR", value: "/work/.band-worker" },
    { name: "BAND_CLONE_URL", value: c.repo },
    { name: "BAND_CLONE_NAME", value: c.repoName },
  ];
  // A hub behind a private CA: Node reads the extra roots from the mounted ConfigMap.
  if (c.caConfigMap) {
    env.push({ name: "NODE_EXTRA_CA_CERTS", value: `/etc/band-ca/${c.caKey}` });
  }
  if (c.idleExit) env.push({ name: "BAND_WORKER_IDLE_EXIT", value: c.idleExit });

  const container = {
    name: "worker",
    image: c.image,
    command: ["/bin/sh", "-c", START],
    env,
    resources,
    securityContext: {
      allowPrivilegeEscalation: false,
      privileged: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
    },
    volumeMounts: [
      { name: "tmp", mountPath: "/tmp" },
      { name: "work", mountPath: "/work" },
    ],
  };
  if (c.caConfigMap) {
    container.volumeMounts.push({ name: "ca", mountPath: "/etc/band-ca", readOnly: true });
  }
  if (c.pullPolicy) container.imagePullPolicy = c.pullPolicy;

  const spec = {
    restartPolicy: "Never",
    // The worker has no use for the Kubernetes API, so it gets no token for it.
    automountServiceAccountToken: false,
    enableServiceLinks: false,
    securityContext: {
      runAsNonRoot: true,
      runAsUser: WORKER_UID,
      runAsGroup: WORKER_UID,
      fsGroup: WORKER_UID,
      seccompProfile: { type: "RuntimeDefault" },
    },
    containers: [container],
    volumes: [
      { name: "tmp", emptyDir: { medium: "Memory", sizeLimit: c.tmpSize } },
      { name: "work", emptyDir: { sizeLimit: c.workSize } },
    ],
  };
  if (c.caConfigMap) {
    spec.volumes.push({
      name: "ca",
      configMap: { name: c.caConfigMap, items: [{ key: c.caKey, path: c.caKey }] },
    });
  }
  if (c.runtimeClass) spec.runtimeClassName = c.runtimeClass;
  if (c.pullSecret) spec.imagePullSecrets = [{ name: c.pullSecret }];
  return spec;
}

export function renderWorkload(c) {
  const labels = labelsFor(c);
  const meta = { name: c.name, namespace: c.namespace, labels };
  const template = { metadata: { labels }, spec: podSpec(c) };
  if (c.kind === "job") {
    return {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: meta,
      spec: {
        backoffLimit: 0,
        ttlSecondsAfterFinished: 300,
        template,
      },
    };
  }
  if (c.kind === "sandbox") {
    // kubernetes-sigs/agent-sandbox. The controller creates a pod of the same name from the template.
    return {
      apiVersion: "agents.x-k8s.io/v1alpha1",
      kind: "Sandbox",
      metadata: meta,
      spec: { podTemplate: template },
    };
  }
  return { apiVersion: "v1", kind: "Pod", metadata: meta, spec: template.spec };
}

export function ownerApi(kind) {
  if (kind === "job") return { apiVersion: "batch/v1", kind: "Job" };
  if (kind === "sandbox") return { apiVersion: "agents.x-k8s.io/v1alpha1", kind: "Sandbox" };
  return { apiVersion: "v1", kind: "Pod" };
}

/** The Secret that holds the token. The owner reference makes the garbage collector delete it with the workload. */
export function renderSecret(c, ownerUid) {
  if (!ownerUid) fail("BAND_K8S_OWNER_UID is required to render the secret");
  if (!c.token) fail("BAND_BOOTSTRAP_TOKEN is required");
  return {
    apiVersion: "v1",
    kind: "Secret",
    type: "Opaque",
    metadata: {
      name: c.name,
      namespace: c.namespace,
      labels: labelsFor(c),
      ownerReferences: [
        { ...ownerApi(c.kind), name: c.name, uid: ownerUid },
      ],
    },
    stringData: { token: c.token },
  };
}

function main() {
  const mode = process.argv[2];
  try {
    const c = resolveConfig(process.env);
    if (mode === "workload") {
      // Not the token: the workload references the Secret by name.
      process.stdout.write(JSON.stringify(renderWorkload(c)));
    } else if (mode === "secret") {
      process.stdout.write(JSON.stringify(renderSecret(c, process.env.BAND_K8S_OWNER_UID)));
    } else if (mode === "check") {
      // spawn.sh asks for the validated settings it needs before it touches the cluster.
      process.stdout.write(`${c.kind} ${c.namespace} ${c.name} ${c.repoName}`);
    } else {
      fail("usage: render.mjs workload | secret | check");
    }
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
