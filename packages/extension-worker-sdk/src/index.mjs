import { createInterface } from "node:readline";
import { Socket } from "node:net";
import { encodeStreamFrame, STREAM_FD, StreamFrameReader } from "./protocol.mjs";

// stdout is the control channel, so a stray console.log must not reach it.
console.log = (...args) => console.error(...args);
console.info = (...args) => console.error(...args);

/** Starts the stdio protocol. See index.d.mts. */
export function defineWorkerService(definition) {
  const calls = definition.calls ?? {};
  const streamDefs = definition.streams ?? {};
  const out = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const streams = new Map();
  let fd = null;
  try {
    fd = new Socket({ fd: STREAM_FD, readable: true, writable: true });
    fd.on("error", () => {});
    const reader = new StreamFrameReader();
    fd.on("data", (chunk) => {
      let frames;
      try {
        frames = reader.push(chunk);
      } catch {
        return;
      }
      for (const { streamId, message } of frames) streams.get(streamId)?.onMessage?.(message);
    });
  } catch {
    // No stream pipe: calls still work, stream.open fails.
  }

  const scopeOf = (p) => ({ worktreeKey: p.worktreeKey, worktreePath: p.worktreePath });

  async function handle(method, p) {
    switch (method) {
      case "init":
        await definition.onInit?.(p);
        return { ok: true };
      case "call": {
        const fn = calls[p.method];
        if (!fn) throw new Error(`unknown call "${p.method}"`);
        return (await fn(p.params, scopeOf(p))) ?? null;
      }
      case "stream.open": {
        const open = streamDefs[p.name];
        if (!open) throw new Error(`unknown stream "${p.name}"`);
        if (!fd) throw new Error("this service has no stream pipe");
        const entry = {};
        streams.set(p.streamId, entry);
        const handle = {
          send: (message) => {
            if (streams.get(p.streamId) === entry) fd.write(encodeStreamFrame(p.streamId, message));
          },
          end: () => {
            if (streams.delete(p.streamId)) out({ method: "stream.end", params: { streamId: p.streamId } });
          },
        };
        try {
          const handlers = await open(p.params, scopeOf(p), handle);
          entry.onMessage = handlers?.onMessage;
          entry.onClose = handlers?.onClose;
        } catch (err) {
          streams.delete(p.streamId);
          throw err;
        }
        return { ok: true };
      }
      case "stream.close": {
        const entry = streams.get(p.streamId);
        streams.delete(p.streamId);
        await entry?.onClose?.();
        return null;
      }
      case "worktree.env": {
        const env = (await definition.worktreeEnv?.(scopeOf(p))) ?? {};
        return { env };
      }
      case "worktree.release":
        await definition.onRelease?.(p.worktreeKey, p.reason);
        return null;
      case "stop":
        for (const [id, entry] of streams) {
          streams.delete(id);
          await Promise.resolve(entry.onClose?.()).catch(() => {});
        }
        await definition.onStop?.();
        return null;
      default:
        throw new Error(`unknown method "${method}"`);
    }
  }

  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    handle(msg.method, msg.params ?? {}).then(
      (result) => {
        if (msg.id !== undefined) out({ id: msg.id, result: result ?? null });
        if (msg.method === "stop") setImmediate(() => process.exit(0));
      },
      (err) => {
        if (msg.id !== undefined) {
          out({ id: msg.id, error: { message: err instanceof Error ? err.message : String(err) } });
        }
      },
    );
  });
  // The worker closing stdin means it is gone. Do not outlive it.
  rl.on("close", () => process.exit(0));
}
