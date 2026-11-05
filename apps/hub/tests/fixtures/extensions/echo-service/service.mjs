// A worker service for tests, written with the extension SDK. The test helper
// (`helpers/extension-archive.ts`) copies the SDK into ./sdk when it builds the archive.
import { defineWorkerService } from "./sdk/index.mjs";

let init = null;
let closedStreams = 0;
const released = [];

defineWorkerService({
  onInit(i) {
    init = i;
  },
  calls: {
    echo: (params) => params,
    workerId: () => init.worker,
    version: () => init.version,
    pid: () => process.pid,
    // The names of the variables this process was started with, to check nothing leaked in.
    envKeys: () => Object.keys(process.env).sort(),
    execInfo: () => ({ execPath: process.execPath, electron: process.versions.electron ?? null }),
    closedStreams: () => closedStreams,
    released: () => released,
    // Replies, then exits with an error code, to test the restart.
    crash: () => {
      setTimeout(() => process.exit(1), 20);
      return { crashing: true };
    },
    slowEcho: async (params) => {
      await new Promise((r) => setTimeout(r, Number(params?.ms ?? 100)));
      return params;
    },
  },
  streams: {
    // Sends `frames` messages (default 5): text for an even index, bytes for an odd one. A message
    // from the viewer comes back as `echo:<message>`.
    screen: (params, scope, stream) => {
      const frames = Number(params?.frames ?? 5);
      for (let i = 0; i < frames; i++) {
        stream.send(i % 2 === 0 ? `frame-${i}` : Buffer.from([i]));
      }
      if (params?.end) stream.end();
      return {
        onMessage: (m) => stream.send(`echo:${typeof m === "string" ? m : Buffer.from(m).toString("hex")}`),
        onClose: () => {
          closedStreams++;
        },
      };
    },
  },
  onRelease(key, reason) {
    released.push(`${key}:${reason}`);
  },
});
