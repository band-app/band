/**
 * Splits a viewer's RFB byte stream into messages so the hub can decide, per message, whether
 * the host's x11vnc sees it. In view-only mode only the messages that change nothing on the
 * remote desktop pass: SetPixelFormat, SetEncodings and FramebufferUpdateRequest. KeyEvent,
 * PointerEvent and ClientCutText are dropped. A message type the filter does not know ends the
 * session, because its length is unknown and the stream could not be followed past it.
 *
 * The filter always parses, so a viewer that switches to control mid-session keeps its place in
 * the stream. A message is held until it is complete, so a change of mode never splits one.
 * Only RFB 3.7 and 3.8 with security type None (x11vnc -nopw) are followed. Anything else
 * ends the session with a reason, rather than letting bytes through that the filter cannot read.
 */

const MSG_SET_PIXEL_FORMAT = 0;
const MSG_SET_ENCODINGS = 2;
const MSG_FRAMEBUFFER_UPDATE_REQUEST = 3;
const MSG_KEY_EVENT = 4;
const MSG_POINTER_EVENT = 5;
const MSG_CLIENT_CUT_TEXT = 6;

/** Most bytes of one held message. ClientCutText is the only one with a length from the viewer. */
const MAX_MESSAGE_BYTES = 1024 * 1024;

/** A ClientCutText that says it is larger than the filter holds ends the session at once. */
function cutTextSize(payload: number): number {
  if (8 + payload > MAX_MESSAGE_BYTES) throw new RfbFilterError("RFB message too large");
  return 8 + payload;
}

type Phase = "version" | "security" | "init" | "messages";

export class RfbFilterError extends Error {}

export class RfbClientFilter {
  /** Starts true. The pane asks for control with an explicit request, see `desktop-proxy.ts`. */
  viewOnly = true;
  private phase: Phase = "version";
  private held: Buffer = Buffer.alloc(0);

  /** Takes the bytes of one WebSocket frame and returns the bytes to write to the host. */
  push(chunk: Buffer): Buffer[] {
    this.held = this.held.length === 0 ? chunk : Buffer.concat([this.held, chunk]);
    const out: Buffer[] = [];
    for (;;) {
      const size = this.nextSize();
      if (size === null || this.held.length < size) break;
      const message = this.held.subarray(0, size);
      this.held = this.held.subarray(size);
      if (this.allowed(message)) out.push(message);
    }
    if (this.held.length > MAX_MESSAGE_BYTES) {
      throw new RfbFilterError("RFB message too large");
    }
    return out;
  }

  /** Length of the message at the head of the buffer, or null while it is too short to tell. */
  private nextSize(): number | null {
    if (this.held.length === 0) return null;
    switch (this.phase) {
      case "version":
        return 12;
      case "security":
      case "init":
        return 1;
      case "messages":
        return this.messageSize();
    }
  }

  private messageSize(): number | null {
    const buf = this.held;
    switch (buf[0]) {
      case MSG_SET_PIXEL_FORMAT:
        return 20;
      case MSG_SET_ENCODINGS:
        return buf.length < 4 ? null : 4 + 4 * buf.readUInt16BE(2);
      case MSG_FRAMEBUFFER_UPDATE_REQUEST:
        return 10;
      case MSG_KEY_EVENT:
        return 8;
      case MSG_POINTER_EVENT:
        return 6;
      case MSG_CLIENT_CUT_TEXT:
        // A negative length is the ExtendedClipboard format, with a payload of its absolute
        // value. noVNC sends one as soon as x11vnc offers that extension. Read as unsigned it
        // looked like a 4 GiB message, which held every later message, keys and clicks included.
        return buf.length < 8 ? null : cutTextSize(Math.abs(buf.readInt32BE(4)));
      default:
        throw new RfbFilterError(`Unsupported RFB message type ${buf[0]}`);
    }
  }

  private allowed(message: Buffer): boolean {
    switch (this.phase) {
      case "version": {
        if (!/^RFB 003\.00[78]\n$/.test(message.toString("latin1"))) {
          throw new RfbFilterError("Unsupported RFB version");
        }
        this.phase = "security";
        return true;
      }
      case "security":
        if (message[0] !== 1) throw new RfbFilterError("Only security type None is supported");
        this.phase = "init";
        return true;
      case "init":
        this.phase = "messages";
        return true;
      case "messages":
        switch (message[0]) {
          case MSG_KEY_EVENT:
          case MSG_POINTER_EVENT:
          case MSG_CLIENT_CUT_TEXT:
            return !this.viewOnly;
          default:
            return true;
        }
    }
  }
}
