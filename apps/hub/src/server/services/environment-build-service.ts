import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import {
  checkReferences,
  commitArgs,
  devcontainerBuildArgs,
  dockerBuildArgs,
  ENVIRONMENT_FILE,
  type Environment,
  IMAGE_WORKDIR,
  imageKey,
  imageTag,
  installCreateArgs,
  keyInputs,
  layeredTag,
  parseEnvironment,
  scrubEnv,
  toolchainTag,
  workerLauncherScript,
  workerLayerDockerfile,
} from "@band-app/environment";
import type { Host } from "@band-app/host-api";
import { TRPCError } from "@trpc/server";
import {
  type EnvironmentBuildRow,
  environmentBuildQueries,
  MAX_LOG_BYTES,
} from "../infra/db/queries/environment-builds";
import { RepoQueries } from "../infra/db/queries/repos";
import { hostRegistry } from "../infra/host/registry";
import { settingsService } from "./settings-service";

const DEFAULT_WORKER_IMAGE = "band-worker:latest";
const DEFAULT_STEP_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_POLL_MS = 60 * 1000;

/** A build as the API returns it. `log` is left out of list entries. */
export interface EnvironmentBuildView {
  id: string;
  key: string;
  status: "building" | "ready" | "failed";
  image: string | null;
  hostId: string;
  commit: string | null;
  trigger: "manual" | "auto";
  error: string | null;
  startedAt: number;
  endedAt: number | null;
  log?: string;
}

export interface EnvironmentImageStatus {
  builder: { hostId: string; registry: string | null; workerImage: string };
  /** The newest ready build: the image a runner boots. */
  current: EnvironmentBuildView | null;
  /** The newest build of any status, with its log. */
  latest: EnvironmentBuildView | null;
  /** Recent builds, newest first, without logs. */
  builds: EnvironmentBuildView[];
}

export interface BuildResult {
  build: EnvironmentBuildView;
  /** A ready image already exists for the key, so nothing was built. */
  cacheHit: boolean;
  /** A build for this repo was already running, and this is it. */
  alreadyRunning: boolean;
}

function view(row: EnvironmentBuildRow, withLog: boolean): EnvironmentBuildView {
  return {
    id: row.id,
    key: row.key,
    status: row.status,
    image: row.image,
    hostId: row.hostId,
    commit: row.commit,
    trigger: row.trigger,
    error: row.error,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    ...(withLog ? { log: row.log } : {}),
  };
}

function envNumber(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** The build log: appended in memory, written to the row after each step. */
class BuildLog {
  private text = "";
  constructor(
    private readonly id: string,
    private readonly save: (id: string, text: string) => void,
  ) {}

  add(line: string): void {
    this.text += line.endsWith("\n") ? line : `${line}\n`;
    if (this.text.length > MAX_LOG_BYTES) {
      this.text = `[earlier output dropped]\n${this.text.slice(-MAX_LOG_BYTES)}`;
    }
  }

  flush(): void {
    this.save(this.id, this.text);
  }

  toString(): string {
    return this.text;
  }
}

interface Plan {
  host: Host;
  repoPath: string;
  repo: string;
  environment: Environment;
  ref: string;
  commit: string;
  key: string;
  tag: string;
  workerImage: string;
  registry: string | undefined;
}

/**
 * Builds and caches an environment image per repo (plan step 3.2): the
 * worker base (layer 1), the repo toolchain from `build` (layer 2) and the
 * result of `install` at the default branch. The image is tagged by a hash of
 * the environment file, what it references, the lockfiles and the worker base.
 * A build that fails never replaces the last ready image.
 *
 * The commands run on the builder host (`environmentBuilder.hostId`, default
 * the hub's machine) through `Host.exec`, with every credential-like variable
 * of the hub's environment blanked, because a build runs commands from the
 * repository. The repository is read from git objects at the default branch,
 * so the working tree's uncommitted state does not matter.
 */
export class EnvironmentBuildService {
  private readonly queries = environmentBuildQueries;
  private readonly repos = new RepoQueries();
  private readonly active = new Map<string, string>();
  private readonly preparing = new Map<string, Promise<BuildResult>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly warned = new Set<string>();

  /** Starts the auto trigger. Builds a stopped hub left running are marked failed. */
  start(): void {
    if (this.timer) return;
    this.queries.failInterrupted(Date.now());
    this.timer = setInterval(
      () => void this.autoTick(),
      envNumber("BAND_ENVIRONMENT_BUILD_POLL_MS", DEFAULT_POLL_MS),
    );
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(repo: string): EnvironmentImageStatus {
    this.requireRepo(repo);
    const latest = this.queries.latest(repo);
    const current = this.queries.current(repo);
    return {
      builder: this.builderConfig(),
      current: current ? view(current, false) : null,
      latest: latest ? view(latest, true) : null,
      builds: this.queries.list(repo, 10).map((r) => view(r, false)),
    };
  }

  /** The image a runner should boot for the repo, or null before the first ready build. */
  currentImage(repo: string): string | null {
    return this.queries.current(repo)?.image ?? null;
  }

  /**
   * Starts a build of the repo's environment at the default branch, or
   * reports that one is running or already cached. Returns once the build has
   * started. The build row carries its progress.
   */
  async build(
    repo: string,
    options: { trigger?: "manual" | "auto"; force?: boolean } = {},
  ): Promise<BuildResult> {
    const runningId = this.active.get(repo);
    if (runningId) {
      const row = this.queries.get(runningId);
      if (row) return { build: view(row, false), cacheHit: false, alreadyRunning: true };
    }
    const pending = this.preparing.get(repo);
    if (pending) return pending;
    const promise = this.prepareAndStart(repo, options.trigger ?? "manual", !!options.force);
    this.preparing.set(repo, promise);
    try {
      return await promise;
    } finally {
      this.preparing.delete(repo);
    }
  }

  /** Resolves when no build is running. For tests and shutdown. */
  async idle(): Promise<void> {
    while (this.active.size > 0 || this.preparing.size > 0) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  // ---- preparing -----------------------------------------------------------

  private builderConfig(): { hostId: string; registry: string | null; workerImage: string } {
    const cfg = settingsService.get().environmentBuilder ?? {};
    return {
      hostId: cfg.hostId || "local",
      registry: cfg.registry?.trim() || null,
      workerImage: cfg.workerImage || DEFAULT_WORKER_IMAGE,
    };
  }

  private requireRepo(repo: string): { path: string; defaultBranch: string } {
    const location = this.repos.findLocation(repo);
    if (!location) {
      throw new TRPCError({ code: "NOT_FOUND", message: `Repo not found: ${repo}` });
    }
    return location;
  }

  private async prepareAndStart(
    repo: string,
    trigger: "manual" | "auto",
    force: boolean,
  ): Promise<BuildResult> {
    const plan = await this.plan(repo);
    if (!force) {
      const cached = this.queries.readyForKey(repo, plan.key, plan.host.id);
      if (cached?.image && (await this.imageExists(plan.host, cached.image))) {
        return { build: view(cached, false), cacheHit: true, alreadyRunning: false };
      }
    }
    const row: EnvironmentBuildRow = {
      id: randomUUID(),
      repo,
      key: plan.key,
      status: "building",
      image: null,
      hostId: plan.host.id,
      commit: plan.commit,
      trigger,
      log: "",
      error: null,
      startedAt: Date.now(),
      endedAt: null,
    };
    this.queries.insert(row);
    this.active.set(repo, row.id);
    void this.run(row, plan);
    return { build: view(row, false), cacheHit: false, alreadyRunning: false };
  }

  /** Reads the environment at the default branch and works out the key. Rejects with a message for the caller. */
  private async plan(repo: string): Promise<Plan> {
    const location = this.requireRepo(repo);
    const cfg = this.builderConfig();
    let host: Host;
    try {
      host = hostRegistry.hostById(cfg.hostId);
    } catch {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `environmentBuilder.hostId "${cfg.hostId}" is not a known host`,
      });
    }
    const repoPath = hostRegistry.repoPathOn(repo, host.id, location.path);
    if (repoPath === null) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Repo "${repo}" has no checkout on host "${host.id}"`,
      });
    }

    await this.requireDocker(host);

    const ref = await this.resolveRef(host, repoPath, location.defaultBranch);
    const commit = (await this.git(host, repoPath, ["rev-parse", ref])).trim();
    const text = await this.git(host, repoPath, ["show", `${ref}:${ENVIRONMENT_FILE}`]).catch(
      () => {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `${ENVIRONMENT_FILE} does not exist at ${ref}. Commit it to the default branch first.`,
        });
      },
    );
    const parsed = parseEnvironment(text);
    if (!parsed.ok) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `${ENVIRONMENT_FILE} at ${ref} has problems: ${parsed.issues
          .map((i) => `${i.path || "(file)"}: ${i.message}`)
          .join("; ")}`,
      });
    }
    const environment = parsed.environment;
    if (!environment.build) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `${ENVIRONMENT_FILE} has no "build". Set build.devcontainer, build.dockerfile or build.image to build an image.`,
      });
    }
    const references = await checkReferences(environment, (path) =>
      this.git(host, repoPath, ["cat-file", "-e", `${ref}:${path}`]).then(
        () => true,
        () => false,
      ),
    );
    if (references.length > 0) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: references.map((i) => `${i.path}: ${i.message}`).join("; "),
      });
    }

    const workerBase = await this.workerBaseId(host, cfg.workerImage);
    const files: Record<string, string> = {};
    for (const input of keyInputs(environment)) {
      try {
        files[input.path] = (
          await this.git(host, repoPath, ["rev-parse", `${ref}:${input.path}`])
        ).trim();
      } catch {
        if (input.required) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `${input.path} does not exist at ${ref}`,
          });
        }
      }
    }
    const key = imageKey({ files, image: environment.build.image, workerBase });
    return {
      host,
      repoPath,
      repo,
      environment,
      ref,
      commit,
      key,
      tag: imageTag(repo, key, cfg.registry ?? undefined),
      workerImage: cfg.workerImage,
      registry: cfg.registry ?? undefined,
    };
  }

  private async resolveRef(host: Host, repoPath: string, branch: string): Promise<string> {
    // `origin/<branch>` follows the fetch the branch poller does. A repo with
    // no remote has only the local branch.
    for (const candidate of [`origin/${branch}`, branch]) {
      const ok = await this.git(host, repoPath, ["rev-parse", "--verify", candidate]).then(
        () => true,
        () => false,
      );
      if (ok) return candidate;
    }
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Default branch "${branch}" was not found in ${repoPath}`,
    });
  }

  private git(host: Host, cwd: string, args: string[]): Promise<string> {
    return host.git.exec(args, cwd).then((r) => r.stdout);
  }

  private dockerBin(host: Host): string {
    return host.id === hostRegistry.local.id ? process.env.BAND_DOCKER_BIN || "docker" : "docker";
  }

  private devcontainerBin(host: Host): string {
    return host.id === hostRegistry.local.id
      ? process.env.BAND_DEVCONTAINER_BIN || "devcontainer"
      : "devcontainer";
  }

  private async requireDocker(host: Host): Promise<void> {
    try {
      await host.exec(this.dockerBin(host), ["version", "--format", "{{.Server.Version}}"], {
        env: scrubEnv(process.env),
        timeoutMs: 30_000,
      });
    } catch (err) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `Docker is not available on host "${host.id}": ${(err as Error).message}. Environment images are built on a host with a running Docker daemon (environmentBuilder.hostId).`,
      });
    }
  }

  private async workerBaseId(host: Host, image: string): Promise<string> {
    try {
      const out = await host.exec(
        this.dockerBin(host),
        ["image", "inspect", "--format", "{{.Id}}", image],
        { env: scrubEnv(process.env), timeoutMs: 30_000 },
      );
      return out.stdout.trim();
    } catch {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `The worker base image "${image}" is not on host "${host.id}". Build it there with: docker build -f docker/worker.Dockerfile -t ${image} . (or set environmentBuilder.workerImage).`,
      });
    }
  }

  private imageExists(host: Host, image: string): Promise<boolean> {
    return host
      .exec(this.dockerBin(host), ["image", "inspect", "--format", "{{.Id}}", image], {
        env: scrubEnv(process.env),
        timeoutMs: 30_000,
      })
      .then(
        () => true,
        () => false,
      );
  }

  // ---- running ---------------------------------------------------------------

  private async run(row: EnvironmentBuildRow, plan: Plan): Promise<void> {
    const log = new BuildLog(row.id, (id, text) => this.queries.setLog(id, text));
    let tmp: string | null = null;
    const container = `band-env-${row.id.slice(0, 12)}`;
    let failure: string | null = null;
    try {
      log.add(`Building ${plan.tag} for ${plan.repo} at ${plan.ref} (${plan.commit.slice(0, 12)})`);
      log.flush();
      tmp = await plan.host.fs.mkdtemp("band-env-");
      await this.exportCheckout(plan, tmp, log);
      const toolchain = await this.buildToolchain(plan, tmp, log);
      const layered = await this.addWorkerLayer(plan, tmp, toolchain, log);
      await this.install(plan, tmp, layered, container, log);
      if (plan.registry) await this.push(plan, log);
      log.add(`Done: ${plan.tag}`);
    } catch (err) {
      failure = (err as Error).message;
      log.add(`FAILED: ${failure}`);
    }
    // Cleanup comes before the row ends, so a caller that sees the build end
    // and asks again finds no build running.
    await this.exec(plan.host, "docker", ["rm", "--force", container], log, { quiet: true }).catch(
      () => undefined,
    );
    // The intermediate tags are only names for layers the final image keeps.
    await this.exec(
      plan.host,
      "docker",
      ["rmi", toolchainTag(plan.repo, plan.key), layeredTag(plan.repo, plan.key)],
      log,
      { quiet: true },
    ).catch(() => undefined);
    if (tmp) await plan.host.fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    try {
      if (failure === null) {
        this.queries.finish(row.id, {
          status: "ready",
          image: plan.tag,
          log: log.toString(),
          at: Date.now(),
        });
      } else {
        this.queries.finish(row.id, {
          status: "failed",
          error: failure.slice(0, 2000),
          log: log.toString(),
          at: Date.now(),
        });
      }
    } finally {
      this.active.delete(plan.repo);
    }
  }

  /** Runs a command on the builder host, adding it and its output to the log. */
  private async exec(
    host: Host,
    tool: "docker" | "devcontainer" | "git",
    args: string[],
    log: BuildLog,
    options: { cwd?: string; env?: Record<string, string>; quiet?: boolean } = {},
  ): Promise<string> {
    const bin =
      tool === "docker"
        ? this.dockerBin(host)
        : tool === "devcontainer"
          ? this.devcontainerBin(host)
          : "git";
    if (!options.quiet) log.add(`$ ${tool} ${args.join(" ")}`);
    try {
      const out = await host.exec(bin, args, {
        cwd: options.cwd,
        env: { ...scrubEnv(process.env), ...options.env },
        timeoutMs: envNumber("BAND_ENVIRONMENT_BUILD_TIMEOUT_MS", DEFAULT_STEP_TIMEOUT_MS),
      });
      if (!options.quiet) {
        if (out.stdout.trim()) log.add(out.stdout.trimEnd());
        if (out.stderr.trim()) log.add(out.stderr.trimEnd());
        log.flush();
      }
      return out.stdout;
    } catch (err) {
      if (!options.quiet) {
        log.add((err as Error).message);
        log.flush();
      }
      throw new Error(`${tool} ${args[0] ?? ""} failed: ${firstLine((err as Error).message)}`);
    }
  }

  /** Writes the default branch's files, with no `.git`, to `<tmp>/src`. */
  private async exportCheckout(plan: Plan, tmp: string, log: BuildLog): Promise<void> {
    const src = posix.join(tmp, "src");
    await plan.host.fs.mkdir(src);
    const index = posix.join(tmp, "index");
    await this.exec(plan.host, "git", ["read-tree", plan.ref], log, {
      cwd: plan.repoPath,
      env: { GIT_INDEX_FILE: index },
    });
    await this.exec(plan.host, "git", ["checkout-index", "--all", `--prefix=${src}/`], log, {
      cwd: plan.repoPath,
      env: { GIT_INDEX_FILE: index },
    });
  }

  /** Layer 2: returns the tag of an image holding the repo's toolchain. */
  private async buildToolchain(plan: Plan, tmp: string, log: BuildLog): Promise<string> {
    const build = plan.environment.build;
    const src = posix.join(tmp, "src");
    const tag = toolchainTag(plan.repo, plan.key);
    if (build?.dockerfile !== undefined) {
      await this.exec(
        plan.host,
        "docker",
        dockerBuildArgs({ checkout: src, dockerfile: build.dockerfile, tag }),
        log,
      );
      return tag;
    }
    if (build?.devcontainer !== undefined) {
      try {
        await this.exec(
          plan.host,
          "devcontainer",
          devcontainerBuildArgs({ checkout: src, config: build.devcontainer, tag }),
          log,
        );
      } catch (err) {
        throw new Error(
          `${(err as Error).message}. Building a devcontainer needs the devcontainers CLI on host "${plan.host.id}" (npm install -g @devcontainers/cli).`,
        );
      }
      return tag;
    }
    const image = build?.image as string;
    await this.exec(plan.host, "docker", ["pull", image], log);
    return image;
  }

  /** Layer 1 on top of layer 2: copies the worker from the worker base image. */
  private async addWorkerLayer(
    plan: Plan,
    tmp: string,
    toolchain: string,
    log: BuildLog,
  ): Promise<string> {
    const dir = posix.join(tmp, "layer");
    await plan.host.fs.mkdir(dir);
    await plan.host.fs.writeFile(
      posix.join(dir, "Dockerfile"),
      workerLayerDockerfile({ from: toolchain, workerBase: plan.workerImage }),
    );
    await plan.host.fs.writeFile(posix.join(dir, "band-worker.sh"), workerLauncherScript(), {
      mode: 0o755,
    });
    // The layer's `COPY root/ /` creates /work with a mode every uid can write.
    await plan.host.fs.mkdir(posix.join(dir, "root", "work"), { recursive: true });
    const tag = layeredTag(plan.repo, plan.key);
    await this.exec(plan.host, "docker", ["build", "--tag", tag, dir], log);
    return tag;
  }

  /** Runs `install` at the default branch inside the image and commits the result as the final tag. */
  private async install(
    plan: Plan,
    tmp: string,
    layered: string,
    container: string,
    log: BuildLog,
  ): Promise<void> {
    const install = plan.environment.install;
    if (install === undefined) {
      await this.exec(plan.host, "docker", ["tag", layered, plan.tag], log);
      return;
    }
    await this.exec(
      plan.host,
      "docker",
      installCreateArgs({ name: container, image: layered, install }),
      log,
    );
    await this.exec(
      plan.host,
      "docker",
      ["cp", `${posix.join(tmp, "src")}/.`, `${container}:${IMAGE_WORKDIR}`],
      log,
    );
    await this.exec(plan.host, "docker", ["start", "--attach", container], log);
    await this.exec(
      plan.host,
      "docker",
      commitArgs({ container, tag: plan.tag, key: plan.key, commit: plan.commit }),
      log,
    );
  }

  private async push(plan: Plan, log: BuildLog): Promise<void> {
    await this.exec(plan.host, "docker", ["push", plan.tag], log);
  }

  // ---- auto trigger ----------------------------------------------------------

  /**
   * Rebuilds the repos that have been built before when the default
   * branch's environment files or lockfiles changed. A key that already failed
   * is not retried until the files change again.
   */
  async autoTick(): Promise<void> {
    // A slow remote builder must not let ticks pile up.
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.autoTickOnce();
    } finally {
      this.ticking = false;
    }
  }

  private ticking = false;

  private async autoTickOnce(): Promise<void> {
    for (const repo of this.queries.reposWithBuilds()) {
      if (this.active.has(repo) || this.preparing.has(repo)) continue;
      if (!this.repos.findLocation(repo)) continue;
      try {
        const plan = await this.plan(repo);
        const latest = this.queries.latest(repo);
        if (latest?.key === plan.key) continue;
        if (this.queries.readyForKey(repo, plan.key, plan.host.id)) continue;
        await this.build(repo, { trigger: "auto" });
      } catch (err) {
        const message = (err as Error).message;
        if (!this.warned.has(`${repo}:${message}`)) {
          this.warned.add(`${repo}:${message}`);
          console.warn("environment image auto build for %s skipped: %s", repo, message);
        }
      }
    }
  }
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim() !== "") ?? text;
  return line.length > 300 ? `${line.slice(0, 300)}...` : line;
}

export const environmentBuildService = new EnvironmentBuildService();
