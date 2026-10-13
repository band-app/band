import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import pino from "pino";

export type Logger = pino.Logger;

export const DEFAULT_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_LOG_KEEP = 3;

/**
 * Appends to `path` and, once the file would pass `maxBytes`, shifts it to `path.1`
 * (`path.1` to `path.2`, and so on). At most `keep` files exist, the live one included.
 * A file already past the limit when the writer opens is rotated first.
 */
export class RotatingFile {
  private fd: number | undefined;
  private size = 0;

  constructor(
    private readonly path: string,
    private readonly maxBytes = DEFAULT_LOG_MAX_BYTES,
    private readonly keep = DEFAULT_LOG_KEEP,
  ) {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path) && statSync(path).size >= maxBytes) this.shift();
    this.open();
  }

  write(chunk: string | Uint8Array): void {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (this.fd === undefined) return;
    if (this.size > 0 && this.size + buf.length > this.maxBytes) {
      this.close();
      this.shift();
      this.open();
    }
    if (this.fd === undefined) return;
    try {
      writeSync(this.fd, buf);
      this.size += buf.length;
    } catch {
      // A full disk or a vanished directory must not take the worker down.
    }
  }

  close(): void {
    if (this.fd === undefined) return;
    try {
      closeSync(this.fd);
    } catch {
      // Already closed.
    }
    this.fd = undefined;
  }

  private open(): void {
    try {
      this.fd = openSync(this.path, "a", 0o600);
      this.size = statSync(this.path).size;
    } catch {
      this.fd = undefined;
    }
  }

  private shift(): void {
    try {
      const oldest = this.keep - 1;
      if (oldest < 1) {
        rmSync(this.path, { force: true });
        return;
      }
      rmSync(`${this.path}.${oldest}`, { force: true });
      for (let i = oldest - 1; i >= 1; i--) {
        if (existsSync(`${this.path}.${i}`))
          renameSync(`${this.path}.${i}`, `${this.path}.${i + 1}`);
      }
      renameSync(this.path, `${this.path}.1`);
    } catch {
      // Leave the files as they are; the next write tries again.
    }
  }
}

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
