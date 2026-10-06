import { tmpdir } from "node:os";
import { execGh, execGhWithInput } from "@band-app/host-local/git/git-client";
import { createLogger } from "@band-app/logger";
import {
  aggregateChecks,
  CHECK_RUNS_PER_PAGE,
  type CheckRun,
  type CheckTrigger,
  ensureWebhookSecret,
  GITHUB_HOOK_EVENTS,
  githubCiKey,
  parseCheckRuns,
  parseGithubDelivery,
  readWebhookSecret,
  verifyGithubSignature,
} from "../infra/subscriptions/github";
import { withHubGhCredential } from "./_utils/hub-gh-auth";
import { isBandPushed } from "./pushed-sha-service";
import { type Subscription, subscriptionService } from "./subscription-service";
import { tunnelService } from "./tunnel-service";

const log = createLogger("github-webhook");

const MAX_SEEN_DELIVERIES = 2000;
/** A commit with more than this many checks pages no further. */
const MAX_CHECK_PAGES = 10;

export type GithubDeliveryResult = "accepted" | "unauthorized";

/**
 * The public URL GitHub can reach this hub on: `BAND_PUBLIC_URL` when set,
 * else the running tunnel's origin. The tunnel URL carries the hub's auth
 * token in its query string, so only the origin is used.
 */
export function publicHubUrl(): string | undefined {
  const configured = process.env.BAND_PUBLIC_URL?.trim();
  const raw = configured || tunnelService.getStatus().url;
  if (!raw) return undefined;
  try {
    return new URL(raw).origin;
  } catch {
    return undefined;
  }
}

/** `gh api` runs outside any checkout, so its working directory doesn't matter. */
function ghApi(args: string[]): Promise<string> {
  return withHubGhCredential((env) => execGh(["api", ...args], tmpdir(), env));
}

/** `gh api` with a JSON body on stdin, so the body stays out of argv. */
function ghApiJson(endpoint: string, body: unknown): Promise<string> {
  return withHubGhCredential((env) =>
    execGhWithInput(["api", endpoint, "--input", "-"], tmpdir(), JSON.stringify(body), env),
  );
}

const seenDeliveries = new Set<string>();
const registering = new Map<string, Promise<void>>();
const checking = new Map<string, Promise<void>>();

function markSeen(delivery: string): boolean {
  if (seenDeliveries.has(delivery)) return false;
  seenDeliveries.add(delivery);
  if (seenDeliveries.size > MAX_SEEN_DELIVERIES) {
    const oldest = seenDeliveries.values().next().value;
    if (oldest !== undefined) seenDeliveries.delete(oldest);
  }
  return true;
}

/**
 * The GitHub source (plan step S.3): verifies and normalises webhook
 * deliveries, aggregates CI per commit, and registers the repo webhook
 * when the first subscription for a repo is created.
 */
export class GithubWebhookService {
  /**
   * Verifies the signature against the raw body, then handles the delivery.
   * Returns `unauthorized` for a missing or wrong signature (or no secret
   * configured yet) without parsing anything. CI work continues after
   * this returns, so GitHub gets its answer without waiting for `gh`.
   */
  handleDelivery(
    headers: Record<string, string | string[] | undefined>,
    body: Buffer,
  ): GithubDeliveryResult {
    const header = (name: string) => {
      const v = headers[name];
      return (Array.isArray(v) ? v[0] : v)?.trim();
    };
    const secret = readWebhookSecret();
    if (!secret || !verifyGithubSignature(secret, body, header("x-hub-signature-256"))) {
      return "unauthorized";
    }
    const eventType = header("x-github-event") ?? "";
    const delivery = header("x-github-delivery");
    if (!delivery || !markSeen(delivery)) return "accepted";

    let payload: unknown;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      return "accepted";
    }
    const parsed = parseGithubDelivery(eventType, delivery, payload);
    if (parsed.type === "events") {
      for (const event of parsed.events) {
        try {
          // A push (or PR update) that put a commit Band pushed on the branch
          // is the agent's own doing; it must not wake the agent again.
          subscriptionService.ingest(
            event.sha && isBandPushed(event.sha) ? { ...event, self: true } : event,
          );
        } catch (err) {
          log.error({ err, eventType, delivery }, "could not ingest github event");
        }
      }
    } else if (parsed.type === "check") {
      void this.aggregate(parsed.trigger).catch((err) => {
        // Let GitHub's redelivery of this id run again.
        seenDeliveries.delete(delivery);
        log.error({ err, eventType, delivery, repo: parsed.trigger.repo }, "ci aggregation failed");
      });
    }
    return "accepted";
  }

  /**
   * Fetches every check on the commit and ingests one CI event when none
   * is pending. A pending check holds the result until its own completion
   * delivery comes in. Skips the fetch when nobody listens to the branch.
   */
  async aggregate(trigger: CheckTrigger): Promise<void> {
    if (!subscriptionService.hasSubscribers(githubCiKey(trigger.repo, trigger.branch))) return;
    const flight = `${trigger.repo}@${trigger.sha}`;
    // Completions of one commit often arrive together; one fetch covers them.
    // A completion that lands during a fetch triggers a second one afterwards.
    const running = checking.get(flight);
    if (running) {
      await running;
    }
    const run = this.fetchAndIngest(trigger).finally(() => {
      if (checking.get(flight) === run) checking.delete(flight);
    });
    checking.set(flight, run);
    await run;
  }

  private async fetchAndIngest(trigger: CheckTrigger): Promise<void> {
    // A page that is full may have a next one; a short page is the last.
    const checks: CheckRun[] = [];
    for (let page = 1; page <= MAX_CHECK_PAGES; page++) {
      const output = await ghApi([
        `repos/${trigger.repo}/commits/${trigger.sha}/check-runs?per_page=${CHECK_RUNS_PER_PAGE}&page=${page}`,
      ]);
      const runs = parseCheckRuns(output);
      checks.push(...runs);
      if (runs.length < CHECK_RUNS_PER_PAGE) break;
    }
    const event = aggregateChecks(checks, trigger, Date.now(), isBandPushed(trigger.sha));
    if (event) subscriptionService.ingest(event);
  }

  /**
   * Who may wake a PR subscription with a comment or review when the caller
   * names nobody: the repo owner and the authenticated gh user. The `gh`
   * lookup is best effort; without it only the owner is allowed.
   */
  async defaultSenders(repo: string): Promise<string[]> {
    const senders = [repo.split("/")[0]];
    try {
      const login = (JSON.parse(await ghApi(["user"])) as { login?: unknown }).login;
      if (typeof login === "string" && login) senders.push(login);
    } catch (err) {
      log.warn({ err }, "could not look up the authenticated gh user");
    }
    return senders;
  }

  /**
   * Makes sure the repo has a webhook for this subscription. Another
   * subscription of the repo that already registered one covers it. With
   * no public URL the subscription records `waiting-for-url` (the polling
   * fallback of step S.5 serves it meanwhile). Failures are recorded, not thrown.
   */
  async ensureRegistered(sub: Subscription): Promise<void> {
    const repo = sub.config.repo;
    if (sub.source !== "github" || !repo) return;
    // Chain behind the repo's previous registration, so each caller sees the
    // result of the one before it when it checks whether the repo is covered.
    const previous = registering.get(repo) ?? Promise.resolve();
    const run = previous
      .then(() => this.register(sub.id, repo))
      .finally(() => {
        if (registering.get(repo) === run) registering.delete(repo);
      });
    registering.set(repo, run);
    await run;
  }

  private async register(subscriptionId: string, repo: string): Promise<void> {
    const set = (status: "registered" | "waiting-for-url" | "failed", error?: string) => {
      const current = subscriptionService.listGithub(repo).find((s) => s.id === subscriptionId);
      if (current) {
        subscriptionService.setConfig(subscriptionId, {
          ...current.config,
          webhook: { status, ...(error && { error }) },
        });
      }
    };
    const covered = subscriptionService
      .listGithub(repo)
      .some((s) => s.id !== subscriptionId && s.config.webhook?.status === "registered");
    if (covered) return set("registered");
    const base = publicHubUrl();
    if (!base) return set("waiting-for-url");
    let secret = "";
    try {
      secret = ensureWebhookSecret();
      // The body goes over stdin: argv would show the secret in `ps`.
      await ghApiJson(`repos/${repo}/hooks`, {
        name: "web",
        active: true,
        config: { url: `${base}/api/hooks/github`, content_type: "json", secret },
        events: [...GITHUB_HOOK_EVENTS],
      });
      set("registered");
    } catch (err) {
      // `execGh` rejects with gh's stderr, or with the execFile error (which
      // repeats the command line) when stderr is empty. Redact the secret
      // before the text is stored or matched.
      const raw = err instanceof Error ? err.message : "gh api failed";
      const full = secret ? raw.split(secret).join("***") : raw;
      const message = full.split("\n")[0].trim() || "gh api failed";
      const alreadyThere = /already exists/i.test(full);
      log.warn({ repo, alreadyThere }, "could not register github webhook");
      set(alreadyThere ? "registered" : "failed", alreadyThere ? undefined : message.slice(0, 200));
    }
  }
}

export const githubWebhookService = new GithubWebhookService();
