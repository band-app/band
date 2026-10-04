import { createHash } from "node:crypto";
import { posix } from "node:path";
import { ENVIRONMENT_FILE, type Environment, repoRelative } from "./schema.ts";

/**
 * Lockfiles at the repository root. A change to one changes the image key,
 * because the image holds the result of `install`.
 */
export const LOCKFILES = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "uv.lock",
  "poetry.lock",
  "Pipfile.lock",
  "requirements.txt",
  "go.sum",
  "Cargo.lock",
  "Gemfile.lock",
  "composer.lock",
  "mise.toml",
  ".tool-versions",
  ".nvmrc",
  ".node-version",
  ".python-version",
] as const;

/** Where the worker base puts the worker inside an environment image. */
export const WORKER_DIR = "/opt/band/worker";
export const WORKER_NODE = "/opt/band/node/bin/node";
export const WORKER_LAUNCHER = "/usr/local/bin/band-worker";
/** Where `install` runs and the default-branch snapshot lives in the image. */
export const IMAGE_WORKDIR = "/workspace";

/** A path in the repository whose content decides the image, and how to find its hash. */
export interface KeyInput {
  /** Repo-relative path. A directory hashes as its git tree. */
  path: string;
  /** Fails the build when missing. Lockfiles are optional. */
  required: boolean;
}

/**
 * The repo paths whose content goes into the image key: the environment file,
 * what `build` names and the context beside it, and the lockfiles.
 *
 * A Dockerfile's context is its own directory, so that directory's tree is
 * part of the key. A Dockerfile at the repository root would put the whole
 * repository in the key and rebuild on every commit, so only the file counts
 * there (and `.dockerignore`).
 */
export function keyInputs(environment: Environment): KeyInput[] {
  const inputs: KeyInput[] = [{ path: ENVIRONMENT_FILE, required: true }];
  const build = environment.build;
  for (const key of ["devcontainer", "dockerfile"] as const) {
    const file = build?.[key];
    if (file === undefined) continue;
    const relative = repoRelative(file);
    if (relative === null) continue;
    inputs.push({ path: relative, required: true });
    const dir = posix.dirname(relative);
    if (dir === ".") {
      inputs.push({ path: ".dockerignore", required: false });
    } else {
      inputs.push({ path: dir, required: true });
    }
  }
  for (const lock of LOCKFILES) inputs.push({ path: lock, required: false });
  return inputs;
}

export interface KeyParts {
  /** Hash of every input path that exists, by path. */
  files: Record<string, string>;
  /** The `image` a `build.image` environment names, so a moved tag is not the same key. */
  image?: string;
  /** Id of the worker base image the final layer copies from. */
  workerBase: string;
}

/** The cache key: a SHA-256 over the parts, as 64 hex characters. */
export function imageKey(parts: KeyParts): string {
  const files = Object.keys(parts.files)
    .sort()
    .map((p) => [p, parts.files[p]]);
  return createHash("sha256")
    .update(
      JSON.stringify({ v: 1, files, image: parts.image ?? null, workerBase: parts.workerBase }),
    )
    .digest("hex");
}

/** The characters Docker allows in a repository name path component. */
function repoComponent(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
  return cleaned === "" ? "project" : cleaned;
}

/** `band-env/<project>:<key16>`, under `registry` when one is set. */
export function imageTag(project: string, key: string, registry?: string): string {
  const prefix = registry ? `${registry.replace(/\/+$/, "")}/` : "";
  return `${prefix}band-env/${repoComponent(project)}:${key.slice(0, 16)}`;
}

/** The intermediate image that holds the toolchain before the worker layer. */
export function toolchainTag(project: string, key: string): string {
  return `band-env-toolchain/${repoComponent(project)}:${key.slice(0, 16)}`;
}

/** The image with the worker layer and no `install` yet. */
export function layeredTag(project: string, key: string): string {
  return `band-env-layered/${repoComponent(project)}:${key.slice(0, 16)}`;
}

/** `docker build` for an environment whose `build.dockerfile` is set. `checkout` is the default-branch snapshot. */
export function dockerBuildArgs(opts: {
  checkout: string;
  dockerfile: string;
  tag: string;
}): string[] {
  const relative = repoRelative(opts.dockerfile);
  if (relative === null)
    throw new Error(`"${opts.dockerfile}" must be a path inside the repository`);
  const context = posix.dirname(relative);
  return [
    "build",
    "--tag",
    opts.tag,
    "--file",
    posix.join(opts.checkout, relative),
    posix.join(opts.checkout, context),
  ];
}

/** `devcontainer build` for an environment whose `build.devcontainer` is set. */
export function devcontainerBuildArgs(opts: {
  checkout: string;
  config: string;
  tag: string;
}): string[] {
  const relative = repoRelative(opts.config);
  if (relative === null) throw new Error(`"${opts.config}" must be a path inside the repository`);
  return [
    "build",
    "--workspace-folder",
    opts.checkout,
    "--config",
    posix.join(opts.checkout, relative),
    "--image-name",
    opts.tag,
  ];
}

/**
 * The Dockerfile of the final layer: the toolchain image plus the worker
 * copied from the worker base image, and a /work directory any uid can write.
 * The worker runs on the node binary it brings, so the toolchain needs no node
 * of its own. The caller puts an empty `root/work` directory in the build
 * context. COPY makes /work where a RUN would fail, because the toolchain
 * image may end on a non-root USER.
 */
export function workerLayerDockerfile(opts: { from: string; workerBase: string }): string {
  return [
    `FROM ${opts.from}`,
    `COPY --from=${opts.workerBase} /usr/local/bin/node ${WORKER_NODE}`,
    `COPY --from=${opts.workerBase} /opt/band-worker ${WORKER_DIR}`,
    `COPY band-worker.sh ${WORKER_LAUNCHER}`,
    // The docker runner hook (runners/docker) runs the image as uid 65532 with a /work volume, which
    // takes its mode from this directory. COPY runs as root whatever USER the toolchain ends on.
    "COPY --chmod=1777 root/ /",
    "",
  ].join("\n");
}

/** The `band-worker` command in the image. */
export function workerLauncherScript(): string {
  return [
    "#!/bin/sh",
    `exec ${WORKER_NODE} ${WORKER_DIR}/node_modules/@band-app/worker/bin/band-worker.mjs "$@"`,
    "",
  ].join("\n");
}

/** `docker create` for the container that runs `install`. The command goes through `sh -c`. */
export function installCreateArgs(opts: {
  name: string;
  image: string;
  install: string;
}): string[] {
  return [
    "create",
    "--name",
    opts.name,
    "--workdir",
    IMAGE_WORKDIR,
    "--entrypoint",
    "sh",
    opts.image,
    "-c",
    opts.install,
  ];
}

/** `docker commit` of the installed container, labelled with what it was built from. */
export function commitArgs(opts: {
  container: string;
  tag: string;
  key: string;
  commit?: string;
}): string[] {
  const args = [
    "commit",
    "--change",
    `LABEL band.environment.key=${opts.key}`,
    // The container ran `sh -c <install>`. The image should start with the
    // image's own entrypoint again, so reset what `create` set.
    "--change",
    "ENTRYPOINT []",
    "--change",
    "CMD []",
    "--change",
    `WORKDIR ${IMAGE_WORKDIR}`,
  ];
  if (opts.commit) args.push("--change", `LABEL band.environment.commit=${opts.commit}`);
  args.push(opts.container, opts.tag);
  return args;
}

/** Names that look like credentials. The builder blanks them in the environment of every command it runs. */
const SECRET_NAME =
  /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|AUTH|COOKIE|SESSION|(^|_)PAT$)/i;

const DOCKER_CONNECTION = /^DOCKER_(HOST|CONFIG|CERT_PATH|TLS_VERIFY|CONTEXT)$/;

/**
 * Overrides that blank every credential-like variable of `env`, plus every
 * `BAND_*` one. A command run on the hub's own host inherits the hub's
 * environment, and a build runs commands from the repository.
 */
export function scrubEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of Object.keys(env)) {
    if (DOCKER_CONNECTION.test(name)) continue;
    if (SECRET_NAME.test(name) || name.startsWith("BAND_")) out[name] = "";
  }
  return out;
}
