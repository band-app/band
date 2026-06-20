// Generic polling helper for integration tests. Two tests already had a
// near-verbatim inline copy (`workspace-create-via.test.ts` and the new
// `tasks-submit-maxturns-strip.test.ts`); promoting it here removes the
// duplication and the risk that one copy drifts forward without the
// other (e.g. one gets a new `intervalMs` default but the other doesn't,
// silently changing CI timing characteristics).
//
// The shape is intentionally minimal — predicate, timeout, interval,
// label — and the `notDone` sentinel logic is the only piece worth
// inlining rather than relying on a generic truthy guard: bare `!value`
// would also loop on `""`, `0`, and other falsy-but-valid success
// values, which would silently never terminate if a caller's predicate
// ever returned them.

export interface WaitForOptions {
  timeoutMs?: number;
  intervalMs?: number;
  label?: string;
}

/**
 * Poll `fn` until it returns a value that is not one of the three "not
 * done" sentinels (`undefined`, `null`, `false`), or until `timeoutMs`
 * elapses. Returns the resolved value; throws `Error(`waitFor(label)
 * timed out after Nms`)` on timeout.
 *
 * Used to wait for async server-side state to become observable through
 * a polled query (`tasks.list`, `terminal.list`, etc.) without relying
 * on a wall-clock `setTimeout`.
 */
export async function waitFor<T>(
  fn: () => Promise<T | undefined | null | false>,
  { timeoutMs = 10_000, intervalMs = 50, label = "condition" }: WaitForOptions = {},
): Promise<T> {
  const start = Date.now();
  // Only the three explicit "not done" sentinels loop. See file header
  // for why we don't use bare truthy checking.
  const notDone = (v: T | undefined | null | false): v is undefined | null | false =>
    v === undefined || v === null || v === false;
  let value = await fn();
  while (notDone(value)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor(${label}) timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
    value = await fn();
  }
  return value;
}
