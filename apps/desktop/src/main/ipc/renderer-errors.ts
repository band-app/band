/**
 * `report_renderer_error`: the web UI reports an uncaught error or unhandled
 * promise rejection, and main writes it to ~/.band/desktop.log under the
 * "renderer" logger. Pure over a logger and a clock, so tests need no Electron.
 */

export interface RendererErrorReport {
  message?: unknown;
  stack?: unknown;
  url?: unknown;
  kind?: unknown;
}

interface ReporterLog {
  error(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

const MAX_FIELD_CHARS = 8 * 1024;
const MAX_PER_WINDOW = 20;
const WINDOW_MS = 60_000;
const MAX_TRACKED_MESSAGES = 200;

/** Replaces the value of any `token=` query parameter, so a hub token in a URL never reaches the log. */
export function redactTokens(text: string): string {
  return text.replace(/([?&#;]token=)[^&#\s"'<>)]*/gi, "$1[redacted]");
}

function clean(value: unknown): string {
  const text = typeof value === "string" ? value : value == null ? "" : String(value);
  const redacted = redactTokens(text);
  return redacted.length > MAX_FIELD_CHARS
    ? `${redacted.slice(0, MAX_FIELD_CHARS)}... [truncated ${redacted.length - MAX_FIELD_CHARS} chars]`
    : redacted;
}

interface Bucket {
  windowStart: number;
  count: number;
  suppressed: number;
}

export function createRendererErrorReporter(log: ReporterLog, now: () => number = Date.now) {
  const buckets = new Map<string, Bucket>();

  return function reportError(report: RendererErrorReport | undefined): void {
    const message = clean(report?.message);
    const t = now();
    // Key on the message so one render loop cannot starve other errors.
    const key = message.slice(0, 500);
    // Flush every expired window, so a "suppressed N" line is written even when
    // that message never repeats.
    for (const [k, b] of buckets) {
      if (t - b.windowStart < WINDOW_MS) continue;
      if (b.suppressed > 0) {
        log.warn(
          { message: k.slice(0, 200) },
          `suppressed ${b.suppressed} repeated renderer errors`,
        );
      }
      buckets.delete(k);
    }
    let bucket = buckets.get(key);
    if (!bucket) {
      if (buckets.size >= MAX_TRACKED_MESSAGES) buckets.clear();
      bucket = { windowStart: t, count: 0, suppressed: 0 };
      buckets.set(key, bucket);
    }
    if (bucket.count >= MAX_PER_WINDOW) {
      bucket.suppressed += 1;
      return;
    }
    bucket.count += 1;
    log.error(
      {
        kind: report?.kind === "unhandledrejection" ? "unhandledrejection" : "error",
        message,
        stack: clean(report?.stack),
        url: clean(report?.url),
      },
      "renderer error",
    );
  };
}
