import pino from "pino";
import { DEFAULT_LOG_KEEP, DEFAULT_LOG_MAX_BYTES, RotatingFile } from "./rotating-file.ts";

export type Logger = pino.Logger;

let file: RotatingFile | undefined;

/**
 * With `BAND_LOG_FILE` set, everything the process logs or prints goes to that file, rotated at
 * `BAND_LOG_MAX_BYTES` (default 10 MB) with `BAND_LOG_KEEP` files kept (default 3). The worker
 * service sets it, because launchd's own log file cannot rotate.
 */
function logFile(): RotatingFile | undefined {
  if (file) return file;
  const path = process.env.BAND_LOG_FILE;
  if (!path) return undefined;
  const max = Number(process.env.BAND_LOG_MAX_BYTES);
  const keep = Number(process.env.BAND_LOG_KEEP);
  const target = new RotatingFile(
    path,
    max > 0 ? max : DEFAULT_LOG_MAX_BYTES,
    keep >= 1 ? keep : DEFAULT_LOG_KEEP,
  );
  for (const stream of [process.stdout, process.stderr]) {
    stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      target.write(chunk);
      const cb = rest.find((r) => typeof r === "function") as (() => void) | undefined;
      cb?.();
      return true;
    }) as typeof stream.write;
  }
  file = target;
  return target;
}

export function createLogger(name: string): Logger {
  const options = { name, level: process.env.LOG_LEVEL || "info" };
  const target = logFile();
  return target ? pino(options, { write: (line: string) => target.write(line) }) : pino(options);
}
