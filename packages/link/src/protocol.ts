/**
 * Wire protocol between a worker and the hub. The README documents the frame
 * layout and message types; this file is the code form of it.
 */

/** Bump on any change that an older peer would misread. */
export const PROTOCOL_VERSION = 2;

export const DEFAULT_HEARTBEAT_MS = 15_000;
/** A peer is lost after this many heartbeat intervals with no frame received. */
export const HEARTBEAT_MISSES = 3;
export const DEFAULT_CHANNEL_WINDOW = 256 * 1024;
export const MAX_CHUNK_BYTES = 16 * 1024;
/** Largest WebSocket message either side accepts. Chunks and RPC messages fit well inside it. */
export const MAX_MESSAGE_BYTES = 1024 * 1024;

export type WorkerMode = "attached" | "ephemeral";

export interface Hello {
  type: "hello";
  protocol: number;
  workerId: string;
  token: string;
  /** The `sessionToken` from the last `ready` this client received. Proves it owns the session on a reconnect. */
  sessionToken?: string;
  buildId: string;
  mode: WorkerMode;
  capabilities: string[];
  labels: Record<string, string>;
  roots: string[];
  agents: string[];
  /** Toolchain versions on the worker's PATH (`node`, `python`, `go`, ...). Absent from older workers. */
  tools?: Record<string, string>;
  /** Highest sequence number the sender has received on each channel. */
  resume?: Record<string, number>;
}

export interface Ready {
  type: "ready";
  sessionToken: string;
  heartbeatMs: number;
  /** True when the server kept the session, so channels survive. */
  resumed: boolean;
  /** Highest sequence number the server has received on each channel. */
  resume?: Record<string, number>;
}

export interface Mismatch {
  type: "mismatch";
  need: number;
}

export interface Rejected {
  type: "rejected";
  reason: string;
}

export type HandshakeReply = Ready | Mismatch | Rejected;

/** The `hello` fields a client chooses, without the ones the client fills in. */
export type HelloInfo = Omit<Hello, "type" | "protocol" | "token" | "resume">;

export const WORKER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;

const isStringArray = (v: unknown): boolean =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/** Checks a parsed `hello` field by field and returns the first problem, or null. */
export function validateHello(h: Hello): string | null {
  if (typeof h.workerId !== "string" || !WORKER_ID_PATTERN.test(h.workerId)) {
    return "workerId must be 1 to 256 characters from A-Z a-z 0-9 . _ : -";
  }
  if (h.sessionToken !== undefined && typeof h.sessionToken !== "string") {
    return "sessionToken must be a string";
  }
  if (typeof h.token !== "string") return "token must be a string";
  if (typeof h.buildId !== "string") return "buildId must be a string";
  if (h.mode !== "attached" && h.mode !== "ephemeral") return "mode must be attached or ephemeral";
  if (!isStringArray(h.capabilities)) return "capabilities must be a string array";
  if (!isStringArray(h.roots)) return "roots must be a string array";
  if (!isStringArray(h.agents)) return "agents must be a string array";
  const labels = h.labels as unknown;
  if (
    typeof labels !== "object" ||
    labels === null ||
    Array.isArray(labels) ||
    !Object.values(labels).every((v) => typeof v === "string")
  ) {
    return "labels must map strings to strings";
  }
  if (h.tools !== undefined) {
    const tools = h.tools as unknown;
    if (
      typeof tools !== "object" ||
      tools === null ||
      Array.isArray(tools) ||
      !Object.values(tools).every((v) => typeof v === "string")
    ) {
      return "tools must map strings to strings";
    }
  }
  if (h.resume !== undefined) {
    const resume = h.resume as unknown;
    if (typeof resume !== "object" || resume === null || Array.isArray(resume)) {
      return "resume must be an object";
    }
    for (const v of Object.values(resume)) {
      if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 0xffffffff) {
        return "resume values must be integers from 0 to 4294967295";
      }
    }
  }
  return null;
}

// ---- JSON-RPC 2.0 -------------------------------------------------------

export interface RpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

export interface RpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface RpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INTERNAL_ERROR = -32603;
export const RPC_INVALID_REQUEST = -32600;
/** Application error code for a request the caller cancelled. */
export const RPC_CANCELLED = -32800;

/** Control methods the link itself uses. Applications must not register them. */
export const METHOD_HEARTBEAT = "link.heartbeat";
export const METHOD_CANCEL = "link.cancel";
export const METHOD_OPEN = "link.open";

export class RpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

export class RpcTimeoutError extends Error {
  constructor(method: string, ms: number) {
    super(`RPC ${method} timed out after ${ms} ms`);
    this.name = "RpcTimeoutError";
  }
}

export class LinkClosedError extends Error {
  constructor(message = "link is not connected") {
    super(message);
    this.name = "LinkClosedError";
  }
}

// ---- Binary frames ------------------------------------------------------

export type FrameKind = "data" | "end" | "credit" | "reset";

const KIND_CODE: Record<FrameKind, number> = { data: 0, end: 1, credit: 2, reset: 3 };
const CODE_KIND: FrameKind[] = ["data", "end", "credit", "reset"];

export const FRAME_HEADER_BYTES = 9;

export interface Frame {
  chan: number;
  seq: number;
  kind: FrameKind;
  payload: Buffer;
}

/** `[kind u8][chan u32 BE][seq u32 BE][payload]`. */
export function encodeFrame(frame: Frame): Buffer {
  const out = Buffer.allocUnsafe(FRAME_HEADER_BYTES + frame.payload.length);
  out.writeUInt8(KIND_CODE[frame.kind], 0);
  out.writeUInt32BE(frame.chan, 1);
  out.writeUInt32BE(frame.seq, 5);
  frame.payload.copy(out, FRAME_HEADER_BYTES);
  return out;
}

export function decodeFrame(buf: Buffer): Frame {
  if (buf.length < FRAME_HEADER_BYTES) throw new Error("frame shorter than its header");
  const kind = CODE_KIND[buf.readUInt8(0)];
  if (kind === undefined) throw new Error(`unknown frame kind ${buf.readUInt8(0)}`);
  return {
    kind,
    chan: buf.readUInt32BE(1),
    seq: buf.readUInt32BE(5),
    payload: buf.subarray(FRAME_HEADER_BYTES),
  };
}

/** A credit frame's payload is the receiver's cumulative consumed byte count (float64 BE). */
export function encodeCredit(chan: number, consumedSeq: number, consumedBytes: number): Buffer {
  const payload = Buffer.allocUnsafe(8);
  payload.writeDoubleBE(consumedBytes, 0);
  return encodeFrame({ chan, seq: consumedSeq, kind: "credit", payload });
}

export function decodeCreditBytes(payload: Buffer): number {
  if (payload.length < 8) throw new Error("credit frame payload shorter than 8 bytes");
  return payload.readDoubleBE(0);
}
