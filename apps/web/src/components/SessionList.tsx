import { GitBranch, Loader2, MessageSquare, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { trpc } from "../lib/trpc-client";

interface SessionItem {
  sessionId: string;
  summary: string;
  lastModified: number;
  firstPrompt?: string;
  gitBranch?: string;
}

interface SessionListProps {
  workspaceId: string;
  activeSessionId?: string;
  onSelectSession: (sessionId: string) => void;
  onNewSession: () => void;
}

function relativeTime(ms: number): string {
  const seconds = Math.floor((Date.now() - ms) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

export function SessionList({
  workspaceId,
  activeSessionId,
  onSelectSession,
  onNewSession,
}: SessionListProps) {
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSessions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await trpc.sessions.list.query({ workspaceId });
      setSessions(data.sessions as SessionItem[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load sessions");
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <p className="text-base text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchSessions}
          className="inline-flex items-center gap-2 rounded-md bg-secondary px-3 py-1.5 text-base hover:bg-secondary/80"
        >
          <RefreshCw className="size-3.5" />
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 p-3">
        <button
          type="button"
          onClick={onNewSession}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-base font-medium text-primary-foreground transition-colors hover:bg-primary/90 active:bg-primary/80"
        >
          <Plus className="size-4" />
          New Session
        </button>
      </div>

      {sessions.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <MessageSquare className="size-10 text-muted-foreground" />
          <div>
            <p className="font-medium">No sessions yet</p>
            <p className="text-base text-muted-foreground">Start a new session to begin coding</p>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          <div className="flex flex-col gap-1 p-2 pt-0">
            {sessions.map((session) => {
              const isActive = session.sessionId === activeSessionId;
              return (
                <button
                  key={session.sessionId}
                  type="button"
                  onClick={() => onSelectSession(session.sessionId)}
                  className={`flex flex-col gap-1 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-accent/50 active:bg-accent/50 ${isActive ? "bg-accent/50 ring-1 ring-primary/30" : ""}`}
                >
                  <span className="line-clamp-2 text-base font-medium text-foreground">
                    {session.summary}
                  </span>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <span>{relativeTime(session.lastModified)}</span>
                    {session.gitBranch && (
                      <>
                        <span className="text-border">·</span>
                        <span className="inline-flex items-center gap-1">
                          <GitBranch className="size-3" />
                          {session.gitBranch}
                        </span>
                      </>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
