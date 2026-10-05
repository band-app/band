/**
 * Most git subprocesses one fan-out (a poller pass, a `repos.list`) runs
 * at once; the cap is per fan-out, not per process. `child_process` spawns
 * on the event loop, and each spawn blocks it for ~2-7 ms on macOS. Starting a git call for every worktree at once
 * (72 worktrees, ~110 spawns per branch-status tick) held the loop for
 * ~750 ms every 5 s, and the terminal WebSocket's keystroke echo waited
 * behind it. With four in flight, the next spawn starts when one exits, so
 * the loop handles other work between them.
 */
export const GIT_SPAWN_CONCURRENCY = 4;

/**
 * `Promise.all(items.map(fn))` with at most `limit` calls of `fn` in flight.
 * Results keep the order of `items`; the first rejection rejects the whole
 * call, as with `Promise.all`.
 */
export async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
