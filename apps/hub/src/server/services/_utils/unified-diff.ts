/** A unified diff of two texts, for showing a proposed edit. Pure, with no git or file access. */

type Op = { t: " " | "-" | "+"; line: string };

/** Above this many table cells the diff is a plain replacement, to bound memory. */
const MAX_CELLS = 4_000_000;

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function diffOps(a: string[], b: string[]): Op[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }
  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);
  const ops: Op[] = a.slice(0, head).map((line) => ({ t: " ", line }));
  if ((x.length + 1) * (y.length + 1) > MAX_CELLS) {
    for (const line of x) ops.push({ t: "-", line });
    for (const line of y) ops.push({ t: "+", line });
  } else {
    // Longest common subsequence of the middle, filled from the end so the walk below runs forward.
    const w = y.length + 1;
    const table = new Uint32Array((x.length + 1) * w);
    for (let i = x.length - 1; i >= 0; i--) {
      for (let j = y.length - 1; j >= 0; j--) {
        table[i * w + j] =
          x[i] === y[j]
            ? (table[(i + 1) * w + j + 1] as number) + 1
            : Math.max(table[(i + 1) * w + j] as number, table[i * w + j + 1] as number);
      }
    }
    let i = 0;
    let j = 0;
    while (i < x.length && j < y.length) {
      if (x[i] === y[j]) {
        ops.push({ t: " ", line: x[i] as string });
        i++;
        j++;
      } else if ((table[(i + 1) * w + j] as number) >= (table[i * w + j + 1] as number)) {
        ops.push({ t: "-", line: x[i++] as string });
      } else {
        ops.push({ t: "+", line: y[j++] as string });
      }
    }
    while (i < x.length) ops.push({ t: "-", line: x[i++] as string });
    while (j < y.length) ops.push({ t: "+", line: y[j++] as string });
  }
  for (const line of a.slice(a.length - tail)) ops.push({ t: " ", line });
  return ops;
}

/** The diff from `before` to `after` for `path`, or an empty string when they are equal. */
export function unifiedDiff(path: string, before: string, after: string, context = 3): string {
  if (before === after) return "";
  const ops = diffOps(splitLines(before), splitLines(after));
  const changed: number[] = [];
  const oldAt: number[] = [];
  const newAt: number[] = [];
  let o = 0;
  let n = 0;
  ops.forEach((op, i) => {
    oldAt.push(o);
    newAt.push(n);
    if (op.t !== "+") o++;
    if (op.t !== "-") n++;
    if (op.t !== " ") changed.push(i);
  });
  if (changed.length === 0) return "";
  const spans: Array<[number, number]> = [];
  let start = changed[0] as number;
  let end = start;
  for (const i of changed.slice(1)) {
    if (i - end - 1 <= 2 * context) {
      end = i;
    } else {
      spans.push([start, end]);
      start = i;
      end = i;
    }
  }
  spans.push([start, end]);

  const out = [`--- a/${path}`, `+++ b/${path}`];
  for (const [s, e] of spans) {
    const from = Math.max(0, s - context);
    const to = Math.min(ops.length - 1, e + context);
    const slice = ops.slice(from, to + 1);
    const oldCount = slice.filter((op) => op.t !== "+").length;
    const newCount = slice.filter((op) => op.t !== "-").length;
    const oldStart = oldCount === 0 ? (oldAt[from] as number) : (oldAt[from] as number) + 1;
    const newStart = newCount === 0 ? (newAt[from] as number) : (newAt[from] as number) + 1;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const op of slice) out.push(`${op.t}${op.line}`);
  }
  return out.join("\n");
}
