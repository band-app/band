// A `status.stream` subscriber, as the dashboard keeps open. The server runs
// its branch-status poller only while one exists.

import WebSocket from "ws";

export interface BranchGitStatus {
  dirty: boolean;
  conflict: boolean;
  ahead: number;
  behind: number;
  sync_state: string;
}

interface StreamEvent {
  kind?: string;
  workspaceId?: string;
  git?: BranchGitStatus;
}

export class StatusStream {
  /** Every `branch-status` event's git status, newest last, by workspace. */
  readonly branchStatuses = new Map<string, BranchGitStatus[]>();

  private constructor(private readonly ws: WebSocket) {
    ws.on("message", (raw: Buffer) => {
      const data = (JSON.parse(raw.toString()) as { result?: { data?: StreamEvent } }).result?.data;
      if (data?.kind !== "branch-status" || !data.workspaceId || !data.git) return;
      const list = this.branchStatuses.get(data.workspaceId) ?? [];
      list.push(data.git);
      this.branchStatuses.set(data.workspaceId, list);
    });
  }

  /** Subscribe, resolving once the server has sent its on-connect snapshot. */
  static async open(serverUrl: string, token: string): Promise<StatusStream> {
    const ws = new WebSocket(`${serverUrl.replace(/^http/, "ws")}/trpc`, {
      headers: { Cookie: `band_token=${token}` },
    });
    const stream = new StatusStream(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("error", reject);
      ws.on("message", (raw: Buffer) => {
        const data = (JSON.parse(raw.toString()) as { result?: { data?: StreamEvent } }).result
          ?.data;
        if (data?.kind === "snapshot") resolve();
      });
      ws.once("open", () => {
        ws.send(
          JSON.stringify({
            id: 1,
            jsonrpc: "2.0",
            method: "subscription",
            params: { path: "status.stream", input: undefined },
          }),
        );
      });
    });
    return stream;
  }

  /** The newest git status polled for `workspaceId`, if any. */
  latest(workspaceId: string): BranchGitStatus | undefined {
    return this.branchStatuses.get(workspaceId)?.at(-1);
  }

  close(): void {
    this.ws.close();
  }
}
