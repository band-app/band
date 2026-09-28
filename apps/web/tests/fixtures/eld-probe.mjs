// DIAGNOSTIC (temporary): loaded with `node --import` into the server and the
// terminal daemon. Appends every main-thread event-loop stall over 20 ms to
// $BAND_DIAG_ELD_FILE with an epoch timestamp, so stalls can be lined up with
// slow echoes across processes.
import { appendFileSync } from "node:fs";
import { isMainThread } from "node:worker_threads";

const file = process.env.BAND_DIAG_ELD_FILE;
if (file && isMainThread) {
  const tag = `${process.pid}:${(process.argv[1] ?? "").split("/").pop()}`;
  const TICK = 5;
  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    const lag = now - last - TICK;
    last = now;
    if (lag > 20) {
      appendFileSync(
        file,
        `${JSON.stringify({ tag, end: performance.timeOrigin + now, lag: Math.round(lag) })}\n`,
      );
    }
  }, TICK).unref();
}
