/**
 * The local direct path. In the desktop app,
 * a worktree on this computer's own worker talks to that worker on
 * `127.0.0.1` for terminals, files, diff and search, instead of going through
 * the hub. The hub still issues the token (`worktree.directAccess`), for one
 * worktree and a few minutes.
 *
 * Every failure falls back to the hub without the caller seeing it: a refused
 * connection, a timeout, or an unknown or expired token. After a connection
 * failure the direct path rests for {@link RETRY_AFTER_MS}, then new calls try
 * it again. A browser tab never takes this path: only the desktop app knows
 * its worker's id, and nothing here probes loopback ports.
 */

import type { AppRouter } from "@band-app/server";
import {
  DIRECT_CALL_PREFIX,
  DIRECT_FALLBACK_CLOSE_CODE,
  DIRECT_TERMINAL_PATH,
  type DirectAccess,
  type DirectCallReply,
  isDirectProcedure,
} from "@band-app/shared/direct-access";
import { worktreeIdIsOnHost } from "@band-app/shared/worktree-id";
import { TRPCClientError, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";

import { invoke } from "./desktop-ipc";
import { hubFetch } from "./hub-config";
import { isDesktop } from "./is-desktop";

/** How long the direct path rests after it failed to connect. */
const RETRY_AFTER_MS = 15_000;
/** A token this close to its expiry is renewed in the background while it is still used. */
const RENEW_BEFORE_MS = 2 * 60_000;
/** How long a direct call may take before the hub gets it instead. */
const CALL_TIMEOUT_MS = 15_000;
/** How long the hub may take to issue a token before the call goes to the hub instead. */
const ACCESS_TIMEOUT_MS = 5_000;
/** How long a failed background renewal, or a token request the hub did not answer, waits before the next one. */
const RENEW_RETRY_MS = 15_000;
/** How long to remember that the hub offered no direct path for a worktree. */
const NO_ACCESS_TTL_MS = 60_000;

const WS_BASE_PROTOCOL = "band";
const WS_TOKEN_PROTOCOL_PREFIX = "band-token.";

/** How long to remember that this computer is not a worker of the hub, so adding it mid-session takes effect. */
const NO_LOCAL_WORKER_TTL_MS = 60_000;

let localId: { promise: Promise<string | null>; at: number } | null = null;

/** This computer's worker id for the current hub, from the desktop app. Null in a browser. */
async function localWorkerId(): Promise<string | null> {
  if (!isDesktop) return null;
  const now = Date.now();
  if (!localId || (now - localId.at > NO_LOCAL_WORKER_TTL_MS && (await localId.promise) === null)) {
    localId = { promise: invoke<string | null>("worker_local_id").catch(() => null), at: now };
  }
  return localId.promise;
}

interface Entry {
  access: DirectAccess | null;
  /** No new token is asked for before then, after the hub answered null or did not answer. */
  noAccessUntil: number;
  pending: Promise<DirectAccess | null> | null;
  /** The direct path rests until then after a connection failure. */
  downUntil: number;
  /** No background renewal before then, after one failed. */
  renewAfter: number;
}

const entries = new Map<string, Entry>();

function entryFor(worktreeId: string): Entry {
  let entry = entries.get(worktreeId);
  if (!entry) {
    entry = { access: null, noAccessUntil: 0, pending: null, downUntil: 0, renewAfter: 0 };
    entries.set(worktreeId, entry);
  }
  return entry;
}

/** The hub's answer, or undefined when it gave none (a network error, a timeout or an error status). */
async function fetchAccess(
  worktreeId: string,
  hostId: string,
): Promise<DirectAccess | null | undefined> {
  const res = await hubFetch("/trpc/worktree.directAccess", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ worktreeId, hostId }),
    signal: AbortSignal.timeout(ACCESS_TIMEOUT_MS),
  });
  if (!res.ok) return undefined;
  const body = (await res.json()) as { result?: { data?: DirectAccess | null } };
  return body.result?.data ?? null;
}

function refresh(entry: Entry, worktreeId: string, hostId: string): Promise<DirectAccess | null> {
  entry.pending ??= fetchAccess(worktreeId, hostId)
    .catch(() => undefined)
    .then((answer) => {
      entry.pending = null;
      const now = Date.now();
      const current = entry.access;
      // A renewal the hub did not answer keeps the token it was renewing while that
      // still works, and waits a while before it asks again. A null answer drops it.
      if (answer === undefined && current && current.expiresAt > now) {
        entry.renewAfter = now + RENEW_RETRY_MS;
        return current;
      }
      entry.access = answer ?? null;
      entry.renewAfter = 0;
      // A hub that said no is asked again in a minute, one that did not answer sooner.
      entry.noAccessUntil =
        answer === null ? now + NO_ACCESS_TTL_MS : answer === undefined ? now + RENEW_RETRY_MS : 0;
      return entry.access;
    });
  return entry.pending;
}

/**
 * A live token for `worktreeId`'s direct path, or null when the hub must
 * serve it: not the desktop app, a worktree on another host, the direct path
 * resting after a failure, or a worker with no listener.
 */
export async function directAccessFor(worktreeId: string): Promise<DirectAccess | null> {
  const hostId = await localWorkerId();
  if (!hostId || !worktreeIdIsOnHost(worktreeId, hostId)) return null;
  const entry = entryFor(worktreeId);
  const now = Date.now();
  if (now < entry.downUntil) return null;
  const { access } = entry;
  if (access && access.expiresAt > now) {
    if (access.expiresAt - now < RENEW_BEFORE_MS && now >= entry.renewAfter) {
      void refresh(entry, worktreeId, hostId);
    }
    return access;
  }
  if (!access && now < entry.noAccessUntil) return null;
  // After an earlier answer with no token, this call goes to the hub while the hub is asked
  // again in the background. Only a worktree's first lookup waits for the answer.
  if (!access && entry.noAccessUntil > 0) {
    void refresh(entry, worktreeId, hostId);
    return null;
  }
  return refresh(entry, worktreeId, hostId);
}

/** The worker refused the token (it restarted, or the token expired): ask the hub for a new one next time. */
export function forgetDirectToken(worktreeId: string): void {
  const entry = entries.get(worktreeId);
  if (!entry) return;
  entry.access = null;
  entry.noAccessUntil = 0;
}

/** The worker did not answer: use the hub for a while. */
export function markDirectDown(worktreeId: string): void {
  const entry = entryFor(worktreeId);
  entry.access = null;
  entry.noAccessUntil = 0;
  entry.downUntil = Date.now() + RETRY_AFTER_MS;
}

/** Where a terminal's direct socket connects, with the subprotocols that carry its token. */
export interface DirectSocketTarget {
  url: string;
  protocols: string[];
}

export async function directTerminalTarget(
  worktreeId: string,
  terminalId: string,
): Promise<DirectSocketTarget | null> {
  const access = await directAccessFor(worktreeId);
  if (!access) return null;
  const query = `worktreeId=${encodeURIComponent(worktreeId)}&terminalId=${encodeURIComponent(terminalId)}`;
  return {
    url: `ws://127.0.0.1:${access.port}${DIRECT_TERMINAL_PATH}?${query}`,
    protocols: [WS_BASE_PROTOCOL, `${WS_TOKEN_PROTOCOL_PREFIX}${access.token}`],
  };
}

/**
 * What a direct terminal socket's close means. `fallback` reconnects through
 * the hub at once: the socket never opened (refused, no listener, a token the
 * worker does not know), the worker had no such PTY yet, or the connection
 * dropped. Anything else (an exit, a fatal error) is the terminal's own close.
 */
export function directSocketClosed(
  worktreeId: string,
  event: { code: number },
  opened: boolean,
): "fallback" | "normal" {
  if (event.code === DIRECT_FALLBACK_CLOSE_CODE) return "fallback";
  if (!opened) {
    // A refused upgrade and a dead listener look the same to a browser.
    markDirectDown(worktreeId);
    return "fallback";
  }
  if (event.code === 1000 || event.code >= 4000) return "normal";
  markDirectDown(worktreeId);
  return "fallback";
}

type DirectResult = { kind: "data"; data: unknown } | { kind: "error"; message: string } | null;

/** One direct call, or null when the hub should take it. */
async function callDirect(
  procedure: string,
  input: unknown,
  worktreeId: string,
  signal: AbortSignal | null | undefined,
): Promise<DirectResult> {
  const access = await directAccessFor(worktreeId);
  if (!access) return null;
  const timeout = AbortSignal.timeout(CALL_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${access.port}${DIRECT_CALL_PREFIX}${procedure}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${access.token}` },
      body: JSON.stringify(input ?? {}),
      credentials: "omit",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (err) {
    // The caller gave up: the hub must not get the call either.
    if (signal?.aborted) throw err;
    markDirectDown(worktreeId);
    return null;
  }
  if (res.status === 401) {
    forgetDirectToken(worktreeId);
    return null;
  }
  let body: DirectCallReply;
  try {
    body = (await res.json()) as DirectCallReply;
  } catch {
    markDirectDown(worktreeId);
    return null;
  }
  if (res.status === 200 && "result" in body) return { kind: "data", data: body.result };
  // The procedure itself failed. The hub would run the same code and fail the same way.
  if (res.status === 500 && "error" in body) return { kind: "error", message: body.error.message };
  // Anything else (a listener that refuses the call, an older worker) is the hub's to answer.
  return null;
}

/**
 * A tRPC link that sends the procedures in `DIRECT_PROCEDURES` to this
 * computer's worker when the worktree lives there, and everything else, or
 * anything the direct path cannot answer, to the next link (the hub).
 */
export function directWorkerLink(): TRPCLink<AppRouter> {
  return () =>
    ({ op, next }) => {
      if (op.type === "subscription" || !isDirectProcedure(op.path)) return next(op);
      const worktreeId = (op.input as { worktreeId?: unknown } | undefined)?.worktreeId;
      if (typeof worktreeId !== "string") return next(op);
      return observable((observer) => {
        let unsubscribe: (() => void) | null = null;
        let done = false;
        callDirect(op.path, op.input, worktreeId, op.signal).then(
          (result) => {
            if (done) return;
            if (result?.kind === "data") {
              observer.next({ result: { type: "data", data: result.data } });
              observer.complete();
            } else if (result?.kind === "error") {
              observer.error(
                TRPCClientError.from({
                  error: {
                    message: result.message,
                    code: -32603,
                    data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500, path: op.path },
                  },
                }),
              );
            } else {
              const sub = next(op).subscribe(observer);
              unsubscribe = () => sub.unsubscribe();
            }
          },
          (err: unknown) => {
            if (!done) observer.error(TRPCClientError.from(err as Error));
          },
        );
        return () => {
          done = true;
          unsubscribe?.();
        };
      });
    };
}
