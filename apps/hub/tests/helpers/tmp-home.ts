import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** Every path under `dir` with its mtime, for failure messages. */
export function listFiles(dir: string): string {
  const lines: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      lines.push(`${statSync(p, { throwIfNoEntry: false })?.mtime.toISOString() ?? "gone"} ${p}`);
      if (e.isDirectory()) walk(p);
    }
  };
  try {
    walk(dir);
  } catch {
    // The dir vanished or changed mid-walk; list what was seen.
  }
  return lines.join("\n");
}

/**
 * Delete a test's tmp home. ENOTEMPTY means a process was still writing into
 * it, so the error names the files that were left, which shows the writer.
 * Stop every process that uses the home before calling this.
 */
export function removeTmpHome(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (err) {
    throw new Error(`could not remove ${dir}: ${(err as Error).message}\n${listFiles(dir)}`, {
      cause: err,
    });
  }
}
