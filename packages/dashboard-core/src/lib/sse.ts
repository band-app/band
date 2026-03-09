import type { CIStatus, GitStatus, WorkspaceStatus } from "../types";

export type SSEEvent = {
  kind:
    | "update"
    | "remove"
    | "snapshot"
    | "branch-status"
    | "tunnel-url"
    | "tunnel-error"
    | "tunnel-subdomain-taken"
    | "tunnel-remote-host";
  status?: WorkspaceStatus;
  statuses?: WorkspaceStatus[];
  workspaceId?: string;
  git?: GitStatus;
  ci?: CIStatus;
  url?: string;
  error?: string;
  host?: string;
};

type SSEHandler = (data: SSEEvent) => void;
type Unsubscribe = () => void;

let _eventSource: EventSource | null = null;
const _handlers = new Set<SSEHandler>();

function _ensureEventSource(): void {
  if (_eventSource) return;
  const es = new EventSource("/api/status/stream");
  es.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data) as SSEEvent;
      for (const handler of _handlers) {
        handler(data);
      }
    } catch {
      // Skip malformed events
    }
  };
  _eventSource = es;
}

export function subscribeSSE(handler: SSEHandler): Unsubscribe {
  _handlers.add(handler);
  _ensureEventSource();
  return () => {
    _handlers.delete(handler);
    if (_handlers.size === 0) {
      _eventSource?.close();
      _eventSource = null;
    }
  };
}
