/** Rows of the Sessions sheet: the web's session history menu (`SessionHistoryMenu`), as pure functions. */

export interface SessionSummary {
  sessionId: string;
  summary: string;
  lastModified: number;
}

export interface SessionRow {
  sessionId: string;
  label: string;
  /** "just now", "5m ago" and so on; empty when the agent gave no time. */
  age: string;
  current: boolean;
}

/** Same steps as the web's `relativeTime`. */
export function relativeAge(ms: number, now: number): string {
  const seconds = Math.floor((now - ms) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

/** The summary, or the first 8 characters of the id when there is none. */
export function sessionLabel(session: Pick<SessionSummary, "sessionId" | "summary">): string {
  const summary = session.summary?.trim();
  return summary ? summary : session.sessionId.slice(0, 8);
}

/** Newest first, with the current session marked. */
export function sessionRows(
  sessions: SessionSummary[],
  currentSessionId: string | undefined,
  now: number,
): SessionRow[] {
  return [...sessions]
    .sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0))
    .map((s) => ({
      sessionId: s.sessionId,
      label: sessionLabel(s),
      age: s.lastModified ? relativeAge(s.lastModified, now) : "",
      current: s.sessionId === currentSessionId,
    }));
}
