import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { SubscriptionEvent } from "./event";

/** Headers a sender may use for its own delivery id, first match wins. */
const DELIVERY_ID_HEADERS = [
  "x-request-id",
  "x-delivery-id",
  "x-github-delivery",
  "idempotency-key",
];
const SUMMARY_FROM_BODY_LIMIT = 500;

export function newWebhookToken(): string {
  return `bwh_${randomBytes(24).toString("base64url")}`;
}

export function hashWebhookToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time check of a presented token against the stored hash. */
export function webhookTokenMatches(token: string, secretHash: string | undefined): boolean {
  const presented = Buffer.from(hashWebhookToken(token), "hex");
  const stored = Buffer.from(secretHash ?? "", "hex");
  // Hashes are always 32 bytes, so this compares equal lengths unless the
  // stored hash is missing or damaged, which never matches.
  if (stored.length !== presented.length) return false;
  return timingSafeEqual(presented, stored);
}

/** Reads the token from `X-Band-Webhook-Token` or `Authorization: Bearer`. */
export function tokenFromHeaders(headers: Record<string, string | string[] | undefined>): string {
  const direct = headers["x-band-webhook-token"];
  const value = Array.isArray(direct) ? direct[0] : direct;
  if (value) return value;
  const auth = headers.authorization;
  const bearer = Array.isArray(auth) ? auth[0] : auth;
  const match = bearer?.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? "";
}

function firstHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  return first?.trim() ? first.trim() : undefined;
}

/**
 * Maps a webhook request to an event. The id is the sender's delivery id
 * header when there is one, otherwise a hash of the body, so a redelivery
 * of the same body is dropped. The summary is the body's `summary` string
 * when it is JSON with one, otherwise the body cut to 500 characters.
 */
export function normalizeWebhook(
  subscriptionId: string,
  headers: Record<string, string | string[] | undefined>,
  body: string,
  now = Date.now(),
): SubscriptionEvent {
  let id: string | undefined;
  for (const name of DELIVERY_ID_HEADERS) {
    id = firstHeader(headers, name);
    if (id) break;
  }
  id ??= createHash("sha256").update(body).digest("hex");

  let summary = "";
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && "summary" in parsed) {
      const candidate = (parsed as { summary: unknown }).summary;
      if (typeof candidate === "string") summary = candidate;
    }
  } catch {
    // Not JSON: fall back to the raw text below.
  }
  if (!summary) {
    const flat = body.trim();
    summary =
      flat.length > SUMMARY_FROM_BODY_LIMIT ? `${flat.slice(0, SUMMARY_FROM_BODY_LIMIT)}...` : flat;
  }
  if (!summary) summary = "Webhook received with an empty body";

  return {
    id,
    source: "webhook",
    kind: "webhook",
    key: `hook:${subscriptionId}`,
    url: "",
    actor: "webhook",
    summary,
    at: now,
  };
}
