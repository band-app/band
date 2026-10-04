import type { Host } from "./host";

/** Runs a command in `cwd` and returns stdout. Rejects with stderr on a non-zero exit. */
export type CommandRun = (args: string[], cwd: string) => Promise<string>;

/** `git ARGS` on the host, returning stdout like the git client's `execGit`. */
export function gitRunner(host: Host): CommandRun {
  return async (args, cwd) => (await host.git.exec(args, cwd)).stdout;
}

/** `gh ARGS` on the host, returning stdout like the git client's `execGh`. */
export function ghRunner(host: Host): CommandRun {
  return async (args, cwd) => (await host.git.gh(args, cwd)).stdout;
}
