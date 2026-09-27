/**
 * Editable table for the markdown live preview.
 *
 * A GFM table renders as a grid whose cells can be edited in place. A cell
 * shows its rendered inline markdown until it is focused, then its raw
 * markdown. Every keystroke rewrites only that cell's text in the document,
 * and row / column / alignment edits rewrite only the pipe segments they
 * change (`markdown-table.ts`), so the file stays GFM in the form it was
 * written in and undo goes through the editor's history.
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

interface TableWidgetOptions {
  onSave?: () => void;
}

const editors = new WeakMap<HTMLElement, TableEditor>();

export class TableWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly inline: Inline[][][],
    readonly readOnly: boolean,
    readonly options: TableWidgetOptions,
  ) {
    super();
  }
  eq(other: TableWidget): boolean {
    return other.source === this.source && other.readOnly === this.readOnly;
  }
  toDOM(view: EditorView): HTMLElement {
    const editor = new TableEditor(view, this);
    editors.set(editor.dom, editor);
    return editor.dom;
  }
  updateDOM(dom: HTMLElement): boolean {
    const editor = editors.get(dom);
    if (!editor) return false;
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
  return new TableWidget(
    state.doc.sliceString(from, to),
    tableInline(state, node),
    state.readOnly,
    options,
  );
}

type Caret = "start" | "end" | number;

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

class TableEditor {
  readonly dom: HTMLElement;
  private table: TableSource;
  private menu: { el: HTMLElement; close: () => void } | null = null;
  private pendingFocus: { row: RowIndex; col: number; caret: Caret } | null = null;

  constructor(
    private readonly view: EditorView,
    private widget: TableWidget,
  ) {
    this.table = parseTable(widget.source.split("\n"));
    this.dom = document.createElement("div");
    this.dom.className = "cm-md-block cm-md-block--table";
    this.dom.dataset.testid = "markdown-preview__block--table";
    this.dom.addEventListener("mousedown", (e) => this.onRootMouseDown(e));
    this.render();
  }

  private get lastRow(): RowIndex {
    return this.table.body.length;
  }

  update(widget: TableWidget): void {
    const prev = this.table;
    const prevWidget = this.widget;
    this.widget = widget;
    this.table = parseTable(widget.source.split("\n"));
    const sameShape =
      prev.columns === this.table.columns &&
      prev.body.length === this.table.body.length &&
      prev.align.join() === this.table.align.join() &&
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
            Math.min(target.col, this.table.columns - 1),
            target.caret,
          ),
        );
      }
      return;
    }
    for (let row = 0; row <= this.lastRow; row++) {
      for (let col = 0; col < this.table.columns; col++) {
        const el = this.cellEl(row, col);
        if (!el) continue;
        const text = cellText(this.table, row, col);
        if (el.dataset.editing === "true") {
          // The focused cell already shows what the user typed; only replace
          // it when the document changed under it (undo, redo).
          if (toCellMarkdown(el.textContent ?? "") !== text) {
            el.textContent = text;
            placeCaret(el, "end");
          }
        } else if (text !== cellText(prev, row, col) || !sameInline(prevWidget, widget, row, col)) {
          renderInline(el, widget.inline[row]?.[col]);
        }
      }
    }
  }

  destroy(): void {
    this.menu?.close();
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private render(): void {
    this.menu?.close();
    const editable = !this.widget.readOnly;
    const table = document.createElement("table");
    table.className = "cm-md-table";
    const thead = table.createTHead();
    const tbody = table.createTBody();
    for (let row = 0; row <= this.lastRow; row++) {
      const tr = (row === 0 ? thead : tbody).insertRow();
      for (let col = 0; col < this.table.columns; col++) {
        const cell = document.createElement(row === 0 ? "th" : "td");
        const align = this.table.align[col];
        if (align) cell.style.textAlign = align;
        cell.appendChild(this.createCell(row, col, editable));
        if (editable && row === 0) {
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
              `Row ${row} options`,
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
    if (editable) {
      frame.appendChild(
        this.createButton("cm-md-table-add cm-md-table-add--col", "Add column", "+", () =>
          this.apply(insertColumn(this.table, this.table.columns), {
            row: 0,
            col: this.table.columns,
            caret: "end",
          }),
        ),
      );
      frame.appendChild(
        this.createButton("cm-md-table-add cm-md-table-add--row", "Add row", "+", () =>
          this.apply(insertRow(this.table, this.lastRow + 1), {
            row: this.lastRow + 1,
            col: 0,
            caret: "end",
          }),
        ),
      );
    }
    const scroll = document.createElement("div");
    scroll.className = "cm-md-table-scroll";
    scroll.appendChild(frame);
    this.dom.replaceChildren(scroll);
  }

  private createCell(row: RowIndex, col: number, editable: boolean): HTMLElement {
    const el = document.createElement("div");
    el.className = "cm-md-table-cell";
    el.dataset.row = String(row);
    el.dataset.col = String(col);
    el.dataset.testid = `markdown-table__cell--r${row}-c${col}`;
    renderInline(el, this.widget.inline[row]?.[col]);
    if (!editable) return el;
    el.contentEditable = "plaintext-only";
    el.spellcheck = false;
    el.setAttribute("role", "textbox");
    el.setAttribute(
      "aria-label",
      row === 0 ? `Header, column ${col + 1}` : `Row ${row}, column ${col + 1}`,
    );
    el.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || el.dataset.editing === "true") return;
      // Swap the rendered text for the raw markdown and keep the caret where
      // the user clicked when the two read the same.
      e.preventDefault();
      const offset = offsetAtPoint(el, e.clientX, e.clientY);
      const raw = cellText(this.table, row, col);
      this.focusCell(row, col, offset != null && raw === el.textContent ? offset : "end");
    });
    el.addEventListener("focus", () => {
      if (el.dataset.editing !== "true") this.startEditing(el, row, col, "end");
    });
    el.addEventListener("blur", () => {
      el.dataset.editing = "false";
      renderInline(el, this.widget.inline[row]?.[col]);
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
      const text = toCellMarkdown(el.textContent ?? "");
      if (text !== cellText(this.table, row, col)) {
        this.apply(setCell(this.table, row, col, text), undefined, "input.type");
      }
    });
    el.addEventListener("keydown", (e) => this.onCellKeyDown(e, el, row, col));
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.openCellMenu(row, col, { x: e.clientX, y: e.clientY });
    });
    return el;
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
    return this.dom.querySelector<HTMLElement>(
      `.cm-md-table-cell[data-row="${row}"][data-col="${col}"]`,
    );
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
    el.textContent = cellText(this.table, row, col);
    placeCaret(el, caret);
    this.parkEditorSelection();
  }

  focusCell(row: RowIndex, col: number, caret: Caret): void {
    const el = this.cellEl(row, col);
    if (!el) return;
    el.dataset.editing = "true";
    el.textContent = cellText(this.table, row, col);
    el.focus({ preventScroll: false });
    placeCaret(el, caret);
    this.parkEditorSelection();
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

  /** The table's current document range, or null if the widget is detached. */
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
   * Write `next` into the document as the smallest change covering the
   * difference, and focus `focus` once the widget has redrawn.
   */
  private apply(
    next: TableSource,
    focus?: { row: RowIndex; col: number; caret: Caret },
    userEvent = "input.table",
  ): void {
    const range = this.range();
    if (!range) return;
    const oldText = this.widget.source;
    const newText = tableLines(next).join("\n");
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

  private onCellKeyDown(e: KeyboardEvent, el: HTMLElement, row: RowIndex, col: number): void {
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    const cols = this.table.columns;
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
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = el.ownerDocument.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    } else if (key === "Tab") {
      handled();
      if (e.shiftKey) {
        if (col > 0) this.focusCell(row, col - 1, "end");
        else if (row > 0) this.focusCell(row - 1, cols - 1, "end");
      } else if (col + 1 < cols) {
        this.focusCell(row, col + 1, "end");
      } else if (row < this.lastRow) {
        this.focusCell(row + 1, 0, "end");
      } else {
        this.apply(insertRow(this.table, row + 1), { row: row + 1, col: 0, caret: "end" });
      }
    } else if (key === "Enter" && !mod) {
      handled();
      if (e.shiftKey) {
        if (row > 0) this.focusCell(row - 1, col, "end");
      } else if (row < this.lastRow) {
        this.focusCell(row + 1, col, "end");
      } else {
        this.apply(insertRow(this.table, row + 1), { row: row + 1, col, caret: "end" });
      }
    } else if (key === "ArrowUp" && !mod && !e.shiftKey) {
      handled();
      if (row > 0) this.focusCell(row - 1, col, "end");
      else this.exit("before");
    } else if (key === "ArrowDown" && !mod && !e.shiftKey) {
      handled();
      if (row < this.lastRow) this.focusCell(row + 1, col, "end");
      else this.exit("after");
    } else if (key === "ArrowLeft" && !mod && !e.shiftKey && caretAt(el) === 0) {
      handled();
      if (col > 0) this.focusCell(row, col - 1, "end");
      else if (row > 0) this.focusCell(row - 1, cols - 1, "end");
    } else if (
      key === "ArrowRight" &&
      !mod &&
      !e.shiftKey &&
      caretAt(el) === (el.textContent ?? "").length
    ) {
      handled();
      if (col + 1 < cols) this.focusCell(row, col + 1, "start");
      else if (row < this.lastRow) this.focusCell(row + 1, 0, "start");
    } else if (key === "Escape") {
      handled();
      this.exit("after");
    }
  }

  // -------------------------------------------------------------------------
  // Menus
  // -------------------------------------------------------------------------

  private rowItems(row: RowIndex, col: number): MenuItem[] {
    const items: MenuItem[] = [];
    if (row > 0) {
      items.push({
        label: "Insert row above",
        run: () => this.apply(insertRow(this.table, row), { row, col, caret: "end" }),
      });
    }
    items.push({
      label: "Insert row below",
      run: () => this.apply(insertRow(this.table, row + 1), { row: row + 1, col, caret: "end" }),
    });
    if (row > 0) {
      items.push({
        label: "Delete row",
        run: () =>
          this.apply(deleteRow(this.table, row), {
            row: Math.min(row, this.lastRow - 1),
            col,
            caret: "end",
          }),
      });
    }
    return items;
  }

  private columnItems(col: number, row: RowIndex): MenuItem[] {
    const current = this.table.align[col];
    return [
      ...ALIGN_LABELS.map(([align, label]) => ({
        label,
        checked: current === align,
        run: () =>
          this.apply(setAlign(this.table, col, current === align ? null : align), {
            row,
            col,
            caret: "end" as Caret,
          }),
      })),
      {
        label: "Insert column left",
        run: () => this.apply(insertColumn(this.table, col), { row: 0, col, caret: "end" }),
      },
      {
        label: "Insert column right",
        run: () =>
          this.apply(insertColumn(this.table, col + 1), { row: 0, col: col + 1, caret: "end" }),
      },
      {
        label: "Delete column",
        disabled: this.table.columns <= 1,
        run: () =>
          this.apply(deleteColumn(this.table, col), {
            row,
            col: Math.min(col, this.table.columns - 2),
            caret: "end",
          }),
      },
    ];
  }

  private openColumnMenu(col: number, anchor: DOMRect): void {
    const focused = this.focusedCell();
    const row = focused?.col === col ? focused.row : 0;
    this.openMenu("Column options", [this.columnItems(col, row)], anchor, { row, col });
  }

  private openRowMenu(row: RowIndex, anchor: DOMRect): void {
    const focused = this.focusedCell();
    const col = focused?.row === row ? focused.col : 0;
    this.openMenu("Row options", [this.rowItems(row, col)], anchor, { row, col });
  }

  private openCellMenu(row: RowIndex, col: number, at: { x: number; y: number }): void {
    this.openMenu(
      "Table options",
      [
        this.rowItems(row, col),
        this.columnItems(col, row),
        [{ label: "Edit as markdown", run: () => this.showSource() }],
      ],
      new DOMRect(at.x, at.y, 0, 0),
      { row, col },
    );
  }

  private openMenu(
    label: string,
    groups: MenuItem[][],
    anchor: DOMRect,
    returnTo: { row: RowIndex; col: number },
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
      if (hadFocus && !chosen) this.focusCell(returnTo.row, returnTo.col, "end");
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
    let left = anchor.left - hostRect.left;
    const top = anchor.bottom - hostRect.top + 4;
    const width = menu.offsetWidth;
    if (left + width > hostRect.width - 8) left = Math.max(8, hostRect.width - width - 8);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    buttons.find((b) => !b.disabled)?.focus();
  }

  private onRootMouseDown(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    if (this.widget.readOnly) {
      // A read-only table has nothing to edit: show its source so it can be
      // selected and copied, the way other rendered blocks behave.
      e.preventDefault();
      this.showSource();
      return;
    }
    // Cells and buttons handle their own clicks; anywhere else in the block
    // would let the browser put the editor caret next to the widget.
    if (!target.closest(".cm-md-table-cell, button")) e.preventDefault();
  }
}

function sameInline(a: TableWidget, b: TableWidget, row: RowIndex, col: number): boolean {
  return JSON.stringify(a.inline[row]?.[col]) === JSON.stringify(b.inline[row]?.[col]);
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

function placeCaret(el: HTMLElement, caret: Caret): void {
  const sel = el.ownerDocument.getSelection();
  if (!sel) return;
  const range = document.createRange();
  const text = el.firstChild;
  if (text && text.nodeType === Node.TEXT_NODE) {
    const len = text.textContent?.length ?? 0;
    const offset = caret === "start" ? 0 : caret === "end" ? len : Math.min(caret, len);
    range.setStart(text, offset);
  } else {
    range.selectNodeContents(el);
    range.collapse(caret === "start");
  }
  range.collapse(true);
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
