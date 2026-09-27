/**
 * Coalesces a terminal's input writes into fewer WebSocket messages, ported
 * from Orca's `pty-input-write-queue.ts`.
 *
 * Wheel reports during trackpad momentum and key auto-repeat produce one tiny
 * `onData` chunk per event. When the main thread is busy (a TUI repainting on
 * every scroll step), those events pile up and would each become their own
 * WebSocket message and PTY write. Here the first write goes out at once, so a
 * lone keystroke gets no added latency, and anything written before the event
 * loop comes round again (a posted task, no timer clamp) is joined into
 * messages of up to 4,096 UTF-16 code units. The bytes reaching the PTY and
 * their order are unchanged. A write longer than the limit (a paste) is sent
 * on its own, in order.
 */

/** Longest message built by joining queued writes, in UTF-16 code units. */
export const TERMINAL_INPUT_COALESCE_MAX_CODE_UNITS = 4096;

export interface TerminalInputQueue {
  /** Send `data` now, or join it to the next message when writes are coming
   *  in faster than the event loop turns. `onSent` runs once it is on the
   *  socket; writes dropped because the socket was closed never call it. */
  write(data: string, onSent?: () => void): void;
}

interface QueuedWrite {
  data: string;
  onSent: (() => void) | undefined;
}

let yieldChannel: MessageChannel | null = null;
const yieldCallbacks: (() => void)[] = [];

/** Run `callback` in a new task, after the tasks already queued. Posted
 *  messages skip the ≥4 ms clamp Chromium puts on nested timers. */
function afterQueuedTasks(callback: () => void): void {
  if (!yieldChannel) {
    yieldChannel = new MessageChannel();
    yieldChannel.port1.onmessage = () => yieldCallbacks.shift()?.();
  }
  yieldCallbacks.push(callback);
  yieldChannel.port2.postMessage(null);
}

/** `send` puts one message on the socket and returns false when the socket
 *  isn't open (the data is dropped, as before this queue existed). */
export function createTerminalInputQueue(send: (data: string) => boolean): TerminalInputQueue {
  let pending: QueuedWrite[] = [];
  let coalescing = false;

  const deliver = (data: string, writes: QueuedWrite[]) => {
    if (!send(data)) return;
    for (const write of writes) write.onSent?.();
  };

  const flush = () => {
    const writes = pending;
    pending = [];
    let batch: QueuedWrite[] = [];
    let batchData = "";
    const sendBatch = () => {
      if (batch.length === 0) return;
      deliver(batchData, batch);
      batch = [];
      batchData = "";
    };
    for (const write of writes) {
      if (write.data.length > TERMINAL_INPUT_COALESCE_MAX_CODE_UNITS) {
        sendBatch();
        deliver(write.data, [write]);
        continue;
      }
      if (batchData.length + write.data.length > TERMINAL_INPUT_COALESCE_MAX_CODE_UNITS) {
        sendBatch();
      }
      batch.push(write);
      batchData += write.data;
    }
    sendBatch();
  };

  // Writes keep being joined for as long as each turn of the event loop
  // brings more; the first turn with none ends it.
  const onTurn = () => {
    if (pending.length === 0) {
      coalescing = false;
      return;
    }
    flush();
    afterQueuedTasks(onTurn);
  };

  return {
    write(data, onSent) {
      if (coalescing) {
        pending.push({ data, onSent });
        return;
      }
      deliver(data, [{ data, onSent }]);
      coalescing = true;
      afterQueuedTasks(onTurn);
    },
  };
}
