/**
 * GFM table source model for the markdown preview's table editor.
 *
 * A table is kept as its source lines. Each row is split into the raw text
 * between its pipes, and every edit rewrites only the segments it changes, so
 * the padding, pipe style and alignment markers of untouched cells keep their
 * bytes. The editor turns the old and new lines into minimal document changes.
 */

export type ColumnAlign = "left" | "center" | "right" | null;

/** One table line split at its unescaped pipes. */
export interface TableRowSource {
  /** Whitespace before the first cell or leading pipe. */
  indent: string;
  /** Whether the line starts with a pipe. */
  lead: boolean;
  /** The raw text of each cell, padding included. */
  cells: string[];
  /** Offset of each cell's raw text within the line. */
  cellStarts: number[];
  /** Whether the line ends with a pipe. */
  trail: boolean;
  /** Whitespace after the last cell or trailing pipe. */
  tail: string;
}

export interface TableSource {
  header: TableRowSource;
  delimiter: TableRowSource;
  body: TableRowSource[];
  /** Header cell count; GFM ignores body cells past it and pads short rows. */
  columns: number;
  align: ColumnAlign[];
}

/** A row index in the table model: 0 is the header, 1.. are body rows. */
export type RowIndex = number;

function isEscaped(text: string, i: number): boolean {
  let slashes = 0;
  for (let j = i - 1; j >= 0 && text[j] === "\\"; j--) slashes++;
  return slashes % 2 === 1;
}

export function parseRow(line: string): TableRowSource {
  const indent = /^\s*/.exec(line)?.[0] ?? "";
  const tail = /\s*$/.exec(line.slice(indent.length))?.[0] ?? "";
  const bodyEnd = line.length - tail.length;
  const body = line.slice(indent.length, bodyEnd);
  const pipes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "|" && !isEscaped(body, i)) pipes.push(i);
  }
  const lead = pipes[0] === 0;
  const trail = pipes.length > 0 && pipes[pipes.length - 1] === body.length - 1 && body.length > 1;
  const bounds = [lead ? 0 : -1, ...pipes.filter((p) => p !== 0 || !lead)];
  if (trail) bounds.pop();
  const cells: string[] = [];
  const cellStarts: number[] = [];
  for (let i = 0; i < bounds.length; i++) {
    const start = bounds[i] + 1;
    const end = i + 1 < bounds.length ? bounds[i + 1] : trail ? body.length - 1 : body.length;
    cells.push(body.slice(start, end));
    cellStarts.push(indent.length + start);
  }
  return { indent, lead, cells, cellStarts, trail, tail };
}

export function serializeRow(row: TableRowSource): string {
  // A row that is a single cell with no pipe is not a table row any more.
  const pipes = row.cells.length === 1 && !row.lead && !row.trail;
  const lead = row.lead || pipes;
  const trail = row.trail || pipes;
  return `${row.indent}${lead ? "|" : ""}${row.cells.join("|")}${trail ? "|" : ""}${row.tail}`;
}

function alignOf(raw: string): ColumnAlign {
  const core = raw.trim();
  const left = core.startsWith(":");
  const right = core.length > 1 && core.endsWith(":");
  return left && right ? "center" : left ? "left" : right ? "right" : null;
}

/** Parses the lines of a table: header, delimiter row, then body rows. */
export function parseTable(lines: string[]): TableSource {
  const header = parseRow(lines[0] ?? "");
  const delimiter = parseRow(lines[1] ?? "");
  const body = lines.slice(2).map(parseRow);
  const columns = header.cells.length;
  const align = Array.from({ length: columns }, (_, i) => alignOf(delimiter.cells[i] ?? ""));
  return { header, delimiter, body, columns, align };
}

export function rowAt(table: TableSource, row: RowIndex): TableRowSource {
  return row === 0 ? table.header : table.body[row - 1];
}

/** The lines of the table in document order. */
export function tableLines(table: TableSource): string[] {
  return [table.header, table.delimiter, ...table.body].map(serializeRow);
}

/** A cell's markdown with its padding trimmed; "" for a cell the row lacks. */
export function cellText(table: TableSource, row: RowIndex, col: number): string {
  return (rowAt(table, row).cells[col] ?? "").trim();
}

/**
 * Turns what the user typed into cell markdown: one line, and every pipe that
 * is not already escaped gets a backslash so it does not split the cell.
 */
export function toCellMarkdown(typed: string): string {
  let out = "";
  const text = typed.replace(/\r?\n/g, " ");
  for (let i = 0; i < text.length; i++) {
    out += text[i] === "|" && !isEscaped(text, i) ? "\\|" : text[i];
  }
  return out.trim();
}

function padded(table: TableSource): boolean {
  const first = table.header.cells[0] ?? "";
  return first.length === 0 || /^\s/.test(first);
}

/** Raw text for a new cell, padded like the table's header. */
function newCell(table: TableSource, text: string): string {
  if (padded(table)) return text ? ` ${text} ` : "  ";
  return text || " ";
}

/** Replaces a cell's content, keeping the cell's own padding. */
function withContent(raw: string, text: string): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(raw);
  const pre = m?.[1] ?? "";
  const content = m?.[2] ?? "";
  const post = m?.[3] ?? "";
  if (!content) return text ? ` ${text} ` : raw || " ";
  if (!text) return pre + post || " ";
  return pre + text + post;
}

function padRow(table: TableSource, row: TableRowSource, count: number): string[] {
  const cells = [...row.cells];
  while (cells.length < count) cells.push(newCell(table, ""));
  return cells;
}

function clone(table: TableSource): TableSource {
  const copy = (r: TableRowSource) => ({ ...r, cells: [...r.cells] });
  return {
    header: copy(table.header),
    delimiter: copy(table.delimiter),
    body: table.body.map(copy),
    columns: table.columns,
    align: [...table.align],
  };
}

export function setCell(table: TableSource, row: RowIndex, col: number, text: string): TableSource {
  const next = clone(table);
  const target = rowAt(next, row);
  target.cells = padRow(next, target, col + 1);
  target.cells[col] = withContent(target.cells[col], text);
  return next;
}

/** Inserts an empty body row so that it becomes row `at` (1 = first body row). */
export function insertRow(table: TableSource, at: RowIndex): TableSource {
  const next = clone(table);
  const { header } = next;
  const row: TableRowSource = {
    indent: header.indent,
    lead: header.lead,
    cells: Array.from({ length: next.columns }, () => newCell(next, "")),
    cellStarts: [],
    trail: header.trail,
    tail: "",
  };
  next.body.splice(Math.max(0, at - 1), 0, row);
  return next;
}

export function deleteRow(table: TableSource, row: RowIndex): TableSource {
  if (row < 1) return table;
  const next = clone(table);
  next.body.splice(row - 1, 1);
  return next;
}

function delimiterCell(table: TableSource, align: ColumnAlign, dashes = 3): string {
  const core = `${align === "left" || align === "center" ? ":" : ""}${"-".repeat(Math.max(1, dashes))}${
    align === "right" || align === "center" ? ":" : ""
  }`;
  const sample = table.delimiter.cells[0] ?? "";
  return /^\s/.test(sample) ? ` ${core} ` : core;
}

/** Inserts an empty column so that it becomes column `at`. */
export function insertColumn(table: TableSource, at: number): TableSource {
  const next = clone(table);
  const insert = (row: TableRowSource, cell: string) => {
    row.cells = padRow(next, row, at);
    row.cells.splice(at, 0, cell);
  };
  insert(next.header, newCell(next, ""));
  next.delimiter.cells = next.delimiter.cells.slice(0, next.columns);
  while (next.delimiter.cells.length < at) next.delimiter.cells.push(delimiterCell(next, null));
  next.delimiter.cells.splice(at, 0, delimiterCell(next, null));
  for (const row of next.body) {
    if (row.cells.length >= at) insert(row, newCell(next, ""));
  }
  next.columns += 1;
  next.align.splice(at, 0, null);
  return next;
}

export function deleteColumn(table: TableSource, col: number): TableSource {
  if (table.columns <= 1) return table;
  const next = clone(table);
  for (const row of [next.header, next.delimiter, ...next.body]) {
    if (col < row.cells.length) row.cells.splice(col, 1);
  }
  next.columns -= 1;
  next.align.splice(col, 1);
  return next;
}

export function setAlign(table: TableSource, col: number, align: ColumnAlign): TableSource {
  const next = clone(table);
  const raw = next.delimiter.cells[col] ?? "";
  const dashes = (raw.match(/-/g) ?? []).length || 3;
  const pre = /^\s*/.exec(raw)?.[0] ?? "";
  const post = /\s*$/.exec(raw)?.[0] ?? "";
  const core = delimiterCell(
    { ...next, delimiter: { ...next.delimiter, cells: [] } },
    align,
    dashes,
  );
  next.delimiter.cells = padRow(next, next.delimiter, col + 1);
  next.delimiter.cells[col] = raw ? pre + core + post : delimiterCell(next, align, dashes);
  next.align[col] = align;
  return next;
}
