import { createLogger } from "@band-app/logger";
import { ConfigError, parseConfig, usage } from "./config.ts";
import { Worker } from "./worker.ts";

const log = createLogger("band-worker");
const argv = process.argv.slice(2);

if (argv.includes("--help") || argv.includes("-h")) {
  process.stdout.write(usage());
  process.exit(0);
}

// Handlers go in before the worker starts, so a signal during the handshake still ends the process cleanly.
let worker: Worker | undefined;
let stopRequested = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    stopRequested = true;
    void worker?.stop(0);
  });
}

try {
  const config = parseConfig(argv);
  // Agents and terminals inherit this process's environment, so the worker's token must not stay in it.
  delete process.env.BAND_WORKER_TOKEN;
  delete process.env.BAND_BOOTSTRAP_TOKEN;
  worker = await Worker.start(config);
} catch (err) {
  if (err instanceof ConfigError) {
    process.stderr.write(`band-worker: ${err.message}\n\n${usage()}`);
    process.exit(2);
  }
  // The message only. Errors from the network and the hub can carry request details.
  log.error(
    { message: err instanceof Error ? err.message : String(err) },
    "worker failed to start",
  );
  process.exit(1);
}

if (stopRequested) void worker.stop(0);
process.exit(await worker.exited);
