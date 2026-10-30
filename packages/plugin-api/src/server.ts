import type { z } from "zod";
import type {
  BranchStatusProvider,
  ChecksProvider,
  RepoInfo,
  ReviewProvider,
  SubscriptionSourceProvider,
} from "./providers";

export interface ExecOptions {
  cwd: string;
  timeoutMs?: number;
  /** Added to the server's environment for this call. */
  env?: Record<string, string>;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export interface PluginLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/**
 * The API a plugin's server module receives in `activate`, scoped to that
 * plugin. Every method is async and takes and returns plain JSON.
 */
export interface BandServerApi {
  pluginId: string;
  log: PluginLogger;
  /**
   * Run an external binary with the server's `PATH` (plus the Homebrew
   * directories). The child gets the server's whole environment plus
   * `options.env`, because CLIs like `gh` read their auth, host and proxy
   * settings from it. Scrubbing it is part of moving plugins out of process.
   * Rejects with the binary's stderr when it exits non-zero.
   */
  exec(bin: string, args: string[], options: ExecOptions): Promise<ExecResult>;
  workers: {
    /**
     * Calls `method` on this plugin's worker service on `hostId`, JSON in and out. `scope` names
     * the worktree the service files its state under. Rejects when the worker is offline or has
     * no such service.
     */
    call(hostId: string, method: string, params: unknown, scope: WorkerScope): Promise<unknown>;
  };
  tools: {
    /** Adds a tool to the `band` MCP server of every chat. */
    register(tool: PluginTool): void;
  };
  providers: {
    registerReviewProvider(provider: ReviewProvider): void;
    registerChecksProvider(provider: ChecksProvider): void;
    registerBranchStatusProvider(provider: BranchStatusProvider): void;
    registerSubscriptionSourceProvider(provider: SubscriptionSourceProvider): void;
  };
  reviews: {
    /**
     * Tell the core a review on the forge changed (a comment, a finished check, a merge). The
     * core maps it to the worktrees on that repo and branch (every worktree of the repo when
     * `branch` is not given) and tells open Checks panels to refetch. Call it only for a change
     * the plugin learned from the forge itself, such as a verified webhook delivery.
     */
    changed(change: { repo: RepoInfo; branch?: string; number?: number }): void;
  };
}

/** A worktree on a worker: the key a worker service files its state under, and the folder. */
export interface WorkerScope {
  worktreeKey: string;
  worktreePath: string;
}

/** What a tool handler receives about the chat that called it. Nothing in the arguments can change it. */
export interface ToolContext {
  chatId: string;
  /** The caller's own worktree. */
  worktreeId: string;
  /** The worker the worktree lives on. */
  hostId: string;
  /**
   * Calls `method` on this plugin's worker service for the caller's worktree. Rejects with an
   * error naming the worker when it cannot run the service.
   */
  call(method: string, params?: unknown): Promise<unknown>;
}

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

/** An agent tool, added to the built-in `band` MCP server. */
export interface PluginTool {
  name: string;
  description: string;
  /** The arguments. A tool acts on the caller's worktree only, so it takes no worktree id. */
  inputSchema: z.ZodObject<z.ZodRawShape>;
  handler(args: never, ctx: ToolContext): Promise<ToolResult>;
}

export interface ServerPlugin {
  activate(api: BandServerApi): void | Promise<void>;
}

/** The default export of a plugin's server module. */
export function definePlugin(plugin: ServerPlugin): ServerPlugin {
  return plugin;
}
