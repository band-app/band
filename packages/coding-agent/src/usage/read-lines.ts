import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

/**
 * Yield the lines of `file`. Safe to leave early (`break`, `return`, throw):
 * the generator's `finally` destroys the underlying ReadStream.
 *
 * Don't hand-roll `createInterface({ input: createReadStream(file) })` for
 * files read partially. `rl.close()` does not close its input, so every early
 * exit leaks the stream's file descriptor; the Codex usage scan leaked
 * thousands per run until the server failed every spawn with `EBADF`.
 */
export async function* readLines(file: string): AsyncGenerator<string> {
  const input = createReadStream(file);
  const rl = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of rl) yield line;
  } finally {
    rl.close();
    input.destroy();
  }
}
