import { type Channel, type LinkSession, RpcError } from "@band-app/link";
import { PathDeniedError } from "./path-policy.ts";

export const RPC_INVALID_PARAMS = -32602;
/** The call named a path outside every root. `error.data.path` is the path. */
export const RPC_PATH_DENIED = -32010;

export type Params = Record<string, unknown>;

const invalid = (message: string) => new RpcError(RPC_INVALID_PARAMS, message);

export function asParams(raw: unknown): Params {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw invalid("params must be an object");
  }
  return raw as Params;
}

export function str(p: Params, key: string): string {
  const v = p[key];
  if (typeof v !== "string") throw invalid(`${key} must be a string`);
  return v;
}

export function optStr(p: Params, key: string): string | undefined {
  return p[key] === undefined || p[key] === null ? undefined : str(p, key);
}

export function optNum(p: Params, key: string): number | undefined {
  const v = p[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) throw invalid(`${key} must be a number`);
  return v;
}

export function num(p: Params, key: string): number {
  const v = optNum(p, key);
  if (v === undefined) throw invalid(`${key} must be a number`);
  return v;
}

export function optBool(p: Params, key: string): boolean | undefined {
  const v = p[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw invalid(`${key} must be a boolean`);
  return v;
}

export function strArray(p: Params, key: string): string[] {
  const v = p[key];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    throw invalid(`${key} must be an array of strings`);
  }
  return v as string[];
}

function obj(p: Params, key: string): Params {
  const v = p[key];
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw invalid(`${key} must be an object`);
  }
  return v as Params;
}

export function optObj(p: Params, key: string): Params | undefined {
  return p[key] === undefined || p[key] === null ? undefined : obj(p, key);
}

export function strRecord(p: Params, key: string): Record<string, string> {
  const o = obj(p, key);
  if (!Object.values(o).every((v) => typeof v === "string")) {
    throw invalid(`${key} must map strings to strings`);
  }
  return o as Record<string, string>;
}

/** Drops keys whose value is undefined. Node's `rm` rejects `{ force: undefined }`, so options go through this. */
export function compact<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

export function mapError(err: unknown): unknown {
  if (err instanceof PathDeniedError) {
    return new RpcError(RPC_PATH_DENIED, err.message, { path: err.path });
  }
  return err;
}

// ---- Result encoding ------------------------------------------------------

/** Largest result sent inside the RPC response. A link message may not exceed 1 MiB, base64 included. */
export const INLINE_LIMIT = 256 * 1024;

/**
 * A call's result. Small values travel in the response. A large one goes down a
 * channel the worker opens before it answers, so the hub reads `chan` to its end,
 * then ends its own side of the channel to release it.
 */
export type Encoded =
  | { json: unknown }
  | { bytes: string }
  | { chan: number; as: "json" | "bytes" };

export function encodeJson(session: LinkSession, value: unknown): Encoded {
  const text = JSON.stringify(value ?? null);
  if (Buffer.byteLength(text) <= INLINE_LIMIT) return { json: value ?? null };
  return viaChannel(session, Buffer.from(text), "json");
}

export function encodeBytes(session: LinkSession, data: Uint8Array): Encoded {
  if (data.byteLength <= INLINE_LIMIT) return { bytes: Buffer.from(data).toString("base64") };
  return viaChannel(session, Buffer.from(data), "bytes");
}

function viaChannel(session: LinkSession, data: Buffer, as: "json" | "bytes"): Encoded {
  const ch: Channel = session.openChannel("result", { as });
  ch.send(data).then(
    () => ch.end(),
    () => undefined,
  );
  return { chan: ch.id, as };
}
