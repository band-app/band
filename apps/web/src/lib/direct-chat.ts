/**
 * Chats on the direct path. In the desktop app, a
 * chat that this computer's worker owns is read and sent on that worker's
 * direct listener (`127.0.0.1`), with the worktree's direct token
 * (`direct-worker.ts`), so the hub is not on the way. The worker speaks the
 * hub's chat wire format and uses the same event ids, so a stream can move
 * between the two without a reset.
 *
 * Everything falls back to the hub: a chat the worker does not own (404,
 * remembered for a minute), a token it does not know (401), a worker that
 * does not answer or answers with an error. A browser tab never takes this
 * path, because `directAccessFor` answers only in the desktop app.
 */

import type { HubFetch } from "@band-app/client/hub-client";
import { directAccessFor, forgetDirectToken, markDirectDown } from "./direct-worker";
import { hubFetch } from "./hub-config";

/** How long a chat the worker does not own goes to the hub before the worker is asked again. */
const NOT_OWNED_TTL_MS = 60_000;

const notOwnedUntil = new Map<string, number>();

/**
 * A call on the chat's direct path, or null when the hub must take it. A call
 * the caller aborted rejects, so the hub never gets it either.
 */
export async function directChatCall(
  worktreeId: string,
  chatId: string,
  path: string,
  init?: RequestInit,
): Promise<Response | null> {
  if ((notOwnedUntil.get(chatId) ?? 0) > Date.now()) return null;
  const access = await directAccessFor(worktreeId);
  if (!access) return null;
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${access.token}`);
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${access.port}${path}`, {
      ...init,
      headers,
      credentials: "omit",
    });
  } catch (err) {
    if (init?.signal?.aborted) throw err;
    markDirectDown(worktreeId);
    return null;
  }
  if (res.status === 404) {
    notOwnedUntil.set(chatId, Date.now() + NOT_OWNED_TTL_MS);
    return null;
  }
  if (res.status === 401) {
    forgetDirectToken(worktreeId);
    return null;
  }
  // The worker could not serve it (its log is still being copied, an older build): the hub can.
  if (res.status >= 500) return null;
  return res;
}

/**
 * A `HubFetch` for one chat's stream, sends and history: the worker's direct
 * port when it runs the chat, else the hub.
 */
export function chatFetch(worktreeId: () => string, chatId: string): HubFetch {
  return async (input, init) =>
    (await directChatCall(worktreeId(), chatId, input, init)) ?? hubFetch(input, init);
}
