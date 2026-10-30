import type { SourceEvent, SubscriptionContext } from "@band-app/plugin-api";
import { ciKey, obj, str } from "./json";

/** What a completed check payload says about the commit to look at. */
export interface CheckTrigger {
  repo: string;
  branch: string;
  sha: string;
}

/** One check on a commit, as the check-runs REST endpoint reports it. */
export interface CommitCheck {
  name: string;
  status: string;
  conclusion: string | null;
  url?: string;
  /** The commit the check ran on. */
  headSha?: string;
}

const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "action_required", "startup_failure"]);

/** How many check runs one page of the check-runs endpoint holds. */
export const CHECK_RUNS_PER_PAGE = 100;
/** A commit with more than this many checks pages no further (webhook path). */
const MAX_CHECK_PAGES = 10;

/**
 * Cursor's CI semantics: nothing while any check is still running (the
 * caller waits for the next completion), then one verdict for the commit.
 * `bandPushed` says whether Band pushed the commit; a failure on one it
 * didn't is marked `fix: false`, so the agent only reports it.
 */
export function aggregateChecks(
  checks: CommitCheck[],
  trigger: CheckTrigger,
  now = Date.now(),
  bandPushed = false,
): SourceEvent | undefined {
  if (checks.length === 0 || checks.some((c) => c.status !== "completed")) return undefined;
  const failed = checks.filter((c) => c.conclusion && FAILED_CONCLUSIONS.has(c.conclusion));
  const cancelled = checks.filter((c) => c.conclusion === "cancelled");
  const short = trigger.sha.slice(0, 7);
  const where = `${short} (${trigger.repo}@${trigger.branch})`;
  const names = (list: CommitCheck[]) => list.map((c) => c.name).join(", ");
  // A failure outranks a cancellation: the commit needs a fix, not a re-run.
  let state: "failure" | "cancelled" | "success";
  let summary: string;
  let culprit: CommitCheck | undefined;
  if (failed.length > 0) {
    state = "failure";
    culprit = failed[0];
    summary = `${failed.length} of ${checks.length} checks failed on ${where}: ${names(failed)}`;
  } else if (cancelled.length > 0) {
    state = "cancelled";
    culprit = cancelled[0];
    summary = `${cancelled.length} of ${checks.length} checks were cancelled on ${where}: ${names(cancelled)}`;
  } else {
    state = "success";
    summary = `All ${checks.length} checks passed on ${where}`;
  }
  return {
    id: `ci:${trigger.sha}:${state}`,
    kind: "ci",
    key: ciKey(trigger.repo, trigger.branch),
    url: culprit?.url || `https://github.com/${trigger.repo}/commit/${trigger.sha}`,
    actor: "github-checks",
    summary,
    at: now,
    ...(state === "failure" && { fix: bandPushed }),
  };
}

/** Parses the check-runs REST response; throws on an unexpected shape. */
export function parseCheckRuns(output: string): CommitCheck[] {
  const parsed = obj(JSON.parse(output));
  const runs = parsed?.check_runs;
  if (!Array.isArray(runs)) throw new Error("Unexpected check-runs response");
  return runs.flatMap((r) => {
    const run = obj(r);
    if (!run) return [];
    return [
      {
        name: str(run.name) || "unnamed check",
        status: str(run.status),
        conclusion: typeof run.conclusion === "string" ? run.conclusion : null,
        url: str(run.html_url) || undefined,
        headSha: str(run.head_sha) || undefined,
      },
    ];
  });
}

/**
 * Reads one page after another from a check-runs endpoint until a short page. A full page may
 * have a next one. `stopWhen` lets a poll quit when its `gh` budget runs out, because a partial
 * list could look complete.
 */
async function readChecks(
  endpoint: string,
  maxPages: number,
  ctx: SubscriptionContext,
  stopWhen: () => boolean,
): Promise<CommitCheck[] | null> {
  const checks: CommitCheck[] = [];
  for (let page = 1; page <= maxPages; page++) {
    if (page > 1 && stopWhen()) return null;
    const output = await ctx.gh([
      "api",
      `${endpoint}?per_page=${CHECK_RUNS_PER_PAGE}&page=${page}`,
    ]);
    const runs = parseCheckRuns(output);
    checks.push(...runs);
    if (runs.length < CHECK_RUNS_PER_PAGE) break;
  }
  return checks;
}

/** The checks of the commit a webhook named, folded into one verdict. */
export async function aggregateCommit(
  trigger: CheckTrigger,
  ctx: SubscriptionContext,
): Promise<SourceEvent | null> {
  const checks = await readChecks(
    `repos/${trigger.repo}/commits/${trigger.sha}/check-runs`,
    MAX_CHECK_PAGES,
    ctx,
    () => false,
  );
  return (
    (checks && aggregateChecks(checks, trigger, Date.now(), ctx.isBandPushed(trigger.sha))) || null
  );
}

/** The checks on a branch's head commit, as a poll reads them. Null while out of `gh` budget. */
export async function aggregateBranchHead(
  repo: string,
  branch: string,
  ctx: SubscriptionContext,
): Promise<SourceEvent | null> {
  const ref = branch.split("/").map(encodeURIComponent).join("/");
  const checks = await readChecks(
    `repos/${repo}/commits/${ref}/check-runs`,
    5,
    ctx,
    () => ctx.callsLeft() <= 0,
  );
  const sha = checks?.find((c) => c.headSha)?.headSha;
  if (!checks || !sha) return null;
  return aggregateChecks(checks, { repo, branch, sha }, Date.now(), ctx.isBandPushed(sha)) ?? null;
}
