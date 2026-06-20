/**
 * Shared tRPC helper for e2e specs that drive the real server.
 *
 * Centralises the "POST /trpc/<procedure>" idiom so multiple specs
 * share one implementation instead of each copying it inline. Auth
 * is carried via the `band_token` Cookie (matching the
 * `defaultHeaders` pattern in `apps/web/tests/chat-events.test.ts`)
 * rather than a `?token=` query param — keeps secrets out of the
 * server access logs and proxy logs.
 */

/**
 * Call a tRPC mutation against the real server's HTTP surface.
 *
 * Throws on non-2xx so callers don't need to handle response
 * inspection themselves — the integration tests want a fast
 * "something is broken" signal, not silent error swallowing.
 */
export async function trpcMutate(
  serverUrl: string,
  token: string,
  procedure: string,
  input: unknown,
): Promise<void> {
  const res = await fetch(`${serverUrl}/trpc/${procedure}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `band_token=${token}`,
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`trpcMutate(${procedure}) failed: ${res.status} ${text}`);
  }
}
