/**
 * Isolation levels (plan step 3.6, research Appendix B). A worktree asks for a
 * level in `placement.environment.isolation`, a runner offers one in its
 * `isolation` setting.
 *
 * - `worktree`: a git worktree on a shared worker. The default.
 * - `container`: a worker of its own for that worktree, in a container.
 * - `vm`: a worker of its own in a virtual machine. No bundled runner offers it yet.
 *
 * A stronger level satisfies a weaker request, so a `vm` runner can take a
 * `container` request, but never the other way round.
 */

export const ISOLATION_LEVELS = ["worktree", "container", "vm"] as const;
export type IsolationLevel = (typeof ISOLATION_LEVELS)[number];

/** The runner setting also accepts `process`, the name the first runners used for `worktree`. */
export const RUNNER_ISOLATIONS = ["process", ...ISOLATION_LEVELS] as const;

/** Label the hub puts on a host it started for an exclusive (`container` or `vm`) worktree. */
export const ISOLATION_LABEL_KEY = "band.isolation";

const RANK: Record<IsolationLevel, number> = { worktree: 0, container: 1, vm: 2 };

export function isIsolationLevel(value: unknown): value is IsolationLevel {
  return typeof value === "string" && (ISOLATION_LEVELS as readonly string[]).includes(value);
}

/** The level a runner setting stands for. `process` and anything unknown mean `worktree`. */
export function runnerLevel(setting: string | undefined): IsolationLevel {
  return isIsolationLevel(setting) ? setting : "worktree";
}

/** The level a request asks for, from its placement environment. `worktree` when it names none. */
export function requestedIsolation(environment: Record<string, unknown> | null): IsolationLevel {
  const value = environment?.isolation;
  return isIsolationLevel(value) ? value : "worktree";
}

/** Whether a runner offering `offered` may take a request that asks for `wanted`. */
export function offers(offered: IsolationLevel, wanted: IsolationLevel): boolean {
  return RANK[offered] >= RANK[wanted];
}

/** A host started for one worktree carries `band.isolation=<level>`; nothing else may be placed on it. */
export function isExclusiveHost(labels: string[]): boolean {
  return labels.some(
    (l) => l === `${ISOLATION_LABEL_KEY}=container` || l === `${ISOLATION_LABEL_KEY}=vm`,
  );
}
