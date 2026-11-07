import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { Socket } from "node:net";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { encodeStreamFrame, StreamFrameReader } from "@band-app/extension-worker-sdk/protocol";
import type { LanguageServerSpec } from "@band-app/host-local/lsp/lsp-manager";
import {
  type ExtensionServiceState,
  type ExtensionsFetchParams,
  type ExtensionsFetchReply,
  type ExtensionsSyncParams,
  type ExtensionsSyncReply,
  type LanguageServerState,
  METHOD_EXTENSIONS_CHANGED,
  METHOD_EXTENSIONS_FETCH,
  METHOD_EXTENSIONS_STATUS,
  METHOD_EXTENSIONS_SYNC,
  RpcError,
} from "@band-app/link";
import type { Logger } from "@band-app/logger";
import {
  type ExtensionManifest,
  extensionManifestSchema,
  type WorkerServiceManifest,
} from "@band-app/plugin-api";
import type { PluginStream, ReleaseReason, StreamMessage } from "@band-app/plugin-api/worker";
import { readTarGz, TarError } from "@band-app/shared/tar-extract";
import type { Registrar, WorkerContext } from "./context.ts";
import { checkRequires } from "./plugins.ts";
import { RPC_INVALID_PARAMS } from "./rpc-util.ts";

export const MANIFEST_FILE = "band-extension.json";
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 500 * 1024 * 1024;
const INIT_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 5 * 60_000;
const STOP_GRACE_MS = 3000;
const MAX_CRASHES = 3;
/** Capability names the worker reports itself. A service may not claim them. */
const RESERVED_CAPABILITIES = new Set([
  "git",
  "gh",
  "fsWatch",
  "search",
  "lsp",
  "pty",
  "acp",
  "desktop",
  "direct",
  "chatOwnership",
]);
const CRASH_WINDOW_MS = 5 * 60_000;

/** Variables a service inherits. Nothing else, so no `BAND_*` or `GIT_CONFIG_*` reaches it. */
const INHERITED_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TZ",
  "DISPLAY",
  "XDG_RUNTIME_DIR",
] as const;

export interface SpawnSpec {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/**
 * How a service process is started. Under Electron (the desktop app's bundled worker) the
 * executable is Band itself, which runs as plain Node only with `ELECTRON_RUN_AS_NODE=1`, so the
 * spawn sets it in its own env and never relies on what the worker inherited. The env is a short
 * allowlist of the worker's own.
 */
export function serviceSpawnSpec(
  entry: string,
  options: {
    env?: NodeJS.ProcessEnv;
    execPath?: string;
    electron?: boolean;
  } = {},
): SpawnSpec {
  const source = options.env ?? process.env;
  const env: NodeJS.ProcessEnv = {};
  for (const key of INHERITED_ENV) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  const electron = options.electron ?? process.versions.electron !== undefined;
  if (electron) env.ELECTRON_RUN_AS_NODE = "1";
  return { command: options.execPath ?? process.execPath, args: [entry], env };
}

/** An async iterable fed by `push`, for a stream's output. */
class Pushable implements AsyncIterable<StreamMessage> {
  private readonly queue: StreamMessage[] = [];
  private waiting: ((r: IteratorResult<StreamMessage>) => void) | null = null;
  private done = false;

  push(message: StreamMessage): void {
    if (this.done) return;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w({ value: message, done: false });
    } else this.queue.push(message);
  }

  end(): void {
    this.done = true;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<StreamMessage> {
    return {
      next: () => {
        const head = this.queue.shift();
        if (head !== undefined) return Promise.resolve({ value: head, done: false });
        if (this.done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
      return: () => {
        this.end();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** One running service process and the stdio protocol to it (`@band-app/extension-worker-sdk`). */
class ServiceProcess {
  private nextId = 1;
  private nextStream = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly streams = new Map<number, { out: Pushable }>();
  private exited = false;
  readonly exit: Promise<{ code: number | null; signal: string | null }>;
  private stderrTail: string[] = [];

  constructor(
    private readonly child: ChildProcess,
    private readonly log: Logger,
  ) {
    const rl = createInterface({ input: child.stdout as NodeJS.ReadableStream });
    rl.on("line", (line) => this.onLine(line));
    child.stderr?.on("data", (chunk: Buffer) => {
      for (const l of chunk.toString("utf8").split("\n")) {
        if (!l) continue;
        this.stderrTail.push(l);
        if (this.stderrTail.length > 20) this.stderrTail.shift();
      }
    });
    const pipe = child.stdio[3] as Socket | null | undefined;
    const reader = new StreamFrameReader();
    pipe?.on("data", (chunk: Buffer) => {
      try {
        for (const { streamId, message } of reader.push(chunk)) {
          this.streams.get(streamId)?.out.push(message);
        }
      } catch (err) {
        this.log.warn({ message: String(err) }, "bad stream frame from an extension service");
      }
    });
    pipe?.on("error", () => undefined);
    child.stdin?.on("error", () => undefined);
    this.exit = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        this.exited = true;
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error(`the service exited (${signal ?? `code ${code}`})`));
          this.pending.delete(id);
        }
        for (const s of this.streams.values()) s.out.end();
        this.streams.clear();
        resolve({ code, signal });
      });
      child.once("error", (err) => {
        this.log.warn({ message: String(err) }, "extension service process error");
      });
    });
  }

  get stderr(): string {
    return this.stderrTail.join("\n");
  }

  private onLine(line: string): void {
    let msg: {
      id?: number;
      result?: unknown;
      error?: { message?: string };
      method?: string;
      params?: { streamId?: unknown };
    };
    try {
      msg = JSON.parse(line);
    } catch {
      this.log.debug({ line: line.slice(0, 200) }, "extension service wrote a non-JSON line");
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message ?? "the service failed"));
      else p.resolve(msg.result);
    } else if (msg.method === "stream.end") {
      const id = Number(msg.params?.streamId);
      this.streams.get(id)?.out.end();
      this.streams.delete(id);
    }
  }

  request(method: string, params: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
    if (this.exited) return Promise.reject(new Error("the service is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`the service did not answer ${method} in time`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin?.write(`${JSON.stringify({ id, method, params })}\n`, (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  async openStream(
    name: string,
    params: unknown,
    scope: { worktreeKey: string; worktreePath: string },
  ): Promise<PluginStream> {
    const streamId = this.nextStream++;
    const out = new Pushable();
    this.streams.set(streamId, { out });
    try {
      await this.request("stream.open", { streamId, name, params, ...scope }, 30_000);
    } catch (err) {
      this.streams.delete(streamId);
      throw err;
    }
    const pipe = this.child.stdio[3] as Socket | null | undefined;
    return {
      output: out,
      write: (message) => {
        if (this.streams.has(streamId)) pipe?.write(encodeStreamFrame(streamId, message));
      },
      close: () => {
        if (!this.streams.delete(streamId)) return;
        out.end();
        this.request("stream.close", { streamId }, 5000).catch(() => undefined);
      },
    };
  }

  /** Asks the service to stop, then kills it after a grace period. Resolves once it has exited. */
  async stop(): Promise<void> {
    if (this.exited) return;
    await this.request("stop", {}, STOP_GRACE_MS).catch(() => undefined);
    const killer = setTimeout(() => this.child.kill("SIGKILL"), STOP_GRACE_MS);
    this.child.stdin?.end();
    await this.exit;
    clearTimeout(killer);
  }

  kill(): void {
    if (!this.exited) this.child.kill("SIGKILL");
  }
}

type ServiceStateName = ExtensionServiceState["state"] | "starting";

interface Service {
  extensionId: string;
  version: string;
  def: WorkerServiceManifest;
  dir: string;
  state: ServiceStateName;
  reason?: string;
  proc?: ServiceProcess;
  /** Start times of recent unexpected exits. */
  crashes: number[];
  /** Worktrees the service has served: hub key to folder. */
  scopes: Map<string, string>;
  restartTimer?: NodeJS.Timeout;
  starting?: Promise<void>;
  /** Set while the host stops the service on purpose. */
  stopping: boolean;
}

export interface ExtensionHostOptions {
  stateDir: string;
  workerId: string;
  workerVersion: string;
  log: Logger;
  /** Gets an extension's `.tar.gz` from the hub. */
  fetchArchive: (id: string, version: string) => Promise<{ sha256: string; bytes: Buffer }>;
  /** Whether the lease allows new work. Services do not start or restart while it is false. */
  mayRun?: () => boolean;
  /** Whether a bundled plugin has this id, so it wins over an extension's service. */
  bundledHas?: (capability: string) => boolean;
  /** Called when the set of states changes without a sync (a crash, a restart, a failure). */
  onChanged?: () => void;
  /** First restart delay, doubled each time. Default 1 s. */
  restartBackoffMs?: number;
  /** Replaces how a process is spawned. For tests of the spawn spec. */
  spawnSpec?: (entry: string) => SpawnSpec;
}

/**
 * Runs the worker services of installed extensions, each as its own process. The hub tells the
 * worker which extensions it should run (`extensions.sync`), the worker downloads and checks
 * them, unpacks each under `<state dir>/extensions/<id>/<version>/` and starts one process per
 * service that this worker may run. Routing mirrors {@link WorkerPlugins}: `plugin.call` and
 * `plugin.stream` for a service's capability reach its process.
 */
export class ExtensionHost {
  private readonly services = new Map<string, Service>();
  private readonly problems = new Map<string, string>();
  /** Language servers of the extensions synced now, by `<extension id>/<server id>`. */
  private lsServers = new Map<string, { state: LanguageServerState; spec: LanguageServerSpec }>();
  private chain: Promise<unknown> = Promise.resolve();
  private fenced = false;

  /** True while the lease does not allow new work: nothing starts or restarts. */
  private get blocked(): boolean {
    return this.fenced || this.options.mayRun?.() === false;
  }
  private closed = false;

  constructor(private readonly options: ExtensionHostOptions) {}

  private get root(): string {
    return join(this.options.stateDir, "extensions");
  }

  private key(s: { extensionId: string; def: { id: string } }): string {
    return `${s.extensionId}/${s.def.id}`;
  }

  /** Capabilities of the services that run now. */
  capabilities(): string[] {
    return [...this.services.values()]
      .filter((s) => s.state === "running" || s.state === "stopped")
      .map((s) => s.def.capability);
  }

  has(capability: string): boolean {
    for (const s of this.services.values()) if (s.def.capability === capability) return true;
    return false;
  }

  /** The language servers the worker's LSP manager can start. Empty while the lease is fenced. */
  languageServers(): LanguageServerSpec[] {
    if (this.blocked) return [];
    return [...this.lsServers.values()].map((v) => v.spec);
  }

  states(): ExtensionsSyncReply {
    const services: ExtensionServiceState[] = [...this.services.values()].map((s) => ({
      extensionId: s.extensionId,
      serviceId: s.def.id,
      capability: s.def.capability,
      version: s.version,
      state: s.state === "starting" ? "restarting" : s.state,
      ...(s.reason ? { reason: s.reason } : {}),
    }));
    return {
      services,
      languageServers: [...this.lsServers.values()].map((v) => v.state),
      problems: [...this.problems].map(([extensionId, reason]) => ({ extensionId, reason })),
    };
  }

  /** Makes the running set equal to `params.items`. Calls are serialised. */
  sync(params: ExtensionsSyncParams): Promise<ExtensionsSyncReply> {
    const run = this.chain.then(() => this.doSync(params));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async doSync(params: ExtensionsSyncParams): Promise<ExtensionsSyncReply> {
    const { log } = this.options;
    const wanted = new Map(params.items.map((i) => [i.id, i]));
    // Stop what is no longer wanted or is a different version.
    for (const [k, s] of [...this.services]) {
      const want = wanted.get(s.extensionId);
      if (!want || want.version !== s.version) {
        await this.stopService(s, "shutdown");
        this.services.delete(k);
      }
    }
    for (const id of [...this.problems.keys()]) if (!wanted.has(id)) this.problems.delete(id);
    // Remove folders of extensions and versions that are not wanted.
    for (const id of await readdir(this.root).catch(() => [] as string[])) {
      if (id.startsWith(".")) {
        await rm(join(this.root, id), { recursive: true, force: true });
        continue;
      }
      const want = wanted.get(id);
      if (!want) {
        await rm(join(this.root, id), { recursive: true, force: true });
        continue;
      }
      for (const version of await readdir(join(this.root, id)).catch(() => [] as string[])) {
        if (version !== want.version) {
          await rm(join(this.root, id, version), { recursive: true, force: true });
        }
      }
    }
    for (const item of params.items) {
      const existing = [...this.services.values()].filter(
        (s) => s.extensionId === item.id && s.version === item.version,
      );
      if (existing.length > 0) {
        // A failed service gets a fresh start with every sync.
        for (const s of existing) {
          if (s.state === "failed" && !this.blocked) {
            s.crashes = [];
            s.reason = undefined;
            await this.start(s);
          }
        }
        continue;
      }
      try {
        const dir = await this.unpack(item.id, item.version, item.sha256);
        const manifest = await readManifest(dir, item.id);
        if (manifest.version !== item.version) {
          throw new Error(`the archive holds version ${manifest.version}, not ${item.version}`);
        }
        this.problems.delete(item.id);
        for (const def of manifest.contributes.workerServices) {
          const service: Service = {
            extensionId: item.id,
            version: item.version,
            def,
            dir,
            state: "starting",
            crashes: [],
            scopes: new Map(),
            stopping: false,
          };
          this.services.set(this.key(service), service);
          const why = this.ineligible(def);
          if (why) {
            service.state = "not-eligible";
            service.reason = why;
            log.info(
              { extension: item.id, service: def.id, reason: why },
              "extension service not eligible here",
            );
            continue;
          }
          await this.start(service);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.problems.set(item.id, message);
        log.warn({ extension: item.id, message }, "could not set up an extension");
      }
    }
    await this.loadLanguageServers(params);
    return this.states();
  }

  /** Rebuilds the language server list from the manifests of the synced extensions. */
  private async loadLanguageServers(params: ExtensionsSyncParams): Promise<void> {
    const next = new Map<string, { state: LanguageServerState; spec: LanguageServerSpec }>();
    for (const item of params.items) {
      if (this.problems.has(item.id)) continue;
      try {
        const dir = await this.unpack(item.id, item.version, item.sha256);
        const manifest = await readManifest(dir, item.id);
        for (const def of manifest.contributes.languageServers) {
          const key = `${item.id}/${def.id}`;
          const why = checkRequires(def.requires, process.env.PATH);
          const unavailable = why?.replace(/^(.+) is not on the PATH$/, "needs $1") ?? undefined;
          next.set(key, {
            spec: {
              key,
              dir,
              command: def.command,
              args: def.args,
              rootMarkers: def.rootMarkers,
              ...(unavailable ? { unavailable } : {}),
            },
            state: {
              extensionId: item.id,
              serverId: def.id,
              key,
              languages: def.languages,
              files: def.files,
              state: unavailable ? "unavailable" : "ready",
              ...(unavailable ? { reason: unavailable } : {}),
            },
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.problems.set(item.id, message);
        this.options.log.warn({ extension: item.id, message }, "could not set up an extension");
      }
    }
    this.lsServers = next;
  }

  private ineligible(def: WorkerServiceManifest): string | null {
    if (RESERVED_CAPABILITIES.has(def.capability)) {
      return `${def.capability} is a built-in worker capability`;
    }
    for (const s of this.services.values()) {
      if (s.def !== def && s.def.capability === def.capability && s.state !== "not-eligible") {
        return `another extension service already provides ${def.capability}`;
      }
    }
    if (this.options.bundledHas?.(def.capability)) {
      return `a bundled plugin named ${def.capability} runs here and takes precedence`;
    }
    return checkRequires(def.requires, process.env.PATH);
  }

  private async unpack(id: string, version: string, sha256: string): Promise<string> {
    const target = join(this.root, id, version);
    const marker = join(target, ".sha256");
    if (existsSync(marker) && (await readFile(marker, "utf8").catch(() => "")).trim() === sha256) {
      return target;
    }
    const { sha256: given, bytes } = await this.options.fetchArchive(id, version);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== sha256.toLowerCase() || given.toLowerCase() !== actual) {
      throw new Error("the downloaded archive does not match its sha256");
    }
    if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error("the archive is over the 200 MB limit");
    let files: ReturnType<typeof readTarGz>;
    try {
      files = readTarGz(bytes, { maxBytes: MAX_EXPANDED_BYTES, maxEntries: 20_000 });
    } catch (err) {
      if (err instanceof TarError) throw new Error(err.message);
      throw err;
    }
    const tops = new Set(files.map((f) => f.path.split("/")[0]));
    if (
      files.length === 0 ||
      tops.size !== 1 ||
      tops.has(undefined as never) ||
      files.some((f) => !f.path.includes("/"))
    ) {
      throw new Error("the archive must hold one top-level folder and nothing else");
    }
    const top = [...tops][0] as string;
    if (top !== id) throw new Error(`the archive folder "${top}" is not "${id}"`);
    const staging = join(this.root, `.unpack-${randomBytes(6).toString("hex")}`);
    try {
      for (const file of files) {
        const dest = join(staging, file.path.slice(top.length + 1));
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, file.data, { mode: file.path.endsWith(".mjs") ? 0o755 : 0o644 });
      }
      await writeFile(join(staging, ".sha256"), `${sha256}\n`);
      await mkdir(dirname(target), { recursive: true });
      await rm(target, { recursive: true, force: true });
      await rename(staging, target);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    return target;
  }

  private start(service: Service): Promise<void> {
    service.starting ??= this.doStart(service).finally(() => {
      service.starting = undefined;
    });
    return service.starting;
  }

  private async doStart(service: Service): Promise<void> {
    const { log, workerId } = this.options;
    // Like acp.spawn: nothing starts while the lease is not valid. The next renewal starts it.
    if (this.blocked) {
      service.state = "stopped";
      service.reason = undefined;
      return;
    }
    const entry = join(service.dir, service.def.entry);
    const spec = this.options.spawnSpec?.(entry) ?? serviceSpawnSpec(entry);
    service.state = "starting";
    service.reason = undefined;
    const stateDir = join(
      this.options.stateDir,
      "extension-state",
      service.extensionId,
      service.def.id,
    );
    await mkdir(stateDir, { recursive: true });
    let child: ChildProcess;
    try {
      child = spawn(spec.command, spec.args, {
        cwd: service.dir,
        env: spec.env,
        stdio: ["pipe", "pipe", "pipe", "pipe"],
      });
    } catch (err) {
      this.fail(service, `could not start: ${String(err)}`);
      return;
    }
    const proc = new ServiceProcess(child, log);
    service.proc = proc;
    void proc.exit.then(({ code, signal }) => this.onExit(service, proc, code, signal));
    try {
      await proc.request(
        "init",
        { worker: workerId, version: service.version, serviceId: service.def.id, stateDir },
        INIT_TIMEOUT_MS,
      );
    } catch (err) {
      const detail = proc.stderr ? ` (${proc.stderr.split("\n").slice(-3).join(" | ")})` : "";
      service.stopping = true;
      proc.kill();
      await proc.exit;
      service.stopping = false;
      service.proc = undefined;
      if (service.restartTimer) clearTimeout(service.restartTimer);
      service.restartTimer = undefined;
      this.fail(
        service,
        `did not start: ${err instanceof Error ? err.message : String(err)}${detail}`,
      );
      return;
    }
    service.state = "running";
    log.info(
      { extension: service.extensionId, service: service.def.id },
      "extension service running",
    );
    this.options.onChanged?.();
  }

  private fail(service: Service, reason: string): void {
    service.state = "failed";
    service.reason = reason;
    this.options.log.warn(
      { extension: service.extensionId, service: service.def.id, reason },
      "extension service failed",
    );
    this.options.onChanged?.();
  }

  private onExit(
    service: Service,
    proc: ServiceProcess,
    code: number | null,
    signal: string | null,
  ): void {
    if (service.proc !== proc) return;
    service.proc = undefined;
    if (service.stopping || this.closed) return;
    const now = Date.now();
    service.crashes = service.crashes.filter((t) => now - t < CRASH_WINDOW_MS);
    service.crashes.push(now);
    const how = signal ?? `code ${code}`;
    const tail = proc.stderr.split("\n").slice(-2).join(" | ");
    if (service.crashes.length >= MAX_CRASHES) {
      this.fail(
        service,
        `crashed ${MAX_CRASHES} times in ${CRASH_WINDOW_MS / 60_000} minutes (last exit: ${how}${tail ? `, ${tail}` : ""})`,
      );
      return;
    }
    service.state = "restarting";
    service.reason = `exited (${how}), restarting`;
    this.options.log.warn(
      { extension: service.extensionId, service: service.def.id, exit: how },
      "extension service exited, restarting",
    );
    this.options.onChanged?.();
    const delay = (this.options.restartBackoffMs ?? 1000) * 2 ** (service.crashes.length - 1);
    service.restartTimer = setTimeout(() => {
      service.restartTimer = undefined;
      if (this.closed || service.stopping) return;
      if (this.blocked) {
        service.state = "stopped";
        service.reason = undefined;
        return;
      }
      void this.start(service);
    }, delay);
  }

  private async stopService(service: Service, reason: ReleaseReason): Promise<void> {
    service.stopping = true;
    if (service.restartTimer) clearTimeout(service.restartTimer);
    service.restartTimer = undefined;
    await service.starting?.catch(() => undefined);
    const proc = service.proc;
    if (proc) {
      for (const key of service.scopes.keys()) {
        await proc
          .request("worktree.release", { worktreeKey: key, reason }, 5000)
          .catch(() => undefined);
      }
      await proc.stop().catch(() => undefined);
    }
    service.proc = undefined;
    service.stopping = false;
  }

  private find(capability: string): Service {
    for (const s of this.services.values()) if (s.def.capability === capability) return s;
    throw new RpcError(RPC_INVALID_PARAMS, `unknown plugin ${capability}`);
  }

  private async running(capability: string): Promise<{ service: Service; proc: ServiceProcess }> {
    const service = this.find(capability);
    // A fence stopped the process. The lease check came first, so the worker may run again.
    if (service.state === "stopped" && !this.blocked) await this.start(service);
    if (service.state === "starting") await service.starting?.catch(() => undefined);
    if (service.state !== "running" || !service.proc) {
      const why = service.reason ? `: ${service.reason}` : "";
      throw new RpcError(RPC_INVALID_PARAMS, `this worker cannot run ${capability}${why}`);
    }
    return { service, proc: service.proc };
  }

  async call(
    capability: string,
    method: string,
    params: unknown,
    worktreeKey: string,
    worktreePath: string,
  ): Promise<unknown> {
    const { service, proc } = await this.running(capability);
    service.scopes.set(worktreeKey, worktreePath);
    try {
      return await proc.request("call", { method, params, worktreeKey, worktreePath });
    } catch (err) {
      throw new RpcError(RPC_INVALID_PARAMS, err instanceof Error ? err.message : String(err));
    }
  }

  async stream(
    capability: string,
    name: string,
    params: unknown,
    worktreeKey: string,
    worktreePath: string,
  ): Promise<PluginStream> {
    const { service, proc } = await this.running(capability);
    service.scopes.set(worktreeKey, worktreePath);
    try {
      return await proc.openStream(name, params, { worktreeKey, worktreePath });
    } catch (err) {
      throw new RpcError(RPC_INVALID_PARAMS, err instanceof Error ? err.message : String(err));
    }
  }

  /** The worktree at `path` was removed: every service deletes its state for it. */
  async releasePath(path: string): Promise<void> {
    for (const s of this.services.values()) {
      for (const [key, at] of [...s.scopes]) {
        if (at !== path) continue;
        s.scopes.delete(key);
        await s.proc
          ?.request("worktree.release", { worktreeKey: key, reason: "removed" }, 5000)
          .catch(() => undefined);
      }
    }
  }

  /** The hub renewed the lease: services the fence (or a lapsed lease) held back start now. */
  async resume(): Promise<void> {
    if (this.options.mayRun?.() === false || this.closed) return;
    this.fenced = false;
    for (const s of this.services.values()) {
      if (s.state === "stopped") await this.start(s);
    }
  }

  /** The lease ran out: every process is stopped. The next renewal starts them again. */
  async fence(): Promise<void> {
    this.fenced = true;
    for (const s of this.services.values()) {
      if (s.state === "running" || s.state === "restarting" || s.state === "starting") {
        await this.stopService(s, "fenced");
        s.state = "stopped";
        s.reason = undefined;
      }
    }
    this.options.onChanged?.();
  }

  async stop(): Promise<void> {
    this.closed = true;
    await this.chain.catch(() => undefined);
    for (const s of this.services.values()) await this.stopService(s, "shutdown");
  }
}

async function readManifest(dir: string, id: string): Promise<ExtensionManifest> {
  let raw: string;
  try {
    raw = await readFile(join(dir, MANIFEST_FILE), "utf8");
  } catch {
    throw new Error(`the archive has no ${MANIFEST_FILE}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`${MANIFEST_FILE} is not valid JSON`);
  }
  const parsed = extensionManifestSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`${MANIFEST_FILE}: ${issue?.path.join(".") || "manifest"}: ${issue?.message}`);
  }
  if (parsed.data.id !== id) throw new Error(`the manifest id "${parsed.data.id}" is not "${id}"`);
  return parsed.data;
}

/** Creates the host for a worker whose link is `ctx.session`. */
export function createExtensionHost(
  ctx: Omit<WorkerContext, "extensions">,
  options: {
    workerId: string;
    workerVersion: string;
    bundledHas: (id: string) => boolean;
  } & Partial<Pick<ExtensionHostOptions, "restartBackoffMs" | "spawnSpec">>,
): ExtensionHost {
  return new ExtensionHost({
    stateDir: ctx.stateDir,
    workerId: options.workerId,
    workerVersion: options.workerVersion,
    log: ctx.log,
    bundledHas: options.bundledHas,
    mayRun: () => !ctx.lease.isFenced(),
    ...(options.restartBackoffMs ? { restartBackoffMs: options.restartBackoffMs } : {}),
    ...(options.spawnSpec ? { spawnSpec: options.spawnSpec } : {}),
    onChanged: () => ctx.session.notify(METHOD_EXTENSIONS_CHANGED),
    fetchArchive: async (id, version) => {
      const request: ExtensionsFetchParams = { id, version };
      const reply = await ctx.session.request<ExtensionsFetchReply>(
        METHOD_EXTENSIONS_FETCH,
        request,
        {
          timeoutMs: 120_000,
        },
      );
      const ch = ctx.session.getChannel(reply.chan);
      if (!ch) throw new Error("the hub did not open the archive channel");
      const bytes = await ch.readAll();
      ch.end();
      return { sha256: reply.sha256, bytes };
    },
  });
}

/** Serves `extensions.sync` and `extensions.status`. */
export function registerExtensionMethods(r: Registrar, ctx: WorkerContext): void {
  const host = ctx.extensions;
  if (!host) return;
  r.json(METHOD_EXTENSIONS_SYNC, (a) => {
    const items = Array.isArray(a.items) ? a.items : null;
    if (!items) throw new RpcError(RPC_INVALID_PARAMS, "items must be an array");
    return host.sync({
      items: items.map((i: Record<string, unknown>) => {
        if (
          typeof i?.id !== "string" ||
          !/^[a-z][a-z0-9-]{0,63}$/.test(i.id) ||
          typeof i.version !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(i.version) ||
          typeof i.sha256 !== "string" ||
          !/^[0-9a-f]{64}$/i.test(i.sha256)
        ) {
          throw new RpcError(RPC_INVALID_PARAMS, "bad extension item");
        }
        return { id: i.id, version: i.version, sha256: i.sha256 };
      }),
    });
  });
  r.json(METHOD_EXTENSIONS_STATUS, () => host.states());
}
