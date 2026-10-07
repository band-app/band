/**
 * Placement and environment of a task with several member repos (plan step T.4, section 14).
 *
 * A task runs on one host, so the host must satisfy every member's labels and the project's
 * policy. A task on a runner-started worker gets one environment: the project's
 * `.band/environment.json` when its context repo has one, else the primary member's environment
 * with the other members' `install` steps listed to run in their own worktrees. Pure functions
 * only, so the rules are testable without a hub.
 */

import type { Environment } from "@band-app/environment";

export interface MemberLabels {
  repo: string;
  /** Host labels this member needs, `{ zone: "home" }` for `zone=home`. */
  labels?: Record<string, string>;
}

export interface LabelMerge {
  labels: Record<string, string>;
  /** Pairs that ask for different values of one key, such as `zone=a` (repo x) and `zone=b` (repo y). */
  conflicts: string[];
}

/**
 * Intersects the project's labels, the call's labels and each member's labels into one set a
 * host must carry. A key asked for twice with different values has no host, so it is reported in
 * `conflicts` with the member that asked.
 */
export function mergeTaskLabels(base: Record<string, string>, members: MemberLabels[]): LabelMerge {
  const labels: Record<string, string> = { ...base };
  const origin = new Map<string, string>(
    Object.keys(base).map((k) => [k, "the project or request"]),
  );
  const conflicts: string[] = [];
  for (const m of members) {
    for (const [k, v] of Object.entries(m.labels ?? {})) {
      const have = labels[k];
      if (have !== undefined && have !== v) {
        conflicts.push(
          `${k}=${v} (repo ${m.repo}) conflicts with ${k}=${have} (${origin.get(k) ?? "another repo"})`,
        );
        continue;
      }
      labels[k] = v;
      if (!origin.has(k)) origin.set(k, `repo ${m.repo}`);
    }
  }
  return { labels, conflicts };
}

/**
 * Which members ask for a label that none of `offered` carries, for the refusal message.
 * `offered` is the labels of one host or runner as `k=v`.
 */
export function unmetLabels(
  base: Record<string, string>,
  members: MemberLabels[],
  offered: string[],
): string[] {
  const have = new Set(offered);
  const out: string[] = [];
  for (const [k, v] of Object.entries(base)) {
    if (!have.has(`${k}=${v}`)) out.push(`${k}=${v} (project or request)`);
  }
  for (const m of members) {
    for (const [k, v] of Object.entries(m.labels ?? {})) {
      if (!have.has(`${k}=${v}`)) out.push(`${k}=${v} (repo ${m.repo})`);
    }
  }
  return out;
}

export interface MemberEnvironment {
  repo: string;
  role: string | null;
  mergeOrder: number;
  /** The repo's `.band/environment.json`, or null when it has none. */
  environment: Environment | null;
}

/** The primary member: role "primary", else the lowest merge order. */
export function primaryOf<T extends { role: string | null; mergeOrder: number }>(
  members: T[],
): T | undefined {
  return (
    members.find((m) => m.role === "primary") ??
    [...members].sort((a, b) => a.mergeOrder - b.mergeOrder)[0]
  );
}

export interface CombinedEnvironment {
  /** What the runner hook gets as `BAND_ENVIRONMENT`. It passes the schema of `environment.json`. */
  environment: Environment;
  /** `project` when the context repo's file decided, `primary` otherwise. */
  source: "project" | "primary";
  /** The repo whose image the machine uses, when the primary decided. Null for the project file. */
  primary: string | null;
  /** Install steps to run in each member's own worktree, in merge order. */
  installs: Array<{ repo: string; install: string }>;
}

/** Joins two `requires` ranges so that both hold: equal ranges stay one, others become `a b`. */
function joinRange(a: string | undefined, b: string): string {
  if (a === undefined || a.trim() === b.trim()) return b;
  return `${a} ${b}`;
}

/**
 * The one environment of a multi-member task. `projectEnvironment` is the parsed
 * `.band/environment.json` of the project's context repo. Without it the primary member's
 * environment is the base (its image, `install`, `requires`) and every other member's `requires`
 * is added to it, so the machine meets all of them. Every member's `install` goes in `installs`,
 * which the member's worktree setup runs in that worktree.
 */
export function combineEnvironments(
  members: MemberEnvironment[],
  projectEnvironment: Environment | null,
): CombinedEnvironment {
  const ordered = [...members].sort((a, b) => a.mergeOrder - b.mergeOrder);
  const installs = ordered.flatMap((m) =>
    m.environment?.install ? [{ repo: m.repo, install: m.environment.install }] : [],
  );
  if (projectEnvironment) {
    return { environment: projectEnvironment, source: "project", primary: null, installs };
  }
  const primary = primaryOf(ordered);
  const base: Environment = { ...(primary?.environment ?? {}) };
  const requires: Record<string, string> = { ...(base.requires ?? {}) };
  for (const m of ordered) {
    if (m === primary) continue;
    for (const [tool, range] of Object.entries(m.environment?.requires ?? {})) {
      requires[tool] = joinRange(requires[tool], range);
    }
  }
  if (Object.keys(requires).length > 0) base.requires = requires;
  const cpu = Math.max(0, ...ordered.map((m) => m.environment?.resources?.cpu ?? 0));
  if (cpu > 0 && base.resources) base.resources = { ...base.resources, cpu };
  // A member's `services` and `secrets` are not merged yet, they stay with the primary.
  return { environment: base, source: "primary", primary: primary?.repo ?? null, installs };
}
