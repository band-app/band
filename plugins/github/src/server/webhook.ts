import { createHmac, timingSafeEqual } from "node:crypto";
import type { SourceEvent } from "@band-app/plugin-api";
import type { CheckTrigger } from "./check-runs";
import { ciKey, obj, prKey, snippet, str } from "./json";

/** Events the repo webhook is registered for. */
export const HOOK_EVENTS = [
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "issue_comment",
  "check_suite",
  "check_run",
  "workflow_run",
  "push",
] as const;

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

export type WebhookParse =
  | { type: "events"; events: SourceEvent[] }
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
): WebhookParse {
  const body = obj(payload);
  const repo = str(obj(body?.repository)?.full_name).toLowerCase();
  if (!body || !repo) return { type: "ignored" };
  const actor = str(obj(body.sender)?.login) || "unknown";
  const action = str(body.action);
  const event = (
    key: string,
    kind: string,
    url: string,
    summary: string,
    sha?: string,
  ): WebhookParse => ({
    type: "events",
    events: [{ id: delivery, kind, key, url, actor, summary, at: now, sha }],
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
        prKey(repo, number),
        "pull_request",
        str(pr.html_url),
        `${actor} ${verb} ${repo}#${number}${title ? `: ${title}` : ""}`,
        // A synchronize is a push to the PR's branch, so its head is the pushed commit.
        action === "synchronize" ? str(obj(pr.head)?.sha) || undefined : undefined,
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
        prKey(repo, number),
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
        prKey(repo, number),
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
        prKey(repo, number),
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
        ciKey(repo, branch),
        "push",
        str(body.compare) || `https://github.com/${repo}/tree/${branch}`,
        `${actor} pushed ${sha.slice(0, 7)} to ${repo}@${branch}`,
        sha,
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

/** The pull request or branch a delivery is about, for telling open Checks panels to refetch. */
export interface ReviewTarget {
  /** `owner/name`, lowercased. */
  repo: string;
  branch?: string;
  number?: number;
}

const REVIEW_EVENTS = new Set([
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "issue_comment",
  "check_run",
  "check_suite",
  "workflow_run",
]);

/**
 * The review a delivery touched. Unlike `parseGithubDelivery` it ignores which actions Band
 * wakes agents for: any change to a pull request or its checks refreshes a panel. An
 * `issue_comment` names no branch, so it reaches every worktree of the repo.
 */
export function reviewTargetOf(eventType: string, payload: unknown): ReviewTarget | null {
  if (!REVIEW_EVENTS.has(eventType)) return null;
  const body = obj(payload);
  const repo = str(obj(body?.repository)?.full_name).toLowerCase();
  if (!body || !repo) return null;
  const target = (branch: string, number: unknown): ReviewTarget => {
    const n = Number(number);
    return {
      repo,
      ...(branch && { branch }),
      ...(Number.isInteger(n) && n > 0 && { number: n }),
    };
  };
  switch (eventType) {
    case "pull_request":
    case "pull_request_review":
    case "pull_request_review_comment": {
      const pr = obj(body.pull_request);
      return pr ? target(str(obj(pr.head)?.ref), pr.number) : null;
    }
    case "issue_comment": {
      const issue = obj(body.issue);
      return issue?.pull_request ? target("", issue.number) : null;
    }
    default: {
      const run = obj(body[eventType]);
      const suite = obj(run?.check_suite);
      const branch = str(run?.head_branch) || str(suite?.head_branch);
      return branch ? target(branch, undefined) : { repo };
    }
  }
}
