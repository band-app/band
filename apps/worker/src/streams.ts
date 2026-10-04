import type { Channel } from "@band-app/link";

export type CloseKind = "ended" | "reset";

export interface ServeOptions {
  /** Called once every loop on the channel is done. */
  release: () => void;
  /** Hub-to-worker bytes. Without it they are dropped. */
  onInput?: (chunk: Buffer) => void;
  /** The hub ended its side, reset the channel, or the link session died. */
  onClosed?: (how: CloseKind) => void;
  /**
   * When the hub closing its side also stops reading `source`. A reset always
   * does. Defaults to "any". A process that keeps talking after its stdin
   * closes needs "reset".
   */
  stopSourceOn?: "any" | "reset";
}

/**
 * Connects a channel to a byte source. The source's bytes go to the hub, with
 * the channel's credit slowing the source down. The hub's bytes go to
 * `onInput`. The channel ends when the source does, and the source stops when
 * the hub closes the channel.
 */
export function serve(
  ch: Channel,
  source: AsyncIterable<Uint8Array> | undefined,
  opts: ServeOptions,
): void {
  const it = source?.[Symbol.asyncIterator]();
  const stopSource = () => {
    // The iterator may already be done, and some stop by throwing.
    Promise.resolve(it?.return?.()).catch(() => undefined);
  };
  let remaining = it ? 2 : 1;
  const loopDone = () => {
    if (--remaining === 0) opts.release();
  };

  void (async () => {
    let how: CloseKind = "ended";
    try {
      for await (const chunk of ch) opts.onInput?.(chunk);
    } catch {
      how = "reset";
    }
    opts.onClosed?.(how);
    if (how === "reset" || (opts.stopSourceOn ?? "any") === "any") stopSource();
    loopDone();
  })();

  if (it) {
    void (async () => {
      try {
        for (;;) {
          const next = await it.next();
          if (next.done) break;
          await ch.send(next.value);
        }
        ch.end();
      } catch (err) {
        ch.reset(err instanceof Error ? err.message : "stream failed");
        stopSource();
      }
      loopDone();
    })();
  }
}

/** One JSON value per line, for streams of records. */
export async function* ndjson<T>(source: AsyncIterable<T>): AsyncGenerator<Uint8Array> {
  for await (const item of source) yield Buffer.from(`${JSON.stringify(item)}\n`);
}
