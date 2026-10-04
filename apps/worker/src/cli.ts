import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { installSkills } from "@band-app/host-local/agents/skills-install";
import { type CliFetchReply, type LinkSession, METHOD_CLI_FETCH } from "@band-app/link";
import type { Logger } from "@band-app/logger";

/** How long the hub may take to start answering and to send the binary. */
const FETCH_TIMEOUT_MS = 120_000;

/** Largest CLI binary the worker accepts. The release build is about 10 MiB. */
const MAX_CLI_BYTES = 256 * 1024 * 1024;

/** The longest a spawn waits for a sync in flight before it starts without waiting for the CLI. */
const SPAWN_WAIT_MS = 10_000;

const exeName = process.platform === "win32" ? "band.exe" : "band";

/**
 * Keeps the hub's `band` CLI in `<stateDir>/bin` (plan step 2.8).
 *
 * On every connect the worker asks the hub for the binary built for this
 * platform and replaces its copy when the SHA-256 differs, so the CLI always
 * matches the hub's version. The agents and terminals the worker starts get
 * that directory first on their PATH. When the hub has no binary for this
 * platform the worker keeps any copy it has and runs without otherwise.
 */
export class CliCache {
  readonly binDir: string;
  private current: Promise<void> = Promise.resolve();

  constructor(
    private readonly session: LinkSession,
    stateDir: string,
    private readonly log: Logger,
  ) {
    this.binDir = join(stateDir, "bin");
  }

  /** Starts a sync after any sync still running. Never rejects. */
  sync(): Promise<void> {
    this.current = this.current.then(() => this.run()).catch(() => undefined);
    return this.current;
  }

  /** The directory to put on PATH, or null while no binary is cached. Waits briefly for a sync in flight. */
  async dir(): Promise<string | null> {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.current,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SPAWN_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
    return (await stat(this.path).catch(() => null)) ? this.binDir : null;
  }

  private get path(): string {
    return join(this.binDir, exeName);
  }

  private get shaPath(): string {
    return `${this.path}.sha256`;
  }

  private async run(): Promise<void> {
    try {
      const have = await this.cachedSha();
      const reply = await this.session.request<CliFetchReply>(
        METHOD_CLI_FETCH,
        { platform: process.platform, arch: process.arch, ...(have && { have }) },
        { timeoutMs: FETCH_TIMEOUT_MS },
      );
      if (!reply.available) {
        this.log.warn({ reason: reply.reason }, "the hub has no band CLI for this worker");
        return;
      }
      if (reply.chan !== undefined) await this.download(reply);
      // Not awaited: a spawn waits on this sync for the binary, not for the skills.
      void this.installSkills().catch((err) =>
        this.log.warn(
          { message: err instanceof Error ? err.message : String(err) },
          "could not install the band skills",
        ),
      );
    } catch (err) {
      this.log.warn(
        { message: err instanceof Error ? err.message : String(err) },
        "could not fetch the band CLI from the hub",
      );
    }
  }

  /** The SHA-256 of the cached binary, or undefined when none is usable. */
  private async cachedSha(): Promise<string | undefined> {
    try {
      const data = await readFile(this.path);
      const sha = createHash("sha256").update(data).digest("hex");
      // A copy edited since it was saved is not trusted, so it is fetched again.
      return (await readFile(this.shaPath, "utf8")).trim() === sha ? sha : undefined;
    } catch {
      return undefined;
    }
  }

  private async download(reply: Extract<CliFetchReply, { available: true }>): Promise<void> {
    const ch = this.session.getChannel(reply.chan as number);
    if (!ch) throw new Error("the hub's reply had no body channel");
    if (reply.size > MAX_CLI_BYTES) {
      ch.reset("too large");
      throw new Error(`the hub's band CLI is too large (${reply.size} bytes)`);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => ch.reset("timed out"), FETCH_TIMEOUT_MS);
    try {
      for await (const chunk of ch) {
        size += chunk.byteLength;
        if (size > MAX_CLI_BYTES) {
          ch.reset("too large");
          throw new Error("the band CLI is larger than the hub said");
        }
        chunks.push(Buffer.from(chunk));
      }
    } finally {
      clearTimeout(timer);
      // Ending the worker's side lets the channel close. An open one counts as activity
      // and would keep an ephemeral worker from ever going idle.
      ch.end();
    }
    const data = Buffer.concat(chunks);
    const sha = createHash("sha256").update(data).digest("hex");
    if (data.length !== reply.size || sha !== reply.sha256) {
      throw new Error("the band CLI arrived damaged");
    }
    await mkdir(this.binDir, { recursive: true, mode: 0o700 });
    // A rename keeps a running `band` from seeing a half-written file.
    const tmp = `${this.path}.${process.pid}.tmp`;
    try {
      await chmod(this.binDir, 0o700);
      await writeFile(tmp, data, { mode: 0o755 });
      await chmod(tmp, 0o755);
      await rename(tmp, this.path);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    await writeFile(this.shaPath, `${sha}\n`, { mode: 0o600 });
    this.log.info({ sha256: sha, bytes: data.length }, "saved the band CLI");
  }

  /** Writes the band skills for the agents on this machine. A no-op when they are current. */
  private async installSkills(): Promise<void> {
    const result = await installSkills({ bandPath: this.path });
    for (const warning of result.warnings) this.log.warn({ warning }, "band skills");
  }
}
