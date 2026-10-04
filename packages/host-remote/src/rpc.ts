import {
  HostOfflineError,
  HostPathDeniedError,
  HostTimeoutError,
  type Stream,
} from "@band-app/host-api";
import {
  type CallOptions,
  type Channel,
  LinkClosedError,
  type LinkSession,
  RPC_CANCELLED,
  RpcError,
  RpcTimeoutError,
} from "@band-app/link";

/** The worker's code for a path outside its roots (`apps/worker/src/rpc-util.ts`). */
export const RPC_PATH_DENIED = -32010;

/** How long a call may take, in milliseconds, unless the method has its own limit. */
export const DEFAULT_CALL_TIMEOUT_MS = 30_000;

/** Calls that legitimately run long: they clone, copy, scan or wait on a process. */
const SLOW_CALLS: Record<string, number> = {
  "git.exec": 5 * 60_000,
  "git.gh": 5 * 60_000,
  "worktree.create": 5 * 60_000,
  "worktree.remove": 5 * 60_000,
  "fs.copy": 5 * 60_000,
  "fs.rm": 2 * 60_000,
  "fs.du": 2 * 60_000,
  "fs.glob": 60_000,
  "search.listFiles": 60_000,
  "scripts.runHidden": 10 * 60_000,
  "scripts.copyFiles": 2 * 60_000,
  "agentEnv.installSkills": 2 * 60_000,
  "agentEnv.installHooks": 60_000,
  exec: 10 * 60_000,
};

type Encoded = { json: unknown } | { bytes: string } | { chan: number; as: "json" | "bytes" };

/** `ENOENT: no such file ...` errors keep their code, so callers can test `err.code` as they do for a local host. */
function withErrnoCode(err: Error): Error {
  const m = /^(E[A-Z0-9]+):/.exec(err.message);
  if (m) (err as NodeJS.ErrnoException).code = m[1];
  return err;
}

/** Turns what the link throws into the errors a `Host` method documents. */
export function mapLinkError(hostId: string, method: string, err: unknown, timeoutMs: number) {
  if (err instanceof RpcError) {
    if (err.code === RPC_PATH_DENIED) {
      const path = (err.data as { path?: unknown } | undefined)?.path;
      return new HostPathDeniedError(typeof path === "string" ? path : "", err.message);
    }
    if (err.code === RPC_CANCELLED) {
      const aborted = new Error(err.message);
      aborted.name = "AbortError";
      return aborted;
    }
    return withErrnoCode(new Error(err.message));
  }
  if (err instanceof RpcTimeoutError) return new HostTimeoutError(hostId, method, timeoutMs);
  if (err instanceof LinkClosedError) return new HostOfflineError(hostId, err.message);
  return err;
}

/** One host's view of its worker link: sends calls, decodes results and turns failures into host errors. */
export class RemoteRpc {
  constructor(
    readonly hostId: string,
    /** The worker's current session. It changes when the worker restarts, so it is read on every call. */
    private readonly sessionOf: () => LinkSession | undefined,
    private readonly timeouts: { defaultMs?: number } = {},
  ) {}

  /** The attached session. Throws `HostOfflineError` when the worker is not connected. */
  session(): LinkSession {
    const session = this.sessionOf();
    if (!session || !session.attached) throw new HostOfflineError(this.hostId);
    return session;
  }

  timeoutFor(method: string): number {
    return SLOW_CALLS[method] ?? this.timeouts.defaultMs ?? DEFAULT_CALL_TIMEOUT_MS;
  }

  /** Sends a request and returns the worker's reply as it came, without decoding. */
  async request<T>(method: string, params: unknown, opts: CallOptions = {}): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? this.timeoutFor(method);
    try {
      return await this.session().request<T>(method, params, { ...opts, timeoutMs });
    } catch (err) {
      throw mapLinkError(this.hostId, method, err, timeoutMs);
    }
  }

  /** Calls a method whose reply is `{ json }`, `{ bytes }` or a result channel, and decodes it. */
  async call<T = unknown>(
    method: string,
    params: unknown = {},
    opts: CallOptions = {},
  ): Promise<T> {
    const enc = await this.request<Encoded>(method, params, opts);
    return (await this.decode(enc)) as T;
  }

  /** Same as {@link call} for a reply that is bytes. */
  async callBytes(method: string, params: unknown, opts: CallOptions = {}): Promise<Uint8Array> {
    return this.call<Uint8Array>(method, params, opts);
  }

  async decode(enc: Encoded): Promise<unknown> {
    if ("json" in enc) return enc.json;
    if ("bytes" in enc) return new Uint8Array(Buffer.from(enc.bytes, "base64"));
    const ch = this.session().getChannel(enc.chan);
    if (!ch) throw new Error(`result channel ${enc.chan} is not open`);
    const data = await ch.readAll();
    ch.end();
    return enc.as === "json" ? JSON.parse(data.toString()) : new Uint8Array(data);
  }

  /** The channel a worker opened and named in a reply. It is open by then, because `link.open` comes first. */
  channel(id: number): Channel {
    const ch = this.session().getChannel(id);
    if (!ch) throw new Error(`channel ${id} is not open`);
    return ch;
  }
}

/**
 * Reads a worker's channel as a stream of byte chunks. Finishing the loop ends
 * the hub's side so the channel is released. Leaving it early, or an abort,
 * resets the channel, which tells the worker to stop what feeds it.
 */
export async function* channelBytes(ch: Channel, signal?: AbortSignal): Stream<Uint8Array> {
  const onAbort = () => ch.reset("consumer aborted");
  if (signal?.aborted) {
    ch.reset("consumer aborted");
    return;
  }
  signal?.addEventListener("abort", onAbort, { once: true });
  let finished = false;
  try {
    for await (const chunk of ch) yield chunk;
    finished = true;
  } catch (err) {
    if (signal?.aborted) return;
    throw err;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (finished) ch.end();
    else ch.reset("consumer stopped");
  }
}

/** One JSON value per line, as the worker writes `fs.watch` and `search.stream`. */
export async function* channelJsonLines<T>(ch: Channel, signal?: AbortSignal): Stream<T> {
  let pending = "";
  const decoder = new TextDecoder();
  for await (const chunk of channelBytes(ch, signal)) {
    pending += decoder.decode(chunk, { stream: true });
    let nl = pending.indexOf("\n");
    while (nl !== -1) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      if (line.trim() !== "") yield JSON.parse(line) as T;
      nl = pending.indexOf("\n");
    }
  }
  if (pending.trim() !== "") yield JSON.parse(pending) as T;
}
