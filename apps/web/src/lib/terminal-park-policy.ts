// ---------------------------------------------------------------------------
// Which parked terminals to dispose. Ported from orca's
// `terminal-pane/terminal-hidden-view-parking.ts`, with the same constants.
//
// Every visited workspace stays mounted (`MultiWorkspacePanelHost`), so the
// memory bound for terminals is this policy rather than a workspace count. A
// terminal that is "cold parked" here is disposed by `terminal-cache.ts`: its
// xterm and socket go away, the server PTY survives, and the next reveal
// reconnects and replays the scrollback.
//
// Cold-park hysteresis keeps a hidden terminal warm for 30 s so quick flips
// never pay a replay; hot-retain keeps a bounded recently-hidden working set
// warm for 5 minutes beyond that. Orca's own note on the numbers: the cap (not
// the clock) is the primary evictor, 4 workspaces covers the ordinary working
// set, and cutting remount frequency beats shaving replay cost.
// ---------------------------------------------------------------------------

export const TERMINAL_WORKSPACE_COLD_PARK_DELAY_MS = 30_000;
export const TERMINAL_WORKSPACE_HOT_RETAIN_MS = 5 * 60_000;
export const TERMINAL_WORKSPACE_HOT_RETAIN_LIMIT = 4;
export const TERMINAL_TAB_COLD_PARK_DELAY_MS = 30_000;
export const TERMINAL_TAB_HOT_RETAIN_MS = 5 * 60_000;
export const TERMINAL_TAB_HOT_RETAIN_LIMIT = 6;

export interface ColdParkRetainCandidate {
  id: string;
  hiddenSinceMs: number;
  /** Higher means activated more recently; breaks same-pass hidden-time ties. */
  lastActivatedSeq?: number;
}

// A workspace switch hides every terminal of that workspace at once, so
// activation order must break the hidden-time tie before the id fallback.
function compareColdParkRecencyDesc(
  a: ColdParkRetainCandidate,
  b: ColdParkRetainCandidate,
): number {
  if (a.hiddenSinceMs !== b.hiddenSinceMs) {
    return b.hiddenSinceMs - a.hiddenSinceMs;
  }
  const activationDelta = (b.lastActivatedSeq ?? -1) - (a.lastActivatedSeq ?? -1);
  return activationDelta === 0 ? a.id.localeCompare(b.id) : activationDelta;
}

// The most recently hidden candidate is the view the user just switched away
// from. Keeping it warm regardless of the TTL or cap means switching back after
// any absence is instant.
function selectLastActiveRetainedId(candidates: ColdParkRetainCandidate[]): string | null {
  let lastActive: ColdParkRetainCandidate | null = null;
  for (const candidate of candidates) {
    if (lastActive === null || compareColdParkRecencyDesc(candidate, lastActive) < 0) {
      lastActive = candidate;
    }
  }
  return lastActive?.id ?? null;
}

/**
 * Ids to cold-park: those hidden longer than `hotRetainMs`, plus those beyond
 * `hotRetainLimit` most-recently-hidden. The last-active id is exempt from
 * both. Callers pass only candidates already hidden past the cold-park delay.
 */
export function selectIdsBeyondHotRetain(
  candidates: ColdParkRetainCandidate[],
  args: { nowMs: number; hotRetainMs: number; hotRetainLimit: number },
): Set<string> {
  const lastActiveId = selectLastActiveRetainedId(candidates);
  const coldParkedIds = new Set<string>();
  const retainedCandidates: ColdParkRetainCandidate[] = [];
  for (const candidate of candidates) {
    if (candidate.id === lastActiveId) continue;
    if (args.nowMs - candidate.hiddenSinceMs >= args.hotRetainMs) {
      coldParkedIds.add(candidate.id);
    } else {
      retainedCandidates.push(candidate);
    }
  }
  retainedCandidates.sort(compareColdParkRecencyDesc);
  // When there is a last-active id it already holds one slot in the warm
  // working set, so the remaining candidates fill hotRetainLimit - 1;
  // otherwise the full cap applies.
  const remainingLimit = lastActiveId === null ? args.hotRetainLimit : args.hotRetainLimit - 1;
  for (const candidate of retainedCandidates.slice(Math.max(0, remainingLimit))) {
    coldParkedIds.add(candidate.id);
  }
  return coldParkedIds;
}
