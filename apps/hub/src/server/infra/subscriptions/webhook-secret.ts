import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { bandHome } from "../db/queries/settings";

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
