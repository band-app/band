/**
 * Wire protocol between a worker and the hub. The README documents the frame
 * layout and message types; this file is the code form of it.
 */

/** Bump on any change that an older peer would misread. */
export const PROTOCOL_VERSION = 1;

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
  buildId: string;
  mode: WorkerMode;
  capabilities: string[];
  labels: Record<string, string>;
  roots: string[];
  agents: string[];
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
  if (!kind) throw new Error(`unknown frame kind ${buf.readUInt8(0)}`);
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
