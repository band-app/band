/**
 * Shared tRPC helper for e2e specs that drive the real server.
 *
 * Centralises the "POST /trpc/<procedure>?token=…" idiom so multiple
 * specs (`queue-ui`, `chat-virtualization`, …) share one
 * implementation instead of each copying it inline. The auth shape
 * (`?token=…` query param) matches the established pattern across
 * existing specs.
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
  const res = await fetch(`${serverUrl}/trpc/${procedure}?token=${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`trpcMutate(${procedure}) failed: ${res.status} ${text}`);
  }
}
