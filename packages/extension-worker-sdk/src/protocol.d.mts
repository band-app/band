export const STREAM_FD: 3;
export const MAX_STREAM_FRAME_BYTES: number;
export function encodeStreamFrame(streamId: number, message: string | Uint8Array): Buffer;
export class StreamFrameReader {
  push(chunk: Uint8Array): Array<{ streamId: number; message: string | Buffer }>;
}
