import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import type { AccountUsage, UsageWindow } from "@band-app/host-api";
import { failure, fetchJson, ok, percentOf, resetOf, titleCase, UsageHttpError } from "./common";

const DEFAULT_URL = "https://api.anthropic.com/api/oauth/usage";
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const KEYCHAIN_TIMEOUT_MS = 3_000;

interface ClaudeWindowInput {
  utilization?: unknown;
  used_percentage?: unknown;
  resets_at?: unknown;
}

interface ClaudeScopedLimit {
  kind?: string;
  percent?: unknown;
  resets_at?: unknown;
  scope?: { model?: { display_name?: string } | null } | null;
}

interface ClaudeUsageResponse {
  five_hour?: ClaudeWindowInput | null;
  seven_day?: ClaudeWindowInput | null;
  fable_weekly?: ClaudeWindowInput | null;
  fable_seven_day?: ClaudeWindowInput | null;
  seven_day_fable?: ClaudeWindowInput | null;
  limits?: ClaudeScopedLimit[] | null;
}

function windowOf(label: string, raw: ClaudeWindowInput | null | undefined): UsageWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const percent = percentOf(raw.utilization ?? raw.used_percentage);
  if (percent === null) return null;
  return { label, percent, resetsAt: resetOf(raw.resets_at) };
}

/**
 * Maps the OAuth usage response. The Fable weekly window has had several
 * spellings: a `limits[]` entry of kind `weekly_scoped` for the Fable model,
 * or one of three top-level keys.
 */
export function mapClaudeUsage(data: ClaudeUsageResponse): UsageWindow[] {
  const scoped = Array.isArray(data.limits)
    ? data.limits.find(
        (limit) =>
          limit?.kind === "weekly_scoped" &&
          percentOf(limit.percent) !== null &&
          limit.scope?.model?.display_name?.trim().toLowerCase() === "fable",
      )
    : undefined;
  const fable =
    windowOf(
      "Fable",
      scoped ? { used_percentage: scoped.percent, resets_at: scoped.resets_at } : null,
    ) ??
    windowOf("Fable", data.fable_weekly) ??
    windowOf("Fable", data.fable_seven_day) ??
    windowOf("Fable", data.seven_day_fable);
  return [windowOf("5h", data.five_hour), windowOf("wk", data.seven_day), fable].filter(
    (w): w is UsageWindow => w !== null,
  );
}

interface ClaudeLogin {
  token: string;
  plan: string | null;
}

function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

function parseCredentials(raw: string): ClaudeLogin | null {
  try {
    const oauth = (JSON.parse(raw) as { claudeAiOauth?: Record<string, unknown> }).claudeAiOauth;
    const token = oauth?.accessToken;
    if (typeof token !== "string" || token.trim() === "") return null;
    const sub = oauth?.subscriptionType;
    return { token, plan: typeof sub === "string" && sub ? titleCase(sub) : null };
  } catch {
    return null;
  }
}

function keychainPassword(service: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "security",
      ["find-generic-password", "-s", service, "-a", userInfo().username, "-w"],
      { timeout: KEYCHAIN_TIMEOUT_MS },
      (err, stdout) => resolve(err ? null : stdout.trim() || null),
    );
  });
}

/** Claude Code stores its login in a file, and on macOS in the Keychain. The file wins because reading it never prompts. */
async function readLogin(): Promise<ClaudeLogin | null> {
  const dir = claudeConfigDir();
  try {
    const fromFile = parseCredentials(await readFile(join(dir, ".credentials.json"), "utf8"));
    if (fromFile) return fromFile;
  } catch {
    // No file: fall through to the Keychain.
  }
  if (process.platform !== "darwin" || process.env.BAND_USAGE_KEYCHAIN === "off") return null;
  // Claude Code suffixes the service with a hash of CLAUDE_CONFIG_DIR when it is set.
  const service = process.env.CLAUDE_CONFIG_DIR
    ? `${KEYCHAIN_SERVICE}-${createHash("sha256").update(dir).digest("hex").slice(0, 8)}`
    : KEYCHAIN_SERVICE;
  const raw = await keychainPassword(service);
  return raw ? parseCredentials(raw) : null;
}

async function readIdentity(): Promise<string | null> {
  const file = process.env.CLAUDE_CONFIG_DIR
    ? join(process.env.CLAUDE_CONFIG_DIR, ".claude.json")
    : join(homedir(), ".claude.json");
  try {
    const account = (
      JSON.parse(await readFile(file, "utf8")) as { oauthAccount?: Record<string, unknown> }
    ).oauthAccount;
    const email = account?.emailAddress;
    if (typeof email === "string" && email) return email;
    const id = account?.accountUuid;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

export async function readClaudeUsage(): Promise<AccountUsage> {
  const login = await readLogin();
  if (!login) return failure("claude", "not-logged-in", null);
  const account = await readIdentity();
  try {
    const data = await fetchJson<ClaudeUsageResponse>(
      process.env.BAND_CLAUDE_USAGE_URL || DEFAULT_URL,
      {
        Authorization: `Bearer ${login.token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "claude-code/2.1.0",
      },
    );
    const windows = mapClaudeUsage(data);
    // An answer with no recognisable window means the shape changed.
    if (windows.length === 0) return failure("claude", "error", account);
    return ok("claude", account, login.plan, windows);
  } catch (err) {
    return failure("claude", err instanceof UsageHttpError ? err.failure : "error", account);
  }
}
