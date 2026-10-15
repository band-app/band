import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AccountUsage, UsageWindow } from "@band-app/host-api";
import { failure, fetchJson, ok, percentOf, resetOf, titleCase, UsageHttpError } from "./common";

const DEFAULT_URL = "https://chatgpt.com/backend-api/wham/usage";

interface CodexWindowInput {
  used_percent?: unknown;
  limit_window_seconds?: unknown;
  reset_at?: unknown;
}

interface CodexUsageResponse {
  plan_type?: unknown;
  rate_limit?: {
    primary_window?: CodexWindowInput | null;
    secondary_window?: CodexWindowInput | null;
  } | null;
}

/** Five hours or less is the session window, anything near a week is the weekly one. */
function labelFor(raw: CodexWindowInput, fallback: string): string {
  const seconds = raw.limit_window_seconds;
  if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
    const minutes = seconds / 60;
    if (minutes <= 6 * 60) return "5h";
    if (minutes >= 6 * 24 * 60) return "wk";
  }
  return fallback;
}

function windowOf(raw: CodexWindowInput | null | undefined, fallback: string): UsageWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const percent = percentOf(raw.used_percent);
  if (percent === null) return null;
  return { label: labelFor(raw, fallback), percent, resetsAt: resetOf(raw.reset_at) };
}

export function mapCodexUsage(data: CodexUsageResponse): UsageWindow[] {
  return [
    windowOf(data.rate_limit?.primary_window, "5h"),
    windowOf(data.rate_limit?.secondary_window, "wk"),
  ].filter((w): w is UsageWindow => w !== null);
}

interface CodexLogin {
  token: string;
  accountId: string | null;
  email: string | null;
}

function emailOfIdToken(idToken: unknown): string | null {
  if (typeof idToken !== "string") return null;
  try {
    const payload = JSON.parse(
      Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as {
      email?: unknown;
    };
    return typeof payload.email === "string" && payload.email ? payload.email : null;
  } catch {
    return null;
  }
}

async function readLogin(): Promise<CodexLogin | null> {
  const home = process.env.CODEX_HOME || join(homedir(), ".codex");
  try {
    const auth = JSON.parse(await readFile(join(home, "auth.json"), "utf8")) as {
      tokens?: { access_token?: unknown; account_id?: unknown; id_token?: unknown };
    };
    const token = auth.tokens?.access_token;
    if (typeof token !== "string" || token === "") return null;
    const accountId = auth.tokens?.account_id;
    return {
      token,
      accountId: typeof accountId === "string" && accountId ? accountId : null,
      email: emailOfIdToken(auth.tokens?.id_token),
    };
  } catch {
    return null;
  }
}

export async function readCodexUsage(): Promise<AccountUsage> {
  const login = await readLogin();
  if (!login) return failure("codex", "not-logged-in", null);
  const account = login.email ?? login.accountId;
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${login.token}`,
      "User-Agent": "codex-cli",
      "OpenAI-Beta": "codex-1",
      originator: "Codex Desktop",
    };
    if (login.accountId) headers["ChatGPT-Account-Id"] = login.accountId;
    const data = await fetchJson<CodexUsageResponse>(
      process.env.BAND_CODEX_USAGE_URL || DEFAULT_URL,
      headers,
    );
    const windows = mapCodexUsage(data);
    if (windows.length === 0) return failure("codex", "error", account);
    const plan =
      typeof data.plan_type === "string" && data.plan_type ? titleCase(data.plan_type) : null;
    return ok("codex", account, plan, windows);
  } catch (err) {
    return failure("codex", err instanceof UsageHttpError ? err.failure : "error", account);
  }
}
