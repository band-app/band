/**
 * What an ephemeral worker's idle timer watches. Every RPC in flight and every
 * open channel holds the worker busy until it lets go, and letting go restarts
 * the idle clock.
 */
export class ActivityTracker {
  private holds = 0;
  private lastActivity = Date.now();

  /** Marks something as running. Call the returned function once, when it is done. */
  hold(): () => void {
    this.holds++;
    this.lastActivity = Date.now();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds--;
      this.lastActivity = Date.now();
    };
  }

  /** Counts as activity now, for things polled instead of held. */
  touch(): void {
    this.lastActivity = Date.now();
  }

  /** Milliseconds with nothing held, or 0 while anything is. */
  idleMs(now = Date.now()): number {
    return this.holds > 0 ? 0 : now - this.lastActivity;
  }
}
