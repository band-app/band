import type { ChecksProvider, ReviewProvider } from "./providers";

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
  providers: {
    registerReviewProvider(provider: ReviewProvider): void;
    registerChecksProvider(provider: ChecksProvider): void;
  };
}

export interface ServerPlugin {
  activate(api: BandServerApi): void | Promise<void>;
}

/** The default export of a plugin's server module. */
export function definePlugin(plugin: ServerPlugin): ServerPlugin {
  return plugin;
}
