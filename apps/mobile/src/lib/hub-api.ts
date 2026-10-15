/**
 * Asks a hub whether a token works, with plain fetch: `GET /api/health` with the token as a
 * Bearer header, then the `tokens.current` tRPC query. Pairing calls it before saving a hub,
 * and the app calls it at start and on Retry. The token goes only in the Authorization header.
 */

export type HubCheck =
  | { ok: true; label: string }
  | { ok: false; reason: "invalid-token" | "unreachable" | "not-band" | "error"; error: string };

export const INVALID_TOKEN_MESSAGE = "Invalid token. The hub rejected it.";

async function getJson(
  url: string,
  token: string,
  timeoutMs: number,
): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      // no-store keeps iOS's URL cache from writing the request, and with it the
      // Authorization header, to Library/Caches.
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Cache-Control": "no-store",
      },
      signal: controller.signal,
    });
    const body = res.ok ? await res.json().catch(() => null) : null;
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

export async function checkHub(
  hubUrl: string,
  token: string,
  timeoutMs = 8_000,
): Promise<HubCheck> {
  let health: { status: number; body: unknown };
  try {
    health = await getJson(`${hubUrl}/api/health`, token, timeoutMs);
  } catch {
    return { ok: false, reason: "unreachable", error: `Could not reach the hub at ${hubUrl}` };
  }
  if (health.status === 401 || health.status === 403) {
    return { ok: false, reason: "invalid-token", error: INVALID_TOKEN_MESSAGE };
  }
  if (health.status !== 200) {
    return { ok: false, reason: "error", error: `The hub answered with HTTP ${health.status}` };
  }
  const body = health.body as { app?: unknown; hostname?: unknown } | null;
  if (body?.app !== "band-web-server") {
    return { ok: false, reason: "not-band", error: "That URL is not a Band hub" };
  }

  let current: { status: number; body: unknown };
  try {
    current = await getJson(`${hubUrl}/trpc/tokens.current`, token, timeoutMs);
  } catch {
    return { ok: false, reason: "unreachable", error: `Could not reach the hub at ${hubUrl}` };
  }
  if (current.status === 401 || current.status === 403) {
    return { ok: false, reason: "invalid-token", error: INVALID_TOKEN_MESSAGE };
  }
  const data = (current.body as { result?: { data?: unknown } } | null)?.result?.data;
  if (current.status !== 200 || !data || typeof data !== "object") {
    return { ok: false, reason: "error", error: `The hub answered with HTTP ${current.status}` };
  }

  const label =
    typeof body.hostname === "string" && body.hostname ? body.hostname : new URL(hubUrl).host;
  return { ok: true, label };
}
