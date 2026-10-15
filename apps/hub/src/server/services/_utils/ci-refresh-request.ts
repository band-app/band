let requested = false;

/** Ask the branch-status poller to query GitHub on its next tick. */
export function requestCIRefresh(): void {
  requested = true;
}

/** Whether a refresh was requested since the last call. Clears the request. */
export function takeCIRefreshRequest(): boolean {
  const was = requested;
  requested = false;
  return was;
}
