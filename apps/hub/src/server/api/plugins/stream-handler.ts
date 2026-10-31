import type { IncomingMessage } from "node:http";
import { createLogger } from "@band-app/logger";
import { bridgePluginStream } from "@band-app/worktree-ops/plugin-stream-socket";
import type { WebSocket } from "ws";
import { pluginHost } from "../../services/plugin-host-service";

const log = createLogger("plugin-stream");

/** Matches `/api/plugins/<plugin id>/worktrees/<worktree id>/stream`. */
const STREAM_PATH = /^\/api\/plugins\/([a-z0-9][a-z0-9-]*)\/worktrees\/([^/]+)\/stream$/;

/** The plugin and worktree a stream upgrade names, or null when the path is some other route. */
export function pluginStreamTarget(
  pathname: string,
): { pluginId: string; worktreeId: string } | null {
  const match = STREAM_PATH.exec(pathname);
  if (!match?.[1] || !match[2]) return null;
  try {
    return { pluginId: match[1], worktreeId: decodeURIComponent(match[2]) };
  } catch {
    return null;
  }
}

/**
 * Bridges a viewer's WebSocket to a plugin's live stream on the worktree's worker (see
 * `bridgePluginStream` for the view-only rule). The hub carries every frame, so it asks the plugin
 * for the `hub` profile: smaller frames at a capped rate. A stream the worker cannot open closes
 * the socket with code 4001 and the reason.
 */
export async function handlePluginStream(
  ws: WebSocket,
  req: IncomingMessage,
  target: { pluginId: string; worktreeId: string },
): Promise<void> {
  log.debug(
    "%s viewer connected: %s (%s)",
    target.pluginId,
    target.worktreeId,
    req.socket.remoteAddress ?? "unknown",
  );
  await bridgePluginStream(
    ws,
    `${target.pluginId} stream of ${target.worktreeId}`,
    () => pluginHost.openStream(target.pluginId, target.worktreeId, "screen", { profile: "hub" }),
    (message) => ws.close(4001, message.slice(0, 120)),
  );
}
