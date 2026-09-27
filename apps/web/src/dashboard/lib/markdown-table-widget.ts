/**
 * Editable grids for the markdown live preview: GFM tables, and the YAML
 * frontmatter block as a Key / Value grid.
 *
 * A cell shows its rendered text until it is focused, then its raw markdown
 * (or YAML value). Every keystroke rewrites only that cell in the document,
 * and row / column / alignment edits rewrite only the lines or pipe segments
 * they change (`markdown-table.ts`, `markdown-frontmatter.ts`), so the file
 * keeps the form it was written in and undo goes through the editor's
 * history. Each grid sits in a frame whose toolbar copies the data (Markdown,
 * CSV, TSV) or downloads it (CSV, Markdown).
 *
 * Interaction:
 * - Click a cell to edit it. Tab / Shift+Tab move across cells; Tab on the
 *   last cell adds a row. Enter moves down and adds a row below the last one;
 *   Shift+Enter moves up. Arrow keys cross cell edges, and Up from the header,
 *   Down from the last row or Escape leave the table.
 * - Hovering a header shows a column grip (alignment, insert, delete);
 *   hovering a row shows a row grip (insert, delete). The "+" bars at the
 *   right and bottom edges add a column or a row at the end.
 * - Right-clicking a cell opens both sets of actions plus "Edit as markdown",
 *   which puts the editor cursor in the table to show its source.
 * - Frontmatter has fixed Key / Value headers and no column actions; its rows
 *   are properties. Values that span lines (lists, nested maps, block
 *   scalars) stay read-only here and are edited as markdown.
 *
 * The widget ignores editor events, so CodeMirror neither handles keys typed
 * in a cell nor reads the DOM selection inside it; the keys the editor would
 * otherwise own (save, undo, redo) are forwarded from the cell, and
 * select-all is kept inside the cell.
 */

import { redo, undo } from "@codemirror/commands";
import type { syntaxTree } from "@codemirror/language";
import type { EditorState, Text } from "@codemirror/state";
import { type EditorView, WidgetType } from "@codemirror/view";
import {
  deleteEntry,
  insertEntry,
  parseFrontmatterBlock,
  setKey,
  setValue,
} from "./markdown-frontmatter";
import {
  type ColumnAlign,
  cellText,
  deleteColumn,
  deleteRow,
  insertColumn,
  insertRow,
  parseRow,
  parseTable,
  type RowIndex,
  setAlign,
  setCell,
  type TableSource,
  tableLines,
  toCellMarkdown,
} from "./markdown-table";

export type SyntaxNode = ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]>;

/** Inline markdown of a cell, pre-parsed from the document's syntax tree. */
export type Inline = string | { tag: "strong" | "em" | "del" | "code" | "a"; children: Inline[] };

const TAGS: Record<string, "strong" | "em" | "del" | "code" | "a"> = {
  StrongEmphasis: "strong",
  Emphasis: "em",
  Strikethrough: "del",
  InlineCode: "code",
  Link: "a",
  Autolink: "a",
};

const MARKS = new Set([
  "EmphasisMark",
  "CodeMark",
  "StrikethroughMark",
  "LinkMark",
  "LinkTitle",
  "LinkLabel",
  "TableDelimiter",
]);

function inlineOf(doc: Text, node: SyntaxNode, from: number, to: number): Inline[] {
  const out: Inline[] = [];
  const text = (a: number, b: number) => {
    if (b > a) out.push(doc.sliceString(a, b));
  };
  let pos = from;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.to <= from || child.from >= to) continue;
    const { name } = child;
    const inLink = node.name === "Link" || node.name === "Image";
    if (MARKS.has(name) || (name === "URL" && inLink)) {
      text(pos, child.from);
      pos = child.to;
    } else if (name === "Escape") {
      text(pos, child.from);
      out.push(doc.sliceString(child.from + 1, child.to));
      pos = child.to;
    } else if (TAGS[name] || name === "URL") {
      text(pos, child.from);
      const tag = TAGS[name] ?? "a";
      const children: Inline[] =
        tag === "code"
          ? inlineOf(doc, child, child.from, child.to).map((c) =>
              typeof c === "string" ? c.replace(/\\\|/g, "|") : c,
            )
          : inlineOf(doc, child, child.from, child.to);
      out.push({ tag, children });
      pos = child.to;
    } else {
      text(pos, child.from);
      out.push(...inlineOf(doc, child, child.from, child.to));
      pos = child.to;
    }
  }
  text(pos, to);
  return out;
}

/** Each row's cells (header first, delimiter row skipped) as inline markdown. */
function tableInline(state: EditorState, table: SyntaxNode): Inline[][][] {
  const { doc } = state;
  const firstLine = doc.lineAt(table.from).number;
  const rows: Inline[][][] = [];
  for (let row = table.firstChild; row; row = row.nextSibling) {
    if (row.name !== "TableHeader" && row.name !== "TableRow") continue;
    const line = doc.lineAt(row.from);
    const index = line.number - firstLine;
    const starts = parseRow(line.text).cellStarts;
    const cells: Inline[][] = [];
    for (let cell = row.firstChild; cell; cell = cell.nextSibling) {
      if (cell.name !== "TableCell") continue;
      const offset = cell.from - line.from;
      let col = 0;
      while (col + 1 < starts.length && starts[col + 1] <= offset) col++;
      cells[col] = inlineOf(doc, cell, cell.from, cell.to);
    }
    rows[index === 0 ? 0 : index - 1] = cells;
  }
  return rows;
}

function renderInline(parent: HTMLElement, nodes: Inline[] | undefined): void {
  parent.replaceChildren();
  const add = (into: Node, list: Inline[]) => {
    for (const n of list) {
      if (typeof n === "string") {
        into.appendChild(document.createTextNode(n));
      } else {
        const el = document.createElement(n.tag === "a" ? "span" : n.tag);
        el.className = n.tag === "a" ? "cm-md-link" : `cm-md-table-${n.tag}`;
        add(el, n.children);
        into.appendChild(el);
      }
    }
  };
  add(parent, nodes ?? []);
}

function plainText(nodes: Inline[] | undefined): string {
  return (nodes ?? []).map((n) => (typeof n === "string" ? n : plainText(n.children))).join("");
}

// ---------------------------------------------------------------------------
// Grid models
// ---------------------------------------------------------------------------
//
// The editor works on a model rebuilt from the block's source after every
// change. Edits return the block's new source (null when the edit cannot be
// written, for example an invalid frontmatter key); the editor turns that
// into a minimal document change.

type BlockKind = "table" | "frontmatter";

interface ColumnOps {
  insert(at: number): string;
  delete(col: number): string | null;
  align(col: number, align: ColumnAlign): string;
}

interface GridModel {
  columns: number;
  /** Body rows; row indexes are 1..bodyRows, 0 is the header. */
  bodyRows: number;
  align: ColumnAlign[];
  /** What a row is called in labels: "row" or "property". */
  noun: string;
  /** The text a cell shows while it is edited. */
  text(row: RowIndex, col: number): string;
  /** The rendered text a cell shows otherwise. */
  display(row: RowIndex, col: number): Inline[];
  canEdit(row: RowIndex, col: number): boolean;
  /** What the typed text is written as, for comparing with `text`. */
  normalize(typed: string): string;
  setCell(row: RowIndex, col: number, typed: string): string | null;
  /** Inserts an empty body row so that it becomes row `at`. */
  insertRow(at: RowIndex): string | null;
  deleteRow(row: RowIndex): string | null;
  canDeleteRow(row: RowIndex): boolean;
  /** Where the caret goes in a new row's first cell. */
  newRowCaret: Caret;
  columnOps: ColumnOps | null;
  markdown(): string;
  /** Plain-text cells, header row first. */
  plainRows(): string[][];
}

function tableModel(source: string, inline: () => Inline[][][]): GridModel {
  const table: TableSource = parseTable(source.split("\n"));
  const write = (next: TableSource) => tableLines(next).join("\n");
  return {
    columns: table.columns,
    bodyRows: table.body.length,
    align: table.align,
    noun: "row",
    text: (row, col) => cellText(table, row, col),
    display: (row, col) => inline()[row]?.[col] ?? [],
    canEdit: () => true,
    normalize: toCellMarkdown,
    setCell: (row, col, typed) => write(setCell(table, row, col, toCellMarkdown(typed))),
    insertRow: (at) => write(insertRow(table, at)),
    deleteRow: (row) => write(deleteRow(table, row)),
    canDeleteRow: (row) => row > 0,
    newRowCaret: "end",
    columnOps: {
      insert: (at) => write(insertColumn(table, at)),
      delete: (col) => (table.columns > 1 ? write(deleteColumn(table, col)) : null),
      align: (col, align) => write(setAlign(table, col, align)),
    },
    markdown: () => source,
    plainRows() {
      const rows = inline();
      return Array.from({ length: table.body.length + 1 }, (_, row) =>
        Array.from({ length: table.columns }, (_, col) => plainText(rows[row]?.[col])),
      );
    },
  };
}

const FRONTMATTER_HEADERS = ["Key", "Value"];

function frontmatterModel(source: string): GridModel {
  const fm = parseFrontmatterBlock(source);
  const cell = (row: RowIndex, col: number) => {
    if (row === 0) return FRONTMATTER_HEADERS[col];
    const entry = fm.entries[row - 1];
    return (col === 0 ? entry?.key : entry?.value) ?? "";
  };
  const escapeCell = (text: string) => text.replace(/\|/g, "\\|");
  return {
    columns: 2,
    bodyRows: fm.entries.length,
    align: [null, null],
    noun: "property",
    text: cell,
    display: (row, col) => [cell(row, col)],
    canEdit: (row, col) => row > 0 && (col === 0 || fm.entries[row - 1]?.readOnly === false),
    normalize: (typed) => typed.replace(/\r?\n/g, " ").trim(),
    setCell(row, col, typed) {
      const text = typed.replace(/\r?\n/g, " ").trim();
      return col === 0 ? setKey(fm, row - 1, text) : setValue(fm, row - 1, text);
    },
    insertRow: (at) => insertEntry(fm, at - 1),
    deleteRow: (row) => deleteEntry(fm, row - 1),
    canDeleteRow: (row) => row > 0 && deleteEntry(fm, row - 1) != null,
    newRowCaret: "all",
    columnOps: null,
    markdown: () =>
      [
        "| Key | Value |",
        "| --- | --- |",
        ...fm.entries.map((e) => `| ${escapeCell(e.key)} | ${escapeCell(e.value)} |`),
      ].join("\n"),
    plainRows: () => [FRONTMATTER_HEADERS, ...fm.entries.map((e) => [e.key, e.value])],
  };
}

function toDelimited(rows: string[][], separator: "," | "\t"): string {
  const field =
    separator === ","
      ? (text: string) => (/[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text)
      : (text: string) => text.replace(/[\t\r\n]+/g, " ");
  return rows.map((row) => row.map(field).join(separator)).join("\n");
}

// ---------------------------------------------------------------------------
// Widget
// ---------------------------------------------------------------------------

interface TableWidgetOptions {
  onSave?: () => void;
}

const editors = new WeakMap<HTMLElement, TableEditor>();

export class TableWidget extends WidgetType {
  private cells: Inline[][][] | null = null;

  constructor(
    readonly kind: BlockKind,
    readonly source: string,
    private readonly state: EditorState,
    private readonly node: SyntaxNode | null,
    readonly readOnly: boolean,
    readonly options: TableWidgetOptions,
  ) {
    super();
  }

  /**
   * Each table cell's inline markdown. Built on first use: the preview makes
   * a new widget for every table on each edit, but only a table whose source
   * changed (`eq` fails) is drawn and needs it.
   */
  get inline(): Inline[][][] {
    this.cells ??= this.node ? tableInline(this.state, this.node) : [];
    return this.cells;
  }

  model(): GridModel {
    return this.kind === "table"
      ? tableModel(this.source, () => this.inline)
      : frontmatterModel(this.source);
  }

  eq(other: TableWidget): boolean {
    return (
      other.kind === this.kind && other.source === this.source && other.readOnly === this.readOnly
    );
  }
  toDOM(view: EditorView): HTMLElement {
    const editor = new TableEditor(view, this);
    editors.set(editor.dom, editor);
    return editor.dom;
  }
  updateDOM(dom: HTMLElement, _view: EditorView, from: TableWidget): boolean {
    const editor = editors.get(dom);
    if (!editor || from.kind !== this.kind) return false;
    editor.update(this);
    return true;
  }
  destroy(dom: HTMLElement): void {
    editors.get(dom)?.destroy();
    editors.delete(dom);
  }
  ignoreEvent(): boolean {
    return true;
  }
}

/** The table widget for the `Table` syntax node spanning lines `[from, to]`. */
export function tableWidget(
  state: EditorState,
  node: SyntaxNode,
  from: number,
  to: number,
  options: TableWidgetOptions,
): TableWidget {
  const source = state.doc.sliceString(from, to);
  return new TableWidget("table", source, state, node, state.readOnly, options);
}

/** The Key / Value grid for the frontmatter block spanning `[from, to]`. */
export function frontmatterWidget(
  state: EditorState,
  from: number,
  to: number,
  options: TableWidgetOptions,
): TableWidget {
  const source = state.doc.sliceString(from, to);
  return new TableWidget("frontmatter", source, state, null, state.readOnly, options);
}

type Caret = "start" | "end" | "all" | number;

interface MenuItem {
  label: string;
  run: () => void;
  checked?: boolean;
  disabled?: boolean;
}

const ALIGN_LABELS: Array<[Exclude<ColumnAlign, null>, string]> = [
  ["left", "Align left"],
  ["center", "Align center"],
  ["right", "Align right"],
];

// Lucide icons (ISC licence), the set Streamdown's block controls use.
const svg = (paths: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const COPY_ICON = svg(
  '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
);
const DOWNLOAD_ICON = svg(
  '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
);
const CHECK_ICON = svg('<path d="M20 6 9 17l-5-5"/>');

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

class TableEditor {
  readonly dom: HTMLElement;
  private model: GridModel;
  private menu: { el: HTMLElement; close: () => void } | null = null;
  private pendingFocus: { row: RowIndex; col: number; caret: Caret } | null = null;
  /** Restores the copy button's icon after the check mark. */
  private copiedTimer: ReturnType<typeof setTimeout> | undefined;
  /** The cell elements by row and column, filled by `render`. */
  private cells: HTMLElement[][] = [];

  constructor(
    private readonly view: EditorView,
    private widget: TableWidget,
  ) {
    this.model = widget.model();
    this.dom = document.createElement("div");
    this.dom.className = `cm-md-block cm-md-block--${widget.kind} cm-md-grid`;
    this.dom.dataset.testid = `markdown-preview__block--${widget.kind}`;
    this.dom.addEventListener("mousedown", (e) => this.onRootMouseDown(e));
    this.render();
  }

  private get lastRow(): RowIndex {
    return this.model.bodyRows;
  }

  private get editable(): boolean {
    return !this.widget.readOnly;
  }

  update(widget: TableWidget): void {
    const prev = this.model;
    const prevWidget = this.widget;
    this.widget = widget;
    this.model = widget.model();
    const next = this.model;
    const sameShape =
      prev.columns === next.columns &&
      prev.bodyRows === next.bodyRows &&
      prev.align.join() === next.align.join() &&
      prevWidget.readOnly === widget.readOnly;
    if (!sameShape || this.pendingFocus) {
      const focused = this.focusedCell();
      this.render();
      const target = this.pendingFocus ?? (focused && { ...focused, caret: "end" as Caret });
      this.pendingFocus = null;
      // This runs inside the editor's update; focusing dispatches, so wait
      // until the update has finished.
      if (target) {
        queueMicrotask(() =>
          this.focusCell(
            Math.min(target.row, this.lastRow),
            Math.min(target.col, next.columns - 1),
            target.caret,
          ),
        );
      }
      return;
    }
    for (let row = 0; row <= this.lastRow; row++) {
      for (let col = 0; col < next.columns; col++) {
        const el = this.cellEl(row, col);
        if (!el) continue;
        const text = next.text(row, col);
        if (el.dataset.editing === "true") {
          // The focused cell already shows what the user typed; only replace
          // it when the document changed under it (undo, redo).
          if (next.normalize(el.textContent ?? "") !== text) {
            el.textContent = text;
            placeCaret(el, "end");
          }
        } else if (text !== prev.text(row, col)) {
          // A cell's rendered text follows from its text alone.
          renderInline(el, next.display(row, col));
        }
        if (next.canEdit(row, col) !== prev.canEdit(row, col)) this.setEditable(el, row, col);
      }
    }
  }

  destroy(): void {
    this.menu?.close();
    clearTimeout(this.copiedTimer);
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private render(): void {
    this.menu?.close();
    const { model, editable } = this;
    const noun = capitalize(model.noun);
    const table = document.createElement("table");
    table.className = "cm-md-table";
    const thead = table.createTHead();
    const tbody = table.createTBody();
    this.cells = [];
    for (let row = 0; row <= this.lastRow; row++) {
      const tr = (row === 0 ? thead : tbody).insertRow();
      this.cells.push([]);
      for (let col = 0; col < model.columns; col++) {
        const cell = document.createElement(row === 0 ? "th" : "td");
        const align = model.align[col];
        if (align) cell.style.textAlign = align;
        const content = this.createCell(row, col);
        this.cells[row].push(content);
        cell.appendChild(content);
        if (editable && row === 0 && model.columnOps) {
          cell.appendChild(
            this.createButton(
              "cm-md-table-grip cm-md-table-grip--col",
              `Column ${col + 1} options`,
              "⋯",
              (b) => this.openColumnMenu(col, b.getBoundingClientRect()),
            ),
          );
        }
        if (editable && row > 0 && col === 0) {
          cell.appendChild(
            this.createButton(
              "cm-md-table-grip cm-md-table-grip--row",
              `${noun} ${row} options`,
              "⋮",
              (b) => this.openRowMenu(row, b.getBoundingClientRect()),
            ),
          );
        }
        tr.appendChild(cell);
      }
    }
    const frame = document.createElement("div");
    frame.className = "cm-md-table-frame";
    frame.appendChild(table);
    // The handlers read `this.model` when clicked: typing into a cell
    // replaces the model without redrawing the table.
    if (editable && model.columnOps) {
      frame.appendChild(
        this.createButton("cm-md-table-add cm-md-table-add--col", "Add column", "+", () => {
          const cols = this.model.columns;
          const ops = this.model.columnOps;
          if (ops) this.apply(ops.insert(cols), { row: 0, col: cols, caret: "end" });
        }),
      );
    }
    if (editable) {
      frame.appendChild(
        this.createButton("cm-md-table-add cm-md-table-add--row", `Add ${model.noun}`, "+", () =>
          this.addRowAfter(this.lastRow, 0),
        ),
      );
    }
    const scroll = document.createElement("div");
    scroll.className = "cm-md-table-scroll";
    scroll.appendChild(frame);
    this.dom.replaceChildren(this.createToolbar(), scroll);
  }

  private createToolbar(): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "cm-md-table-toolbar";
    const copy = this.createButton("cm-md-table-tool", "Copy table", "", (b) =>
      this.openMenu(
        "Copy table",
        [
          [
            { label: "Copy as Markdown", run: () => this.copy(b, this.model.markdown()) },
            {
              label: "Copy as CSV",
              run: () => this.copy(b, toDelimited(this.model.plainRows(), ",")),
            },
            {
              label: "Copy as TSV",
              run: () => this.copy(b, toDelimited(this.model.plainRows(), "\t")),
            },
          ],
        ],
        b.getBoundingClientRect(),
        () => b.focus(),
        true,
      ),
    );
    copy.innerHTML = COPY_ICON;
    const download = this.createButton("cm-md-table-tool", "Download table", "", (b) =>
      this.openMenu(
        "Download table",
        [
          [
            {
              label: "Download as CSV",
              run: () => this.download("csv", "text/csv", toDelimited(this.model.plainRows(), ",")),
            },
            {
              label: "Download as Markdown",
              run: () => this.download("md", "text/markdown", this.model.markdown()),
            },
          ],
        ],
        b.getBoundingClientRect(),
        () => b.focus(),
        true,
      ),
    );
    download.innerHTML = DOWNLOAD_ICON;
    bar.append(copy, download);
    return bar;
  }

  private copy(button: HTMLButtonElement, text: string): void {
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        button.innerHTML = CHECK_ICON;
        button.dataset.copied = "true";
        clearTimeout(this.copiedTimer);
        this.copiedTimer = setTimeout(() => {
          button.innerHTML = COPY_ICON;
          delete button.dataset.copied;
        }, 2000);
      })
      .catch(() => {});
  }

  private download(extension: string, type: string, text: string): void {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${this.widget.kind}.${extension}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  private createCell(row: RowIndex, col: number): HTMLElement {
    const el = document.createElement("div");
    el.className = "cm-md-table-cell";
    el.dataset.row = String(row);
    el.dataset.col = String(col);
    el.dataset.testid = `markdown-table__cell--r${row}-c${col}`;
    renderInline(el, this.model.display(row, col));
    if (!this.editable) return el;
    this.setEditable(el, row, col);
    el.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || el.dataset.editing === "true" || !this.model.canEdit(row, col)) return;
      // Swap the rendered text for the raw text and keep the caret where the
      // user clicked when the two read the same.
      e.preventDefault();
      const offset = offsetAtPoint(el, e.clientX, e.clientY);
      const raw = this.model.text(row, col);
      this.focusCell(row, col, offset != null && raw === el.textContent ? offset : "end");
    });
    el.addEventListener("focus", () => {
      if (el.dataset.editing !== "true") this.startEditing(el, row, col, "end");
    });
    el.addEventListener("blur", () => {
      el.dataset.editing = "false";
      el.removeAttribute("aria-invalid");
      renderInline(el, this.model.display(row, col));
    });
    el.addEventListener("beforeinput", (e) => {
      if (e.inputType === "insertParagraph" || e.inputType === "insertLineBreak") {
        e.preventDefault();
      }
    });
    el.addEventListener("paste", (e) => {
      e.preventDefault();
      const text = (e.clipboardData?.getData("text/plain") ?? "").replace(/\r?\n/g, " ");
      document.execCommand("insertText", false, text);
    });
    el.addEventListener("input", () => {
      const typed = el.textContent ?? "";
      if (this.model.normalize(typed) === this.model.text(row, col)) {
        el.removeAttribute("aria-invalid");
        return;
      }
      const next = this.model.setCell(row, col, typed);
      // A value the block cannot hold (an invalid frontmatter key) stays in
      // the cell, marked, and the document keeps the last valid one.
      if (next == null) el.setAttribute("aria-invalid", "true");
      else el.removeAttribute("aria-invalid");
      this.apply(next, undefined, "input.type");
    });
    el.addEventListener("keydown", (e) => this.onCellKeyDown(e, el, row, col));
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.openCellMenu(row, col, { x: e.clientX, y: e.clientY });
    });
    return el;
  }

  private setEditable(el: HTMLElement, row: RowIndex, col: number): void {
    if (this.model.canEdit(row, col)) {
      el.contentEditable = "plaintext-only";
      el.spellcheck = false;
      el.setAttribute("role", "textbox");
      el.setAttribute(
        "aria-label",
        row === 0
          ? `Header, column ${col + 1}`
          : `${capitalize(this.model.noun)} ${row}, column ${col + 1}`,
      );
    } else {
      el.removeAttribute("contenteditable");
      el.removeAttribute("role");
      el.removeAttribute("aria-label");
    }
  }

  private createButton(
    className: string,
    label: string,
    glyph: string,
    onClick: (button: HTMLButtonElement) => void,
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.setAttribute("aria-label", label);
    button.title = label;
    button.textContent = glyph;
    // Keep focus in the cell being edited while the pointer is down.
    button.addEventListener("mousedown", (e) => e.preventDefault());
    button.addEventListener("click", () => onClick(button));
    return button;
  }

  private cellEl(row: RowIndex, col: number): HTMLElement | null {
    return this.cells[row]?.[col] ?? null;
  }

  private focusedCell(): { row: RowIndex; col: number } | null {
    const active = this.dom.ownerDocument.activeElement as HTMLElement | null;
    if (!active?.classList.contains("cm-md-table-cell") || !this.dom.contains(active)) return null;
    return { row: Number(active.dataset.row), col: Number(active.dataset.col) };
  }

  // -------------------------------------------------------------------------
  // Editing
  // -------------------------------------------------------------------------

  private startEditing(el: HTMLElement, row: RowIndex, col: number, caret: Caret): void {
    el.dataset.editing = "true";
    el.textContent = this.model.text(row, col);
    placeCaret(el, caret);
    this.parkEditorSelection();
  }

  /** Focus a cell for editing; false when it cannot be edited. */
  focusCell(row: RowIndex, col: number, caret: Caret): boolean {
    const el = this.cellEl(row, col);
    if (!el || !this.editable || !this.model.canEdit(row, col)) return false;
    el.dataset.editing = "true";
    el.textContent = this.model.text(row, col);
    el.focus({ preventScroll: false });
    placeCaret(el, caret);
    this.parkEditorSelection();
    return true;
  }

  /**
   * Focus the nearest editable cell from `(row, col)` in reading order,
   * stepping by `dir` (1 forward, -1 back). False when there is none.
   */
  private focusStep(row: RowIndex, col: number, dir: 1 | -1, caret: Caret): boolean {
    const cols = this.model.columns;
    for (let i = row * cols + col + dir; i >= 0 && i < (this.lastRow + 1) * cols; i += dir) {
      if (this.focusCell(Math.floor(i / cols), i % cols, caret)) return true;
    }
    return false;
  }

  /**
   * Move the editor's own cursor to the line after the table, so that undo,
   * which scrolls to the restored selection, stays next to the table.
   */
  private parkEditorSelection(): void {
    const range = this.range();
    if (!range) return;
    const { doc, selection } = this.view.state;
    if (range.to >= doc.length) return;
    const target = range.to + 1;
    if (selection.main.empty && selection.main.head === target) return;
    this.view.dispatch({ selection: { anchor: target } });
  }

  /** The block's current document range, or null if the widget is detached. */
  private range(): { from: number; to: number } | null {
    let from: number;
    try {
      from = this.view.posAtDOM(this.dom);
    } catch {
      return null;
    }
    const to = from + this.widget.source.length;
    if (this.view.state.doc.sliceString(from, to) !== this.widget.source) return null;
    return { from, to };
  }

  /**
   * Write the block's new source into the document as the smallest change
   * covering the difference, and focus `focus` once the widget has redrawn.
   * A null source (the edit could not be written) changes nothing.
   */
  private apply(
    newText: string | null,
    focus?: { row: RowIndex; col: number; caret: Caret },
    userEvent = "input.table",
  ): void {
    const range = this.range();
    if (!range || newText == null) return;
    const oldText = this.widget.source;
    if (oldText === newText) {
      if (focus) this.focusCell(focus.row, focus.col, focus.caret);
      return;
    }
    let start = 0;
    while (start < oldText.length && start < newText.length && oldText[start] === newText[start]) {
      start++;
    }
    let end = 0;
    while (
      end < oldText.length - start &&
      end < newText.length - start &&
      oldText[oldText.length - 1 - end] === newText[newText.length - 1 - end]
    ) {
      end++;
    }
    this.pendingFocus = focus ?? null;
    this.view.dispatch({
      changes: {
        from: range.from + start,
        to: range.to - end,
        insert: newText.slice(start, newText.length - end),
      },
      userEvent,
    });
    // `update` consumes it inside the dispatch; if the table did not redraw
    // (it stopped parsing as a table), drop it so a later update ignores it.
    this.pendingFocus = null;
  }

  /**
   * Leave the table for the neighbouring block. A text line directly below a
   * table would become a table row, so the cursor skips the blank line after
   * it, and a table at the end of the document gets a new paragraph line.
   */
  private exit(where: "before" | "after"): void {
    const range = this.range();
    if (!range) return;
    const { doc } = this.view.state;
    const isBlank = (n: number) => doc.line(n).text.trim() === "";
    if (where === "before") {
      if (range.from === 0) return;
      let n = doc.lineAt(range.from).number - 1;
      if (isBlank(n) && n > 1) n--;
      this.view.dispatch({ selection: { anchor: doc.line(n).to }, scrollIntoView: true });
    } else {
      const last = doc.lineAt(range.to).number;
      if (last === doc.lines) {
        this.view.dispatch({
          changes: { from: range.to, insert: "\n\n" },
          selection: { anchor: range.to + 2 },
          scrollIntoView: true,
        });
      } else if (!isBlank(last + 1) || last + 1 === doc.lines) {
        const next = doc.line(last + 1);
        if (last + 1 === doc.lines && isBlank(last + 1)) {
          this.view.dispatch({
            changes: { from: next.to, insert: "\n" },
            selection: { anchor: next.to + 1 },
            scrollIntoView: true,
          });
        } else {
          this.view.dispatch({ selection: { anchor: next.from }, scrollIntoView: true });
        }
      } else {
        this.view.dispatch({
          selection: { anchor: doc.line(last + 2).from },
          scrollIntoView: true,
        });
      }
    }
    this.view.focus();
  }

  private showSource(): void {
    const range = this.range();
    if (!range) return;
    this.view.dispatch({ selection: { anchor: range.from }, scrollIntoView: true });
    this.view.focus();
  }

  private addRowAfter(row: RowIndex, col: number): void {
    const { model } = this;
    this.apply(model.insertRow(row + 1), { row: row + 1, col, caret: model.newRowCaret });
  }

  private onCellKeyDown(e: KeyboardEvent, el: HTMLElement, row: RowIndex, col: number): void {
    // Enter and the arrows belong to the input method while it composes.
    if (e.isComposing || e.keyCode === 229) return;
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    const plain = !mod && !e.shiftKey;
    if (mod && key === "s") {
      handled();
      this.widget.options.onSave?.();
    } else if (mod && key === "z") {
      handled();
      (e.shiftKey ? redo : undo)(this.view);
    } else if (mod && key === "y") {
      handled();
      redo(this.view);
    } else if (mod && key === "a") {
      // The browser would extend select-all to the whole editor.
      handled();
      placeCaret(el, "all");
    } else if (key === "Tab") {
      handled();
      if (e.shiftKey) this.focusStep(row, col, -1, "end");
      else if (!this.focusStep(row, col, 1, "end")) this.addRowAfter(row, 0);
    } else if (key === "Enter" && !mod) {
      handled();
      if (e.shiftKey) this.focusCell(row - 1, col, "end");
      else if (row < this.lastRow) this.focusCell(row + 1, col, "end");
      else this.addRowAfter(row, col);
    } else if (key === "ArrowUp" && plain) {
      handled();
      if (!this.focusCell(row - 1, col, "end")) this.exit("before");
    } else if (key === "ArrowDown" && plain) {
      handled();
      if (!this.focusCell(row + 1, col, "end")) this.exit("after");
    } else if (key === "ArrowLeft" && plain && caretAt(el) === 0) {
      handled();
      this.focusStep(row, col, -1, "end");
    } else if (key === "ArrowRight" && plain && caretAt(el) === (el.textContent ?? "").length) {
      handled();
      this.focusStep(row, col, 1, "start");
    } else if (key === "Escape") {
      handled();
      this.exit("after");
    }
  }

  // -------------------------------------------------------------------------
  // Menus
  // -------------------------------------------------------------------------

  private rowItems(row: RowIndex, col: number): MenuItem[] {
    const { model } = this;
    const { noun } = model;
    const items: MenuItem[] = [];
    if (row > 0) {
      items.push({
        label: `Insert ${noun} above`,
        run: () => this.apply(model.insertRow(row), { row, col, caret: model.newRowCaret }),
      });
    }
    items.push({ label: `Insert ${noun} below`, run: () => this.addRowAfter(row, col) });
    if (row > 0) {
      items.push({
        label: `Delete ${noun}`,
        disabled: !model.canDeleteRow(row),
        run: () =>
          this.apply(model.deleteRow(row), {
            row: Math.min(row, this.lastRow - 1),
            col,
            caret: "end",
          }),
      });
    }
    return items;
  }

  private columnItems(ops: ColumnOps, col: number, row: RowIndex): MenuItem[] {
    const current = this.model.align[col];
    return [
      ...ALIGN_LABELS.map(([align, label]) => ({
        label,
        checked: current === align,
        run: () =>
          this.apply(ops.align(col, current === align ? null : align), {
            row,
            col,
            caret: "end" as Caret,
          }),
      })),
      {
        label: "Insert column left",
        run: () => this.apply(ops.insert(col), { row: 0, col, caret: "end" }),
      },
      {
        label: "Insert column right",
        run: () => this.apply(ops.insert(col + 1), { row: 0, col: col + 1, caret: "end" }),
      },
      {
        label: "Delete column",
        disabled: this.model.columns <= 1,
        run: () =>
          this.apply(ops.delete(col), {
            row,
            col: Math.min(col, this.model.columns - 2),
            caret: "end",
          }),
      },
    ];
  }

  /** Put focus back on a cell after a menu closes, or on the nearest one. */
  private refocus(row: RowIndex, col: number): () => void {
    return () => {
      if (!this.focusCell(row, col, "end")) this.focusStep(row, col, 1, "end");
    };
  }

  private openColumnMenu(col: number, anchor: DOMRect): void {
    const ops = this.model.columnOps;
    if (!ops) return;
    const focused = this.focusedCell();
    const row = focused?.col === col ? focused.row : 0;
    this.openMenu(
      "Column options",
      [this.columnItems(ops, col, row)],
      anchor,
      this.refocus(row, col),
    );
  }

  private openRowMenu(row: RowIndex, anchor: DOMRect): void {
    const focused = this.focusedCell();
    const col = focused?.row === row ? focused.col : 0;
    this.openMenu(
      `${capitalize(this.model.noun)} options`,
      [this.rowItems(row, col)],
      anchor,
      this.refocus(row, col),
    );
  }

  private openCellMenu(row: RowIndex, col: number, at: { x: number; y: number }): void {
    const ops = this.model.columnOps;
    this.openMenu(
      "Table options",
      [
        this.rowItems(row, col),
        ...(ops ? [this.columnItems(ops, col, row)] : []),
        [{ label: "Edit as markdown", run: () => this.showSource() }],
      ],
      new DOMRect(at.x, at.y, 0, 0),
      this.refocus(row, col),
    );
  }

  /**
   * Open a menu under `anchor`, lined up with its left edge, or its right
   * edge for `alignEnd`. `onDismiss` puts focus back when the menu closes
   * without a choice while it had focus.
   */
  private openMenu(
    label: string,
    groups: MenuItem[][],
    anchor: DOMRect,
    onDismiss: () => void,
    alignEnd = false,
  ): void {
    this.menu?.close();
    const host = this.view.dom;
    const menu = document.createElement("div");
    menu.className = "cm-md-table-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", label);
    menu.dataset.testid = "markdown-table__menu";
    const buttons: HTMLButtonElement[] = [];
    let chosen = false;
    groups.forEach((items, i) => {
      if (i > 0) {
        const sep = document.createElement("div");
        sep.className = "cm-md-table-menu-separator";
        sep.setAttribute("role", "separator");
        menu.appendChild(sep);
      }
      for (const item of items) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "cm-md-table-menu-item";
        button.setAttribute("role", item.checked == null ? "menuitem" : "menuitemradio");
        if (item.checked != null) button.setAttribute("aria-checked", String(item.checked));
        button.textContent = item.label;
        button.disabled = !!item.disabled;
        button.addEventListener("click", () => {
          chosen = true;
          close();
          item.run();
        });
        menu.appendChild(button);
        buttons.push(button);
      }
    });

    const onOutside = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) close();
    };
    const close = () => {
      if (this.menu?.el !== menu) return;
      this.menu = null;
      document.removeEventListener("mousedown", onOutside, true);
      const hadFocus = menu.contains(document.activeElement);
      menu.remove();
      if (hadFocus && !chosen) onDismiss();
    };
    menu.addEventListener("keydown", (e) => {
      const enabled = buttons.filter((b) => !b.disabled);
      const index = enabled.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        enabled[(index + step + enabled.length) % enabled.length]?.focus();
      } else if (e.key === "Escape" || e.key === "Tab") {
        e.preventDefault();
        close();
      }
      e.stopPropagation();
    });
    document.addEventListener("mousedown", onOutside, true);
    this.menu = { el: menu, close };

    host.appendChild(menu);
    const hostRect = host.getBoundingClientRect();
    const width = menu.offsetWidth;
    let left = (alignEnd ? anchor.right - width : anchor.left) - hostRect.left;
    const top = anchor.bottom - hostRect.top + 4;
    if (left + width > hostRect.width - 8) left = Math.max(8, hostRect.width - width - 8);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    buttons.find((b) => !b.disabled)?.focus();
  }

  private onRootMouseDown(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    // Buttons (the toolbar, grips, "+" bars) handle their own clicks.
    if (target.closest("button")) return;
    if (this.widget.readOnly) {
      // A read-only grid has nothing to edit: show its source so it can be
      // selected and copied, the way other rendered blocks behave.
      e.preventDefault();
      this.showSource();
      return;
    }
    // Editable cells handle their own clicks; anywhere else in the block
    // would let the browser put the editor caret next to the widget.
    if (!target.closest('.cm-md-table-cell[contenteditable="plaintext-only"]')) e.preventDefault();
  }
}

/** The caret offset in a single-text-node cell, or null without a collapsed selection. */
function caretAt(el: HTMLElement): number | null {
  const sel = el.ownerDocument.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.startContainer)) return null;
  const pre = document.createRange();
  pre.selectNodeContents(el);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString().length;
}

/** Put the caret in a cell, or select all of its text for `"all"`. */
function placeCaret(el: HTMLElement, caret: Caret): void {
  const sel = el.ownerDocument.getSelection();
  if (!sel) return;
  const range = document.createRange();
  const text = el.firstChild;
  if (caret === "all") {
    range.selectNodeContents(el);
  } else if (text && text.nodeType === Node.TEXT_NODE) {
    const len = text.textContent?.length ?? 0;
    const offset = caret === "start" ? 0 : caret === "end" ? len : Math.min(caret, len);
    range.setStart(text, offset);
    range.collapse(true);
  } else {
    range.selectNodeContents(el);
    range.collapse(caret === "start");
  }
  sel.removeAllRanges();
  sel.addRange(range);
}

/** The text offset within `el` under a point, or null when it is not over text. */
function offsetAtPoint(el: HTMLElement, x: number, y: number): number | null {
  const range = document.caretRangeFromPoint?.(x, y);
  if (!range || !el.contains(range.startContainer)) return null;
  const pre = document.createRange();
  pre.selectNodeContents(el);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString().length;
}
