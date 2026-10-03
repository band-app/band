import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { bandHome } from "../db/queries/settings";
import type { SubscriptionEvent } from "./event";

/** Events the repo webhook is registered for. */
export const GITHUB_HOOK_EVENTS = [
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "issue_comment",
  "check_suite",
  "check_run",
  "workflow_run",
  "push",
] as const;

const SNIPPET_LIMIT = 200;

export const githubPrKey = (repo: string, number: number) => `github:pr:${repo}#${number}`;
export const githubCiKey = (repo: string, branch: string) => `github:ci:${repo}@${branch}`;

/** Path of the secret GitHub signs deliveries with, when `BAND_GITHUB_WEBHOOK_SECRET` is unset. */
function secretPath(): string {
  return join(bandHome(), "github-webhook-secret");
}

/** The configured secret, or undefined when no webhook was ever registered. Never creates one. */
export function readWebhookSecret(): string | undefined {
  const fromEnv = process.env.BAND_GITHUB_WEBHOOK_SECRET;
  if (fromEnv) return fromEnv;
  try {
    const value = readFileSync(secretPath(), "utf8").trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

/** The configured secret; generates and stores one (mode 0600) on first use. */
export function ensureWebhookSecret(): string {
  const existing = readWebhookSecret();
  if (existing) return existing;
  const path = secretPath();
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  const secret = randomBytes(32).toString("hex");
  writeFileSync(path, `${secret}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return secret;
}

/** Constant-time check of an `X-Hub-Signature-256` header (`sha256=<hex>`) against the raw body. */
export function verifyGithubSignature(
  secret: string,
  body: Buffer,
  header: string | undefined,
): boolean {
  const match = header?.match(/^sha256=([0-9a-f]{64})$/i);
  if (!match) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(match[1], "hex"));
}

type Json = Record<string, unknown>;

function obj(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function snippet(text: unknown): string {
  const flat = str(text).replace(/\s+/g, " ").trim();
  return flat.length > SNIPPET_LIMIT ? `${flat.slice(0, SNIPPET_LIMIT)}...` : flat;
}

/** What a completed check payload says about the commit to look at. */
export interface CheckTrigger {
  repo: string;
  branch: string;
  sha: string;
}

export type GithubParse =
  | { type: "events"; events: SubscriptionEvent[] }
  | { type: "check"; trigger: CheckTrigger }
  | { type: "ignored" };

const PR_ACTIONS = new Set([
  "opened",
  "closed",
  "reopened",
  "synchronize",
  "ready_for_review",
  "converted_to_draft",
]);

/**
 * Maps one GitHub delivery to events or, for a completed check, to the
 * commit whose checks must be fetched. `delivery` is `X-GitHub-Delivery`,
 * so a redelivery produces the same event id. Raw payload text never
 * leaves this function except as short snippets in event summaries.
 */
export function parseGithubDelivery(
  eventType: string,
  delivery: string,
  payload: unknown,
  now = Date.now(),
): GithubParse {
  const body = obj(payload);
  const repo = str(obj(body?.repository)?.full_name).toLowerCase();
  if (!body || !repo) return { type: "ignored" };
  const actor = str(obj(body.sender)?.login) || "unknown";
  const action = str(body.action);
  const event = (key: string, kind: string, url: string, summary: string): GithubParse => ({
    type: "events",
    events: [{ id: delivery, source: "github", kind, key, url, actor, summary, at: now }],
  });

  switch (eventType) {
    case "pull_request": {
      const pr = obj(body.pull_request);
      const number = Number(pr?.number);
      if (!pr || !Number.isInteger(number) || !PR_ACTIONS.has(action)) return { type: "ignored" };
      const merged = action === "closed" && pr.merged === true;
      const verb = merged ? "merged" : action.replaceAll("_", " ");
      const title = snippet(pr.title);
      return event(
        githubPrKey(repo, number),
        "pull_request",
        str(pr.html_url),
        `${actor} ${verb} ${repo}#${number}${title ? `: ${title}` : ""}`,
      );
    }
    case "pull_request_review": {
      const pr = obj(body.pull_request);
      const review = obj(body.review);
      const number = Number(pr?.number);
      if (!pr || !review || !Number.isInteger(number) || action !== "submitted") {
        return { type: "ignored" };
      }
      const state = str(review.state).toLowerCase().replaceAll("_", " ");
      const text = snippet(review.body);
      return event(
        githubPrKey(repo, number),
        "review",
        str(review.html_url) || str(pr.html_url),
        `${actor} reviewed ${repo}#${number} (${state || "commented"})${text ? `: ${text}` : ""}`,
      );
    }
    case "pull_request_review_comment": {
      const pr = obj(body.pull_request);
      const comment = obj(body.comment);
      const number = Number(pr?.number);
      if (!pr || !comment || !Number.isInteger(number) || action !== "created") {
        return { type: "ignored" };
      }
      const path = snippet(comment.path);
      return event(
        githubPrKey(repo, number),
        "review_comment",
        str(comment.html_url) || str(pr.html_url),
        `${actor} commented on ${path || "a file"} in ${repo}#${number}: ${snippet(comment.body)}`,
      );
    }
    case "issue_comment": {
      const issue = obj(body.issue);
      const comment = obj(body.comment);
      const number = Number(issue?.number);
      // Plain issues also send issue_comment; only a PR's comments are ours.
      if (!issue?.pull_request || !comment || !Number.isInteger(number) || action !== "created") {
        return { type: "ignored" };
      }
      return event(
        githubPrKey(repo, number),
        "comment",
        str(comment.html_url) || str(issue.html_url),
        `${actor} commented on ${repo}#${number}: ${snippet(comment.body)}`,
      );
    }
    case "push": {
      const ref = str(body.ref);
      const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : "";
      const sha = str(body.after);
      if (!branch || body.deleted === true || /^0+$/.test(sha)) return { type: "ignored" };
      return event(
        githubCiKey(repo, branch),
        "push",
        str(body.compare) || `https://github.com/${repo}/tree/${branch}`,
        `${actor} pushed ${sha.slice(0, 7)} to ${repo}@${branch}`,
      );
    }
    case "check_run":
    case "check_suite":
    case "workflow_run": {
      if (action !== "completed") return { type: "ignored" };
      const run = obj(body[eventType]);
      const suite = obj(run?.check_suite);
      const branch = str(run?.head_branch) || str(suite?.head_branch);
      const sha = str(run?.head_sha) || str(suite?.head_sha);
      if (!branch || !/^[0-9a-f]{7,64}$/i.test(sha)) return { type: "ignored" };
      return { type: "check", trigger: { repo, branch, sha } };
    }
    default:
      return { type: "ignored" };
  }
}

/** One check on a commit, as the check-runs REST endpoint reports it. */
export interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  url?: string;
  /** The commit the check ran on. */
  headSha?: string;
}

const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "action_required", "startup_failure"]);

/** How many check runs one page of the check-runs endpoint holds, and the most it returns. */
export const CHECK_RUNS_PER_PAGE = 100;

/**
 * Cursor's CI semantics: nothing while any check is still running (the
 * caller waits for the next completion), then one verdict for the commit.
 */
export function aggregateChecks(
  checks: CheckRun[],
  trigger: CheckTrigger,
  now = Date.now(),
): SubscriptionEvent | undefined {
  if (checks.length === 0 || checks.some((c) => c.status !== "completed")) return undefined;
  const failed = checks.filter((c) => c.conclusion && FAILED_CONCLUSIONS.has(c.conclusion));
  const cancelled = checks.filter((c) => c.conclusion === "cancelled");
  const short = trigger.sha.slice(0, 7);
  const where = `${short} (${trigger.repo}@${trigger.branch})`;
  const names = (list: CheckRun[]) => list.map((c) => c.name).join(", ");
  // A failure outranks a cancellation: the commit needs a fix, not a re-run.
  let state: "failure" | "cancelled" | "success";
  let summary: string;
  let culprit: CheckRun | undefined;
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
    source: "github",
    kind: "ci",
    key: githubCiKey(trigger.repo, trigger.branch),
    url: culprit?.url || `https://github.com/${trigger.repo}/commit/${trigger.sha}`,
    actor: "github-checks",
    summary,
    at: now,
  };
}

/** Parses the check-runs REST response; throws on an unexpected shape. */
export function parseCheckRuns(output: string): CheckRun[] {
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
