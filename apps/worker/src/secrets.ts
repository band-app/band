/**
 * The secrets a worker gets from the hub for its profile (`secrets.fetch` on the link).
 *
 * Environment values stay in memory. Every process the worker starts asks for the current ones, so
 * a rotated item reaches the next process with no restart. If the hub cannot be reached, the last
 * values the worker held are used.
 *
 * Files are written under the worker user's home and kept in sync: at connect and whenever the hub
 * sends `secrets.changed`. The worker records each file it created in `<state dir>/secret-files.json`
 * and touches no other file: a mapping onto a file it did not create is refused and reported, and
 * a file leaves the disk only when its mapping goes away. A write goes to a temp file created with
 * the final mode and is renamed into place. A symlink that leaves the home directory is refused.
 */

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import type { LinkSession } from "@band-app/link";
import {
  METHOD_SECRETS_FETCH,
  METHOD_SECRETS_REPORT,
  type SecretsFetchReply,
  type SecretsReportParams,
} from "@band-app/link";
import type { Logger } from "@band-app/logger";

const MANIFEST = "secret-files.json";
const HUB_ANSWER_MS = 15_000;
const CACHE_MS = 30_000;

interface Manifest {
  /** Absolute paths of the files this worker created. */
  files: string[];
}

export interface SecretsOptions {
  session: LinkSession;
  stateDir: string;
  log: Logger;
  /** The worker user's home. Defaults to `os.homedir()`. */
  home?: string;
}

export class WorkerSecrets {
  private readonly home: string;
  private lastEnv: Record<string, string> = {};
  private queue: Promise<unknown> = Promise.resolve();
  private pendingSync: Promise<void> | null = null;
  private inflight: Promise<Record<string, string>> | null = null;
  private cache: { env: Record<string, string>; at: number } | null = null;

  constructor(private readonly opts: SecretsOptions) {
    this.home = opts.home ?? homedir();
  }

  /** The environment variables of the worker's profile, for a process about to start. */
  env(): Promise<Record<string, string>> {
    // Callers that ask at the same moment share one request.
    this.inflight ??= this.loadEnv().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /**
   * Like `env()`, for hub-requested git calls that can come many times a second. The answer is
   * reused until the hub sends `secrets.changed` (which calls `invalidate()`) or `CACHE_MS` pass.
   */
  async cachedEnv(): Promise<Record<string, string>> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.env;
    const env = await this.env();
    this.cache = { env, at: Date.now() };
    return env;
  }

  invalidate(): void {
    this.cache = null;
  }

  private async loadEnv(): Promise<Record<string, string>> {
    try {
      const reply = await this.fetch();
      this.lastEnv = reply.env;
      return reply.env;
    } catch (err) {
      // The message only: it never holds a value.
      this.opts.log.warn(
        { message: err instanceof Error ? err.message : String(err) },
        "could not fetch the profile secrets, using the last ones",
      );
      return this.lastEnv;
    }
  }

  /** Brings the mapped files in line with the hub's answer, then reports the outcome. */
  sync(): Promise<void> {
    this.invalidate();
    // A sync that has not started yet will fetch the newest answer, so a second request joins it.
    if (this.pendingSync) return this.pendingSync;
    const run = this.queue.then(() => {
      this.pendingSync = null;
      return this.doSync();
    });
    this.pendingSync = run;
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Deletes every file this worker created. For `uninstall-service`. */
  static removeAll(stateDir: string, log?: (line: string) => void): number {
    const manifest = readManifest(stateDir);
    let removed = 0;
    for (const file of manifest.files) {
      if (removeIfRegular(file)) removed++;
    }
    rmSync(join(stateDir, MANIFEST), { force: true });
    if (removed > 0) log?.(`Removed ${removed} secret file${removed === 1 ? "" : "s"}.`);
    return removed;
  }

  private fetch(): Promise<SecretsFetchReply> {
    return this.opts.session.request<SecretsFetchReply>(
      METHOD_SECRETS_FETCH,
      {},
      { timeoutMs: HUB_ANSWER_MS },
    );
  }

  private async doSync(): Promise<void> {
    let reply: SecretsFetchReply;
    try {
      reply = await this.fetch();
    } catch (err) {
      this.opts.log.warn(
        { message: err instanceof Error ? err.message : String(err) },
        "could not fetch the profile secrets for the files",
      );
      return;
    }
    this.lastEnv = reply.env;
    const manifest = readManifest(this.opts.stateDir);
    const owned = new Set(manifest.files);
    const report: SecretsReportParams = { written: [], refused: [] };
    const keep = new Set<string>();

    // Record what is about to be written first, so a crash midway leaves no file unrecorded.
    // A path that exists and is not ours is not recorded: we will refuse it.
    const intended = new Set(owned);
    for (const entry of reply.files) {
      const target = this.resolveTarget(entry.path);
      if (!("error" in target) && (owned.has(target.path) || !lstatOrNull(target.path))) {
        intended.add(target.path);
      }
    }
    if (intended.size > owned.size) writeManifest(this.opts.stateDir, { files: [...intended] });

    for (const entry of reply.files) {
      const target = this.resolveTarget(entry.path);
      if ("error" in target) {
        // The mapping is still there: a file this worker made stays until the mapping goes away.
        const nominal = this.nominalPath(entry.path);
        if (nominal && owned.has(nominal)) keep.add(nominal);
        report.refused.push({ path: entry.path, reason: target.error });
        continue;
      }
      try {
        const existing = lstatOrNull(target.path);
        if (existing && !owned.has(target.path)) {
          report.refused.push({
            path: entry.path,
            reason: "the file exists and Band did not create it",
          });
          continue;
        }
        if (existing && !existing.isFile()) {
          report.refused.push({ path: entry.path, reason: "the path is not a regular file" });
          continue;
        }
        // The hub caps the mode at 0700; the worker holds the same line.
        const mode = entry.mode & 0o700;
        const content = Buffer.from(entry.data, "base64");
        if (!(existing && sameFile(target.path, content, mode))) {
          writeAtomic(target.path, content, mode, this.realHome());
        }
        keep.add(target.path);
        report.written.push(entry.path);
      } catch (err) {
        if (owned.has(target.path)) keep.add(target.path);
        report.refused.push({
          path: entry.path,
          reason: err instanceof Error ? err.message.slice(0, 200) : "could not write the file",
        });
      }
    }

    // Mappings that went away: delete what this worker created.
    for (const file of owned) {
      if (keep.has(file)) continue;
      if (!this.insideHome(file)) continue;
      removeIfRegular(file);
    }
    writeManifest(this.opts.stateDir, { files: [...keep] });
    try {
      await this.opts.session.request(METHOD_SECRETS_REPORT, report, { timeoutMs: HUB_ANSWER_MS });
    } catch {
      // The hub shows the report when it can; the files are already in place.
    }
  }

  private realHome(): string {
    return realpathSync(this.home);
  }

  /** Whether a file's parent directory resolves to a place inside home. */
  private insideHome(file: string): boolean {
    try {
      const home = this.realHome();
      const real = realpathSync(dirname(file));
      return real === home || real.startsWith(home + sep);
    } catch {
      return false;
    }
  }

  /** The path a `~/x` mapping names, without checking the disk. */
  private nominalPath(mapped: string): string | null {
    if (!mapped.startsWith("~/")) return null;
    try {
      return join(this.realHome(), mapped.slice(2));
    } catch {
      return null;
    }
  }

  /** The absolute path of a `~/x` mapping, or why it is refused. */
  private resolveTarget(mapped: string): { path: string } | { error: string } {
    if (!mapped.startsWith("~/")) return { error: "the path is not under ~/" };
    const rel = mapped.slice(2);
    if (rel.split("/").some((part) => part === ".." || part === "")) {
      return { error: "the path is not under ~/" };
    }
    let home: string;
    try {
      home = realpathSync(this.home);
    } catch {
      return { error: "the home directory does not exist" };
    }
    const path = join(home, rel);
    // The deepest existing parent must resolve to a place inside home: a symlinked directory
    // that points elsewhere would carry the write out of it.
    let probe = dirname(path);
    while (!lstatOrNull(probe)) probe = dirname(probe);
    let real: string;
    try {
      real = realpathSync(probe);
    } catch {
      return { error: "a parent directory cannot be resolved" };
    }
    if (real !== home && !real.startsWith(home + sep)) {
      return { error: "a parent directory is a symlink out of the home directory" };
    }
    return { path };
  }
}

function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function removeIfRegular(file: string): boolean {
  const stat = lstatOrNull(file);
  if (!stat?.isFile()) return false;
  rmSync(file, { force: true });
  return true;
}

function sameFile(path: string, content: Buffer, mode: number): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && (stat.mode & 0o777) === mode && readFileSync(path).equals(content);
  } catch {
    return false;
  }
}

function writeAtomic(path: string, content: Buffer, mode: number, home: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // The parents may have changed since the check: they must still resolve inside home.
  const realDir = realpathSync(dir);
  if (realDir !== home && !realDir.startsWith(home + sep)) {
    throw new Error("a parent directory is a symlink out of the home directory");
  }
  const tmp = join(dir, `.band-secret-${randomBytes(6).toString("hex")}`);
  const fd = openSync(tmp, "wx", mode);
  try {
    // The mode is set before the content goes in, whatever the umask took off.
    chmodSync(tmp, mode);
    writeSync(fd, content);
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw err;
  }
  closeSync(fd);
  try {
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

function readManifest(stateDir: string): Manifest {
  try {
    const parsed = JSON.parse(readFileSync(join(stateDir, MANIFEST), "utf8")) as Partial<Manifest>;
    return {
      files: Array.isArray(parsed.files) ? parsed.files.filter((f) => typeof f === "string") : [],
    };
  } catch {
    return { files: [] };
  }
}

function writeManifest(stateDir: string, manifest: Manifest): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const tmp = join(stateDir, `${MANIFEST}.tmp`);
  writeFileSync(tmp, JSON.stringify(manifest), { mode: 0o600 });
  renameSync(tmp, join(stateDir, MANIFEST));
}
