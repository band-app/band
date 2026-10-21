/**
 * One-line provisioning of new hosts.
 *
 * An admin creates a command, `curl -fsSL <hub>/api/provision/<code>/script | sh`. The script
 * holds no secret. It trades the one-time code at the exchange for a worker bootstrap token and a
 * run token, downloads the provisioning repo's bundle (when settings name one) with the run
 * token, and uploads its output as it goes.
 *
 * - The code and the run token are stored as SHA-256 hashes. The bootstrap token is the one
 *   `TokenService.issueWorkerBootstrap` makes and is returned once, in the exchange answer.
 * - The code is spent by a guarded SQL update, so of two exchanges only one wins.
 * - The provisioning repo is fetched when the command is created, with the vault's git
 *   credential, and pinned to the commit it resolves. The bundle is that commit's files as a
 *   tarball under `<BAND_HOME>/provisioning/<id>/`.
 * - Logs are scrubbed of tokens before they are stored.
 *
 * This service reads and writes hub state files and runs `git` and `tar` on the hub's own
 * machine, so it is on the exempt list of the machine-access Biome override (`biome.json`).
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "@band-app/logger";
import { TRPCError } from "@trpc/server";
import { ProvisionQueries, type ProvisionRow } from "../infra/db/queries/provisions";
import { bandHome } from "../infra/db/queries/settings";
import { hostRegistry } from "../infra/host/registry";
import { parseRemoteUrl } from "./_utils/git-token-source";
import { HUB_VERSION, HUB_VERSION_UNRELEASED } from "./_utils/hub-version";
import { renderProvisionScript } from "./_utils/provision-script";
import { settingsService } from "./settings-service";
import { tokenService } from "./token-service";
import { vaultService } from "./vault-service";

const log = createLogger("provisioning");

export const DEFAULT_PROVISION_TTL_MS = 60 * 60 * 1000;
export const DEFAULT_START_COMMAND = "band/provision.sh";
const MAX_LOG_BYTES = 256 * 1024;
const MAX_CHUNK_BYTES = 64 * 1024;
const KEEP_BUNDLES_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_PROVISION_TIMEOUT_MS = 30 * 60 * 1000;
const LIST_LIMIT = 20;
const TIMEOUT_EXIT_CODE = 124;

/** `BAND_PROVISION_TIMEOUT_MS` replaces the 30 minutes a run may take to say hello, read on every check. */
function provisionTimeoutMs(): number {
  const ms = Number(process.env.BAND_PROVISION_TIMEOUT_MS);
  return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_PROVISION_TIMEOUT_MS;
}

/** `BAND_PROVISION_TTL_MS` replaces the one-hour life of a command, read on every command. */
function provisionTtlMs(): number {
  const ms = Number(process.env.BAND_PROVISION_TTL_MS);
  return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_PROVISION_TTL_MS;
}

/** Any Band token, so a start command that prints its environment leaks nothing. */
const TOKEN_PATTERN = /\b(?:bwb|bws|bdt|brt|bwd|bpc|bpr|bdp|mcp)_[A-Za-z0-9_-]{6,}/g;

/** Why the exchange refused. Callers show one message for all of them. */
export class ProvisionExchangeError extends Error {
  constructor(readonly reason: "invalid" | "expired" | "used") {
    super(`provision exchange refused: ${reason}`);
    this.name = "ProvisionExchangeError";
  }
}

export class ProvisionAuthError extends Error {
  constructor() {
    super("provision run token refused");
    this.name = "ProvisionAuthError";
  }
}

export type ProvisionStatus = "waiting" | "provisioning" | "online" | "failed" | "expired";

export interface ProvisionView {
  id: string;
  status: ProvisionStatus;
  hostId: string | null;
  hostName: string;
  expiresAt: number;
  createdAt: number;
  commitSha: string | null;
  repoUrl: string | null;
  exitCode: number | null;
  log: string;
}

export interface ProvisionSettings {
  repoUrl: string;
  branch: string;
  command: string;
}

export interface CreatedCommand {
  id: string;
  /** The one line to paste. */
  command: string;
  /** The same line inside a `#cloud-config` document. */
  cloudInit: string;
  expiresAt: number;
  hostName: string;
  commitSha: string | null;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function newSecret(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h);
}

/** The hub URL a script uses: https, or http on loopback, without credentials, path or query. */
export function checkHubUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new TRPCError({ code: "BAD_REQUEST", message: "The hub URL is not a valid URL." });
  }
  const ok =
    (url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHost(url.hostname))) &&
    !url.username &&
    !url.password;
  if (!ok) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "The hub URL must be https (http is accepted only for loopback) and carry no credentials.",
    });
  }
  return url.origin;
}

/** A start command is a relative path inside the repo. */
export function checkStartCommand(command: string): string {
  const ok =
    /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(command) &&
    !command.split("/").some((part) => part === ".." || part === "") &&
    command.length <= 200;
  if (!ok) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "The start command must be a relative path inside the repo, such as band/provision.sh.",
    });
  }
  return command;
}

export class ProvisioningService {
  constructor(private readonly queries = new ProvisionQueries()) {}

  private now(): number {
    return Date.now();
  }

  private dir(id: string): string {
    return join(bandHome(), "provisioning", id);
  }

  settings(): ProvisionSettings {
    const s: { repoUrl?: string; branch?: string; command?: string } =
      settingsService.get().provisioning ?? {};
    return {
      repoUrl: s.repoUrl ?? "",
      branch: s.branch ?? "",
      command: s.command ?? DEFAULT_START_COMMAND,
    };
  }

  updateSettings(patch: Partial<ProvisionSettings>): ProvisionSettings {
    const next = { ...this.settings(), ...patch };
    if (next.command) checkStartCommand(next.command);
    if (next.repoUrl) checkRepoUrl(next.repoUrl);
    settingsService.update({ provisioning: next });
    return this.settings();
  }

  /**
   * Creates a code and the command that uses it. With a provisioning repo configured it
   * fetches the repo now, so a bad URL or credential fails here and the commit is pinned.
   */
  async create(input: {
    hubUrl: string;
    hostName?: string;
    labels?: string[];
  }): Promise<CreatedCommand> {
    const hubUrl = checkHubUrl(input.hubUrl);
    const settings = this.settings();
    if (settings.command) checkStartCommand(settings.command);
    if (settings.repoUrl) checkRepoUrl(settings.repoUrl);
    const id = randomUUID();
    const code = newSecret("bpc_");
    const at = this.now();
    const hostName = input.hostName?.trim() || `worker-${id.slice(0, 6)}`;
    let commitSha: string | null = null;
    if (settings.repoUrl) {
      commitSha = await this.buildBundle(id, settings);
    }
    this.sweep(at);
    this.queries.insert({
      id,
      codeHash: sha256(code),
      runHash: null,
      hubUrl,
      hostName,
      labels: input.labels ?? [],
      repoUrl: settings.repoUrl ? stripCredentials(settings.repoUrl) : null,
      branch: settings.repoUrl ? settings.branch || null : null,
      command: settings.repoUrl ? settings.command || DEFAULT_START_COMMAND : null,
      commitSha,
      hostId: null,
      state: "pending",
      exitCode: null,
      log: "",
      createdAt: at,
      expiresAt: at + provisionTtlMs(),
      spentAt: null,
      updatedAt: at,
    });
    log.info(
      `created provisioning command ${id}${commitSha ? ` at ${commitSha.slice(0, 12)}` : ""}`,
    );
    const command = `curl -fsSL ${hubUrl}/api/provision/${code}/script | sh`;
    return {
      id,
      command,
      cloudInit: cloudInitFor(command),
      expiresAt: at + provisionTtlMs(),
      hostName,
      commitSha,
    };
  }

  /** The script for a code. It reveals nothing and spends nothing, so a link preview is harmless. */
  script(code: string): string | null {
    const row = this.queries.findByCodeHash(sha256(code));
    if (!row) return null;
    return renderProvisionScript({
      hubUrl: row.hubUrl,
      code,
      workerVersion: HUB_VERSION_UNRELEASED ? "" : HUB_VERSION,
    });
  }

  /**
   * Spends a code. Creates the host row and its bootstrap token and returns them with a run token
   * for the bundle and the log, once. The answer is `key=value` lines because the script has no
   * JSON parser.
   */
  exchange(code: string): string {
    const row = this.queries.findByCodeHash(sha256(code));
    if (!row) throw new ProvisionExchangeError("invalid");
    const at = this.now();
    if (row.spentAt != null) throw new ProvisionExchangeError("used");
    if (row.expiresAt <= at) throw new ProvisionExchangeError("expired");
    const runToken = newSecret("bpr_");
    const boot = tokenService.issueWorkerBootstrap(row.hostName, row.labels);
    if (!this.queries.spend(row.id, at, boot.hostId, sha256(runToken))) {
      tokenService.removeHost(boot.hostId);
      throw new ProvisionExchangeError("used");
    }
    log.info(`exchanged provisioning code ${row.id} for host ${boot.hostId}`);
    const lines = [
      `token=${boot.token}`,
      `workerId=${boot.hostId}`,
      `runToken=${runToken}`,
      `bundle=${row.repoUrl ? 1 : 0}`,
      `command=${safeValue(row.command ?? "")}`,
      `name=${safeValue(row.hostName)}`,
      `labels=${safeValue(row.labels.join(","))}`,
    ];
    return `${lines.join("\n")}\n`;
  }

  /** Checks the run token the script sends after the exchange. */
  private authorize(code: string, runToken: string | undefined): ProvisionRow {
    const row = this.queries.findByCodeHash(sha256(code));
    if (!row || !row.runHash || !runToken || sha256(runToken) !== row.runHash) {
      throw new ProvisionAuthError();
    }
    // A finished run has nothing left to download or write.
    if (row.state === "done" || row.state === "failed") throw new ProvisionAuthError();
    return row;
  }

  /** The bundle file and size for a code, once its run token is shown. */
  bundle(
    code: string,
    runToken: string | undefined,
  ): { stream: NodeJS.ReadableStream; size: number } {
    const row = this.authorize(code, runToken);
    const file = join(this.dir(row.id), "bundle.tgz");
    if (!row.repoUrl || !existsSync(file)) throw new ProvisionAuthError();
    return { stream: createReadStream(file), size: statSync(file).size };
  }

  /** Appends script output, tokens removed. `exit` closes the run: non-zero is failed. */
  appendLog(code: string, runToken: string | undefined, text: string, exit?: number): void {
    const row = this.authorize(code, runToken);
    const at = this.now();
    const secrets = [code, runToken ?? ""].filter(Boolean);
    const clean = scrub(text.slice(-MAX_CHUNK_BYTES), secrets);
    let next = row.log + clean;
    if (next.length > MAX_LOG_BYTES) next = next.slice(next.length - MAX_LOG_BYTES);
    if (exit === undefined) {
      this.queries.setLog(row.id, next, at);
      return;
    }
    this.queries.finish(row.id, exit === 0 ? "done" : "failed", exit, next, at);
    if (exit !== 0) log.info(`provisioning ${row.id} failed with exit code ${exit}`);
  }

  status(id: string): ProvisionView | null {
    const row = this.queries.findById(id);
    return row ? this.view(row) : null;
  }

  list(): ProvisionView[] {
    return this.queries.list(LIST_LIMIT).map((row) => this.view(row));
  }

  /**
   * Fails a run whose worker has not said hello within the timeout after the exchange, whether
   * the script is still running or exited 0. The log stays, with a last line saying why.
   */
  private settle(row: ProvisionRow): ProvisionRow {
    if (row.spentAt == null || row.state === "failed" || row.hostId == null) return row;
    const at = this.now();
    if (at - row.spentAt <= provisionTimeoutMs()) return row;
    const seen = tokenService.hostSeen(row.hostId);
    if (!seen || seen.status === "online" || seen.lastSeenAt != null) return row;
    const minutes = Math.max(1, Math.round(provisionTimeoutMs() / 60_000));
    const note = `\nband provision: the worker did not say hello within ${minutes} min. Marked failed.\n`;
    const exitCode = row.exitCode ?? TIMEOUT_EXIT_CODE;
    this.queries.finish(row.id, "failed", exitCode, row.log + note, at);
    log.info(`provisioning ${row.id} timed out waiting for host ${row.hostId}`);
    return { ...row, state: "failed", exitCode, log: row.log + note };
  }

  private view(spent: ProvisionRow): ProvisionView {
    const row = this.settle(spent);
    const at = this.now();
    let status: ProvisionStatus;
    const hostOnline = row.hostId != null && tokenService.hostStatus(row.hostId) === "online";
    if (row.state === "failed") status = "failed";
    else if (hostOnline) status = "online";
    else if (row.spentAt != null) status = "provisioning";
    else if (row.expiresAt <= at) status = "expired";
    else status = "waiting";
    return {
      id: row.id,
      status,
      hostId: row.hostId,
      hostName: row.hostName,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
      commitSha: row.commitSha,
      repoUrl: row.repoUrl,
      exitCode: row.exitCode,
      log: row.log,
    };
  }

  /** Deletes the bundle files of commands older than a day. */
  private sweep(at: number): void {
    for (const id of this.queries.idsCreatedBefore(at - KEEP_BUNDLES_MS)) {
      const dir = this.dir(id);
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Clones the provisioning repo at its branch, pins the commit and packs the files. */
  private async buildBundle(id: string, settings: ProvisionSettings): Promise<string> {
    const dir = this.dir(id);
    mkdirSync(dir, { recursive: true });
    const src = join(dir, "src");
    const host = hostRegistry.local;
    const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };
    const key = parseRemoteUrl(settings.repoUrl);
    if (key) {
      const cred = vaultService.findGitCredential({ host: key.host, path: key.path, repo: null });
      if (cred) {
        const basic = Buffer.from(`${cred.username}:${cred.password}`).toString("base64");
        env.GIT_CONFIG_COUNT = "2";
        env.GIT_CONFIG_KEY_0 = "http.extraHeader";
        env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${basic}`;
        // The credential is for the host the admin named, so a redirect must not carry it away.
        env.GIT_CONFIG_KEY_1 = "http.followRedirects";
        env.GIT_CONFIG_VALUE_1 = "false";
      }
    }
    try {
      const args = ["clone", "--quiet", "--depth", "1"];
      if (settings.branch) args.push("--branch", settings.branch);
      args.push("--", settings.repoUrl, src);
      await host.exec("git", args, { env, timeoutMs: 120_000 });
      const sha = (await host.exec("git", ["-C", src, "rev-parse", "HEAD"], { env })).stdout.trim();
      const command = settings.command || DEFAULT_START_COMMAND;
      if (!existsSync(join(src, command))) {
        throw new Error(`the repo at ${sha.slice(0, 12)} has no ${command}`);
      }
      await host.exec("tar", ["-czf", join(dir, "bundle.tgz"), "--exclude=.git", "-C", src, "."], {
        timeoutMs: 120_000,
      });
      rmSync(src, { recursive: true, force: true });
      return sha;
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      const secrets = env.GIT_CONFIG_VALUE_0 ? [env.GIT_CONFIG_VALUE_0] : [];
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `Could not fetch the provisioning repo: ${scrub((err as Error).message, secrets).slice(0, 400)}`,
      });
    }
  }
}

/** Refuses a repo URL that would put a secret on a command line or send one in cleartext. */
function checkRepoUrl(url: string): void {
  if (/\s/.test(url)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "The repo URL must not contain spaces." });
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return; // An scp-like remote or a path.
  }
  if (parsed.username || parsed.password) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "The repo URL must not hold a username or password. Add a git credential to the vault.",
    });
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol === "http:" && !loopback) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "The repo URL must use https." });
  }
}

/** Removes userinfo from a web URL before it is stored or shown. */
function stripCredentials(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
      return parsed.toString();
    }
  } catch {
    // Not a URL (an scp-like remote or a path). Stored as given.
  }
  return url;
}

/** A value the script reads with `read` from a `key=value` line: no line breaks, shell-safe. */
function safeValue(value: string): string {
  return /^[A-Za-z0-9 _.,:=@/+-]*$/.test(value) ? value : "";
}

function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s.length >= 4) out = out.split(s).join("[redacted]");
  return out.replace(TOKEN_PATTERN, "[redacted]");
}

export function cloudInitFor(command: string): string {
  return `#cloud-config\nruncmd:\n  - [sh, -c, ${JSON.stringify(command)}]\n`;
}

export const provisioningService = new ProvisioningService();
