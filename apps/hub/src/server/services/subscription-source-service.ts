import { tmpdir } from "node:os";
import { execGh, execGhWithInput } from "@band-app/host-local/git/git-client";
import { createLogger } from "@band-app/logger";
import type {
  DeliveryInput,
  SubscriptionContext,
  SubscriptionSourceProvider,
} from "@band-app/plugin-api";
import { ensureWebhookSecret, readWebhookSecret } from "../infra/subscriptions/webhook-secret";
import { requestCIRefresh } from "./_utils/ci-refresh-request";
import { withHubGhCredential } from "./_utils/hub-gh-auth";
import { pluginHost } from "./plugin-host-service";
import { isBandPushed } from "./pushed-sha-service";
import { type Subscription, subscriptionService } from "./subscription-service";
import { tunnelService } from "./tunnel-service";

const log = createLogger("subscription-source");

const MAX_SEEN_DELIVERIES = 2000;

/** The source whose webhook route is `POST /api/hooks/github`. */
const GITHUB = "github";

/** The plugin behind a subscription source is disabled or failed to load. */
export class SubscriptionSourceUnavailableError extends Error {
  constructor(source: string) {
    super(`The ${source} plugin is not available`);
    this.name = "SubscriptionSourceUnavailableError";
  }
}

export type DeliveryResult = "accepted" | "unauthorized" | "unavailable";

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

/**
 * What the core lends a source provider. `gh` runs outside any checkout, so its working
 * directory doesn't matter, and it uses the hub's own login or vault credential. The
 * `callsLeft` default has no budget; a poll passes its own counter.
 */
export function subscriptionContext(callsLeft: () => number = () => Infinity): SubscriptionContext {
  return {
    gh: (args) => withHubGhCredential((env) => execGh(args, tmpdir(), env)),
    ghWithInput: (args, input) =>
      withHubGhCredential((env) => execGhWithInput(args, tmpdir(), input, env)),
    isBandPushed,
    callsLeft,
  };
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

/** Header names lowercased, first value only, so a provider reads them without core types. */
function flattenHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (first !== undefined) flat[name.toLowerCase()] = first;
  }
  return flat;
}

/**
 * The core side of a forge subscription source (plan step S.3): holds the webhook secret,
 * drops repeated deliveries, hands events to `SubscriptionService.ingest` with the guards that
 * are not forge specific, and registers the repo webhook when the first subscription for a repo
 * is created. Everything that reads the forge (signature scheme, payloads, `gh` arguments) is in
 * the provider the plugin registers.
 */
export class SubscriptionSourceService {
  /**
   * Verifies the signature against the raw body, then handles the delivery.
   * Returns `unauthorized` for a missing or wrong signature (or no secret
   * configured yet) without parsing anything, and `unavailable` when the
   * source's plugin is disabled. CI work continues after this returns, so
   * GitHub gets its answer without waiting for `gh`.
   */
  async handleDelivery(
    headers: Record<string, string | string[] | undefined>,
    body: Buffer,
    source: string = GITHUB,
  ): Promise<DeliveryResult> {
    const provider = await pluginHost.subscriptionSourceFor(source);
    if (!provider) return "unavailable";
    const input: DeliveryInput = {
      headers: flattenHeaders(headers),
      bodyBase64: body.toString("base64"),
    };
    const secret = readWebhookSecret();
    const verdict = secret ? await provider.verifyDelivery({ ...input, secret }) : { ok: false };
    if (!verdict.ok) return "unauthorized";
    const delivery = "deliveryId" in verdict ? verdict.deliveryId : null;
    if (!delivery || !markSeen(delivery)) return "accepted";

    const parsed = await provider.parseDelivery(input);
    if (parsed.type === "events") {
      for (const event of parsed.events) {
        try {
          // A push (or PR update) that put a commit Band pushed on the branch
          // is the agent's own doing; it must not wake the agent again.
          subscriptionService.ingest({
            ...event,
            source,
            ...(event.sha && isBandPushed(event.sha) && { self: true }),
          });
        } catch (err) {
          log.error({ err, delivery }, "could not ingest source event");
        }
      }
    } else if (parsed.type === "check") {
      void this.aggregate(provider, parsed).catch((err) => {
        // Let the forge's redelivery of this id run again.
        seenDeliveries.delete(delivery);
        log.error({ err, delivery, flight: parsed.flight }, "ci aggregation failed");
      });
    }
    return "accepted";
  }

  /**
   * Asks the provider for the commit's verdict and ingests it when no check is pending. A
   * pending check holds the result until its own completion delivery comes in. Skips the fetch
   * when nobody listens to the branch.
   */
  private async aggregate(
    provider: SubscriptionSourceProvider,
    check: { key: string; flight: string; trigger: unknown },
  ): Promise<void> {
    if (!subscriptionService.hasSubscribers(check.key)) return;
    // Completions of one commit often arrive together; one fetch covers them.
    // A completion that lands during a fetch triggers a second one afterwards.
    const running = checking.get(check.flight);
    if (running) {
      await running;
    }
    const run = this.fetchAndIngest(provider, check.trigger).finally(() => {
      if (checking.get(check.flight) === run) checking.delete(check.flight);
    });
    checking.set(check.flight, run);
    await run;
  }

  private async fetchAndIngest(
    provider: SubscriptionSourceProvider,
    trigger: unknown,
  ): Promise<void> {
    const event = await provider.aggregateChecks(trigger, subscriptionContext());
    // The sidebar's CI state follows the next tick instead of waiting out its period.
    requestCIRefresh();
    if (event) subscriptionService.ingest({ ...event, source: provider.id });
  }

  /**
   * Who may wake a PR subscription with a comment or review when the caller
   * names nobody. The provider decides; for GitHub that is the repo owner and
   * the authenticated gh user (best effort).
   */
  async defaultSenders(repo: string, source: string = GITHUB): Promise<string[]> {
    const provider = await pluginHost.subscriptionSourceFor(source);
    if (!provider) throw new SubscriptionSourceUnavailableError(source);
    return provider.defaultSenders(repo, subscriptionContext());
  }

  /**
   * Makes sure the repo has a webhook for this subscription. Another
   * subscription of the repo that already registered one covers it. With
   * no public URL the subscription records `waiting-for-url` (the polling
   * fallback of step S.5 serves it meanwhile). Failures are recorded, not thrown.
   */
  async ensureRegistered(sub: Subscription): Promise<void> {
    const repo = sub.config.repo;
    if (sub.source !== GITHUB || !repo) return;
    // Chain behind the repo's previous registration, so each caller sees the
    // result of the one before it when it checks whether the repo is covered.
    const previous = registering.get(repo) ?? Promise.resolve();
    const run = previous
      .then(() => this.register(sub.id, repo, sub.source))
      .finally(() => {
        if (registering.get(repo) === run) registering.delete(repo);
      });
    registering.set(repo, run);
    await run;
  }

  private async register(subscriptionId: string, repo: string, source: string): Promise<void> {
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
    const provider = await pluginHost.subscriptionSourceFor(source);
    if (!provider) return set("failed", new SubscriptionSourceUnavailableError(source).message);
    const result = await Promise.resolve()
      .then(() =>
        provider.registerWebhook(
          { repo, url: `${base}/api/hooks/${source}`, secret: ensureWebhookSecret() },
          subscriptionContext(),
        ),
      )
      .catch((err) => ({
        status: "failed" as const,
        error: err instanceof Error ? err.message.split("\n")[0] : "webhook registration failed",
      }));
    if (result.status === "failed") log.warn({ repo }, "could not register webhook");
    set(result.status, result.error);
  }
}

export const subscriptionSourceService = new SubscriptionSourceService();
