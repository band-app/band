import type { IncomingMessage } from "node:http";
import { serveLspSocket } from "@band-app/worktree-ops/lsp-socket";
import type { WebSocket } from "ws";
import { WorktreeQueries } from "../db/queries/worktrees";
import { hostRegistry } from "../host/registry";

export { createFrameParser, frameMessage } from "@band-app/worktree-ops/lsp-socket";

const worktreeQueries = new WorktreeQueries();

export async function handleLspConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const worktreeId = url.searchParams.get("worktreeId");
  const lang = url.searchParams.get("lang");

  if (!worktreeId || !lang) {
    ws.close(4000, "Missing worktreeId or lang");
    return;
  }

  await serveLspSocket(ws, worktreeId, lang, async () => {
    // Direct infra-tier DB read: the proxy is in the infra tier and cannot
    // depend on `WorktreeService.resolve` (issue #535).
    const worktree = worktreeQueries.findIdentity(worktreeId);
    if (!worktree) {
      throw new Error(`Worktree not found: ${worktreeId}`);
    }
    return hostRegistry
      .hostFor(worktreeId)
      .lsp.connect({ worktreeId, lang, root: worktree.worktreePath });
  });
}
