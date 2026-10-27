export type ByteRange = { start: number; end: number };

/**
 * Reads a single-range `Range: bytes=...` header against a file of `size`
 * bytes. Returns null when there is no usable header (serve the whole file),
 * "unsatisfiable" when the range lies outside the file, else inclusive bounds.
 * A multi-range request is served whole, which the spec allows.
 */
export function parseByteRange(
  header: string | undefined,
  size: number,
): ByteRange | "unsatisfiable" | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "");
  if (!match || (match[1] === "" && match[2] === "")) return null;
  // RFC 9110: a range whose end precedes its start is invalid and ignored.
  if (match[1] !== "" && match[2] !== "" && Number(match[2]) < Number(match[1])) return null;
  let start: number;
  let end: number;
  if (match[1] === "") {
    // A suffix range: the last N bytes.
    const length = Number(match[2]);
    if (length === 0) return "unsatisfiable";
    start = Math.max(0, size - length);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}
