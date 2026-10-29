/**
 * Output of one agent stream, kept from the last acknowledged offset. Offsets count bytes since
 * the process started, so a reader that was away asks for "everything after N".
 */
export class OutputRing {
  /** Offset of the first retained byte. */
  private base = 0;
  private end = 0;
  private chunks: Buffer[] = [];

  /** Bytes held, which are the ones nobody has acknowledged. */
  get held(): number {
    return this.end - this.base;
  }

  /** Offset the next byte gets. */
  get next(): number {
    return this.end;
  }

  /** Stores `chunk` and returns the offset of its first byte. */
  push(chunk: Buffer): number {
    const at = this.end;
    this.chunks.push(chunk);
    this.end += chunk.length;
    return at;
  }

  /** Drops everything before `offset`. An offset past the end drops everything held. */
  ack(offset: number): void {
    const target = Math.min(offset, this.end);
    while (this.base < target && this.chunks.length > 0) {
      const first = this.chunks[0] as Buffer;
      if (this.base + first.length <= target) {
        this.chunks.shift();
        this.base += first.length;
      } else {
        this.chunks[0] = first.subarray(target - this.base);
        this.base = target;
      }
    }
  }

  /** The held bytes from `offset` on, as chunks with their offsets. */
  from(offset: number): { off: number; data: Buffer }[] {
    const out: { off: number; data: Buffer }[] = [];
    let at = this.base;
    for (const chunk of this.chunks) {
      if (at + chunk.length > offset) {
        const skip = Math.max(0, offset - at);
        out.push({ off: at + skip, data: chunk.subarray(skip) });
      }
      at += chunk.length;
    }
    return out;
  }
}
