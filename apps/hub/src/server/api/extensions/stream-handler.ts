import type { IncomingMessage } from "node:http";
import { createLogger } from "@band-app/logger";
import { bridgePluginStream } from "@band-app/worktree-ops/plugin-stream-socket";
import type { WebSocket } from "ws";
import { extensionService } from "../../services/extension-service";
import { pluginHost } from "../../services/plugin-host-service";

const log = createLogger("extension-stream");

/** Matches `/api/extensions/<extension id>/worktrees/<worktree id>/stream`. */
const STREAM_PATH = /^\/api\/extensions\/([a-z][a-z0-9-]*)\/worktrees\/([^/]+)\/stream$/;

export interface ExtensionStreamTarget {
  extensionId: string;
  worktreeId: string;
}

/** The extension and worktree a stream upgrade names, or null when the path is some other route. */
export function extensionStreamTarget(pathname: string): ExtensionStreamTarget | null {
  const match = STREAM_PATH.exec(pathname);
  if (!match?.[1] || !match[2]) return null;
  try {
    return { extensionId: match[1], worktreeId: decodeURIComponent(match[2]) };
  } catch {
    return null;
  }
}

/**
 * Bridges a viewer's WebSocket to a stream of an extension's worker service on the worktree's
 * worker. The query names the panel (`panel`, whose capability picks the service), the stream
 * (`name`) and its JSON params (`params`). The viewer is view-only until it asks for control
 * (`bridgePluginStream`). Only a person's device token reaches this route: the relay lists no such
 * route, so an agent gets 403.
 */
export async function handleExtensionStream(
  ws: WebSocket,
  req: IncomingMessage,
  target: ExtensionStreamTarget,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://hub");
  const panelId = url.searchParams.get("panel") ?? "";
  const name = url.searchParams.get("name") ?? "";
  const label = `${target.extensionId} stream of ${target.worktreeId}`;
  const fail = (message: string) => ws.close(4001, message.slice(0, 120));
  let params: unknown = {};
  try {
    const raw = url.searchParams.get("params");
    if (raw) params = JSON.parse(raw);
  } catch {
    fail("params is not JSON");
    return;
  }
  const manifest = await extensionService.get(target.extensionId);
  const panel = manifest?.contributes.panels.find((p) => p.id === panelId);
  if (!manifest || !panel) {
    fail(`${target.extensionId} has no panel ${panelId || "(none named)"}`);
    return;
  }
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) {
    fail("name is not a stream name");
    return;
  }
  log.debug("%s viewer connected (%s)", label, req.socket.remoteAddress ?? "unknown");
  await bridgePluginStream(
    ws,
    label,
    () => pluginHost.openStream(panel.capability, target.worktreeId, name, params),
    fail,
  );
}
