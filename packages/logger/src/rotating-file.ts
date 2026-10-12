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
