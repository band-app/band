/**
 * One coding agent running as an ACP agent subprocess (issue #648).
 *
 * The agent speaks the Agent Client Protocol as newline-delimited JSON-RPC
 * over stdio. Band is the client: it advertises no `fs` and no `terminal`
 * capability, so agents read and write files and run commands with their
 * own tools, under their own permission rules, and only ask Band when those
 * rules say to ask a person. Routing agent commands into Band terminals is
 * #649.
 *
 * Modelled on Folio's `src/main/agent.ts`. The process runs detached, in
 * its own process group, so `close()` also stops what the agent started
 * (Codex runs a separate app-server).
 */

import { type ChildProcess, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { createLogger } from "@band-app/logger";
import type { AcpLaunch } from "./acp-launch";

const log = createLogger("acp-agent");

/** How long an agent gets to answer `initialize`, `session/new` and the like. */
const STARTUP_TIMEOUT_MS = 60_000;
/** `session/load` streams the whole history before answering. */
const LOAD_TIMEOUT_MS = 180_000;

const CLIENT_CAPABILITIES: acp.ClientCapabilities = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
  // Claude Code's AskUserQuestion arrives as a form elicitation, and is
  // disabled when the client can't render one.
  elicitation: { form: {} },
  session: { notices: {} },
};

export type PermissionOutcome = acp.RequestPermissionResponse["outcome"];

export interface AcpAgentHandlers {
  /** Every `session/update`, for any session on this process. */
  onUpdate(notification: acp.SessionNotification): void;
  /** `session/request_permission`. `signal` aborts when the agent cancels
   *  the request or the connection closes. */
  onPermission(
    request: acp.RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<PermissionOutcome>;
  /** `elicitation/create`. Only form mode is advertised. */
  onElicitation(
    request: acp.CreateElicitationRequest,
    signal: AbortSignal,
  ): Promise<acp.CreateElicitationResponse>;
  /** The process exited, on its own or through `close()`. */
  onExit(code: number | null, stderr: string): void;
}

/** Legacy model state some agents return from `session/new` (Gemini CLI). */
export interface SessionModelState {
  currentModelId: string;
  availableModels: { modelId: string; name: string; description?: string | null }[];
}

/** What `session/new`, `session/load` and `session/resume` answer with. */
export interface AttachedSession {
  sessionId: string;
  configOptions: acp.SessionConfigOption[];
  modes: acp.SessionModeState | null;
  models: SessionModelState | null;
}

/** The last few KB of stderr, which is where an agent explains a crash. */
function stderrTail() {
  let buf = "";
  return {
    push: (d: Buffer) => {
      buf = (buf + d.toString()).slice(-4000);
    },
    text: () => buf,
  };
}

function withTimeout<T>(work: Promise<T>, what: string, ms = STARTUP_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<T>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${what} did not answer within ${Math.round(ms / 1000)}s`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

function toAttached(
  sessionId: string,
  res: {
    configOptions?: acp.SessionConfigOption[] | null;
    modes?: acp.SessionModeState | null;
  },
): AttachedSession {
  const models = (res as { models?: SessionModelState | null }).models ?? null;
  return {
    sessionId,
    configOptions: res.configOptions ?? [],
    modes: res.modes ?? null,
    models: models?.availableModels?.length ? models : null,
  };
}

export class AcpAgentProcess {
  private closed = false;

  private constructor(
    private readonly child: ChildProcess,
    private readonly connection: acp.ClientConnection,
    private readonly label: string,
    readonly init: acp.InitializeResponse,
    private readonly stderr: { text: () => string },
  ) {}

  /**
   * Spawns the agent in `cwd` and runs `initialize`. Throws with the
   * agent's stderr attached when it fails to start or answer.
   */
  static async start(
    launch: AcpLaunch,
    cwd: string,
    label: string,
    handlers: AcpAgentHandlers,
  ): Promise<AcpAgentProcess> {
    const stderr = stderrTail();
    const child = spawn(launch.command, launch.args, {
      cwd,
      env: { ...process.env, ...launch.env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    child.stderr?.on("data", stderr.push);

    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
    } catch (err) {
      throw new Error(`Could not start ${label}: ${(err as Error).message}`);
    }

    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    );
    const connection = acp
      .client({ name: "band" })
      .onNotification(acp.methods.client.session.update, (ctx) => {
        handlers.onUpdate(ctx.params);
      })
      .onRequest(acp.methods.client.session.requestPermission, async (ctx) => ({
        outcome: await handlers.onPermission(ctx.params, ctx.signal),
      }))
      .onRequest(acp.methods.client.elicitation.create, (ctx) =>
        handlers.onElicitation(ctx.params, ctx.signal),
      )
      .connect(stream);

    child.once("exit", (code) => {
      connection.close();
      handlers.onExit(code, stderr.text());
    });

    try {
      const init = await withTimeout(
        connection.agent.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: CLIENT_CAPABILITIES,
          clientInfo: { name: "band", version: "0.1.0" },
        }),
        label,
      );
      log.info(
        { label, agent: init.agentInfo?.name, version: init.agentInfo?.version, pid: child.pid },
        "agent initialized",
      );
      return new AcpAgentProcess(child, connection, label, init, stderr);
    } catch (err) {
      killTree(child);
      throw withStderr(label, err, stderr.text());
    }
  }

  get alive(): boolean {
    return !this.closed && this.child.exitCode === null && this.child.signalCode === null;
  }

  get agentName(): string {
    return this.init.agentInfo?.title ?? this.init.agentInfo?.name ?? this.label;
  }

  get canLoad(): boolean {
    return this.init.agentCapabilities?.loadSession === true;
  }

  get canResume(): boolean {
    return this.init.agentCapabilities?.sessionCapabilities?.resume != null;
  }

  get canList(): boolean {
    return this.init.agentCapabilities?.sessionCapabilities?.list != null;
  }

  get supportsAdditionalDirectories(): boolean {
    return this.init.agentCapabilities?.sessionCapabilities?.additionalDirectories != null;
  }

  get promptCapabilities(): acp.PromptCapabilities {
    return this.init.agentCapabilities?.promptCapabilities ?? {};
  }

  async newSession(cwd: string, additionalDirectories?: string[]): Promise<AttachedSession> {
    const res = await this.guard(
      withTimeout(
        this.connection.agent.request(acp.methods.agent.session.new, {
          cwd,
          mcpServers: [],
          ...(additionalDirectories?.length && this.supportsAdditionalDirectories
            ? { additionalDirectories }
            : {}),
        }),
        this.label,
      ),
    );
    return toAttached(res.sessionId, res);
  }

  /** Replays the session's history as `session/update`s, then answers. */
  async loadSession(sessionId: string, cwd: string): Promise<AttachedSession> {
    const res = await this.guard(
      withTimeout(
        this.connection.agent.request(acp.methods.agent.session.load, {
          sessionId,
          cwd,
          mcpServers: [],
        }),
        this.label,
        LOAD_TIMEOUT_MS,
      ),
    );
    return toAttached(sessionId, res);
  }

  /** Reopens the session without replaying it. */
  async resumeSession(sessionId: string, cwd: string): Promise<AttachedSession> {
    const res = await this.guard(
      withTimeout(
        this.connection.agent.request(acp.methods.agent.session.resume, {
          sessionId,
          cwd,
          mcpServers: [],
        }),
        this.label,
      ),
    );
    return toAttached(sessionId, res);
  }

  /**
   * `session/list` for `cwd`, up to `limit` sessions. Codex pages by time
   * and filters by cwd per page, so a page can be empty with more to come;
   * the page cap bounds that walk.
   */
  async listSessions(cwd: string, limit = 200): Promise<acp.SessionInfo[]> {
    const sessions: acp.SessionInfo[] = [];
    let cursor: string | null | undefined;
    for (let page = 0; page < 10 && sessions.length < limit; page++) {
      const res = await this.guard(
        withTimeout(
          this.connection.agent.request(acp.methods.agent.session.list, { cwd, cursor }),
          this.label,
        ),
      );
      sessions.push(...res.sessions);
      cursor = res.nextCursor;
      if (!cursor) break;
    }
    return sessions;
  }

  /** Runs one prompt turn. Resolves when the agent stops, however it stops. */
  prompt(sessionId: string, prompt: acp.ContentBlock[]): Promise<acp.PromptResponse> {
    return this.guard(
      this.connection.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt }),
    );
  }

  /** Asks the agent to stop the current turn. The prompt call then resolves
   *  with `stopReason: "cancelled"`. */
  async cancel(sessionId: string): Promise<void> {
    await this.connection.agent
      .notify(acp.methods.agent.session.cancel, { sessionId })
      .catch(() => undefined);
  }

  /** Changes one session setting. The agent answers with the full option
   *  list, because one change can reshape others. */
  async setConfigOption(
    sessionId: string,
    configId: string,
    value: string | boolean,
  ): Promise<acp.SessionConfigOption[]> {
    const res = await this.guard(
      withTimeout(
        this.connection.agent.request(acp.methods.agent.session.setConfigOption, {
          sessionId,
          configId,
          value,
        } as acp.SetSessionConfigOptionRequest),
        this.label,
      ),
    );
    return res.configOptions;
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.guard(
      withTimeout(
        this.connection.agent.request(acp.methods.agent.session.setMode, { sessionId, modeId }),
        this.label,
      ),
    );
  }

  /** Unstable `session/set_model`, for agents that expose models without a
   *  `model` config option (Gemini CLI). */
  async setModel(sessionId: string, modelId: string): Promise<void> {
    await this.guard(
      withTimeout(
        this.connection.agent.request("session/set_model", { sessionId, modelId }),
        this.label,
      ),
    );
  }

  /** Kills the agent and everything it started. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.connection.close();
    killTree(this.child);
  }

  /** Adds the agent's stderr to a failed request, so the error says why. */
  private async guard<T>(work: Promise<T>): Promise<T> {
    try {
      return await work;
    } catch (err) {
      throw withStderr(this.label, err, this.alive ? "" : this.stderr.text());
    }
  }
}

function withStderr(label: string, err: unknown, stderr: string): Error {
  const message = err instanceof Error ? err.message : describe(err);
  const detail = stderr.trim();
  return new Error(`${label}: ${message}${detail ? `\n\n${detail}` : ""}`);
}

/** JSON-RPC errors arrive as plain `{ code, message, data }` objects. */
function describe(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const e = err as { message: unknown; data?: unknown };
    const data = e.data && typeof e.data === "object" ? JSON.stringify(e.data) : "";
    return `${String(e.message)}${data ? ` ${data}` : ""}`;
  }
  return String(err);
}

function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill("SIGTERM");
    else process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}
