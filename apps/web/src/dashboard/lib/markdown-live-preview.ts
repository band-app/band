/**
 * Editable markdown preview ("live preview", the Obsidian / Typora model).
 *
 * The markdown source stays the CodeMirror document. Formatting is painted on
 * top of it with decorations: heading lines get heading styles, the `**` /
 * `_` / backtick / `#` / `>` markers are hidden, bullets become `•`, task
 * markers become checkboxes, and tables, frontmatter and mermaid fences are
 * swapped for a rendered block. Wherever the selection touches a construct,
 * its raw markers come back so the user can edit them.
 *
 * Because the document is the file's text, saving writes back exactly what is
 * in the buffer: nothing is re-serialised, so parts of the file the user did
 * not touch keep their original bytes (bullet style, emphasis markers, table
 * padding, trailing whitespace). And because formatting follows the syntax
 * tree, typing `# ` or `**bold**` formats as soon as the parser sees it.
 *
 * Find-in-file works unchanged: the preview is a regular EditorView, so the
 * shared `useSearch` highlights and steps through matches in it. Stepping onto
 * a match selects it, which reveals any construct the match sits inside.
 */

import {
  defaultKeymap,
  history,
  historyKeymap,
  indentLess,
  indentMore,
} from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  HighlightStyle,
  LanguageDescription,
  syntaxHighlighting,
  syntaxTree,
} from "@codemirror/language";
import {
  EditorState,
  type Extension,
  type Range,
  StateEffect,
  StateField,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { loadLanguage } from "./codemirror-setup";

/** Blocks the live preview swaps for a rendered version while the cursor is elsewhere. */
export type RenderedBlockKind = "table" | "frontmatter" | "mermaid";

/**
 * Renders a block's markdown `source` into `container` and returns a cleanup
 * function. Supplied by the host so this module stays free of the React
 * markdown renderer.
 */
export type RenderMarkdownBlock = (
  block: { kind: RenderedBlockKind; source: string },
  container: HTMLElement,
) => () => void;

export interface MarkdownLivePreviewOptions {
  /** Renders tables, frontmatter and mermaid fences. Without it they stay as source. */
  renderBlock?: RenderMarkdownBlock;
  /** Maps an image `src` from the document to a loadable URL (relative paths). */
  resolveImageUrl?: (src: string) => string | undefined;
  /** Called on Cmd/Ctrl+S. */
  onSave?: () => void;
  isDark: boolean;
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------
//
// The markdown grammar reads a leading YAML block as a horizontal rule and a
// setext heading, so the block is found by scanning the first lines instead
// and everything inside it is kept away from the markdown decorations.

const YAML_KEY_LINE = /^[\w-]+\s*:/;
/** A closing `---` further down than this does not count as frontmatter. */
const FRONTMATTER_MAX_LINES = 200;

/**
 * The range of a leading `---` YAML block, closing `---` line included. The
 * opening line must be followed by a `key:` line and the block must be
 * closed, so a document that starts with a horizontal rule, or frontmatter
 * the user is still typing, stays ordinary markdown.
 */
function findFrontmatter(doc: Text): { from: number; to: number } | null {
  if (doc.lines < 3) return null;
  if (doc.line(1).text.trimEnd() !== "---" || !YAML_KEY_LINE.test(doc.line(2).text)) return null;
  const last = Math.min(doc.lines, FRONTMATTER_MAX_LINES);
  for (let n = 3; n <= last; n++) {
    const line = doc.line(n);
    if (line.text.trimEnd() === "---") return { from: 0, to: line.to };
  }
  return null;
}

const frontmatterField = StateField.define<{ from: number; to: number } | null>({
  create: (state) => findFrontmatter(state.doc),
  update: (value, tr) => (tr.docChanged ? findFrontmatter(tr.state.doc) : value),
});

/** True for syntax nodes that lie inside the frontmatter block. */
function inFrontmatter(state: EditorState, name: string, to: number): boolean {
  const fm = state.field(frontmatterField);
  return fm != null && name !== "Document" && to <= fm.to;
}

// ---------------------------------------------------------------------------
// Focus tracking
// ---------------------------------------------------------------------------
//
// Markers are revealed only while the editor has focus, so an unfocused
// preview (the state it opens in) reads as fully rendered even though the
// selection starts at position 0.

const setFocused = StateEffect.define<boolean>();

const focusedField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setFocused)) return e.value;
    return value;
  },
});

const focusTracking = EditorView.focusChangeEffect.of((_state, focusing) =>
  setFocused.of(focusing),
);

/**
 * True while the selection was last set by find (`scrollToSearchMatch` tags it
 * `select.search`). Find keeps focus in the find bar, so without this a match
 * inside a rendered table or hidden syntax would be selected but not shown.
 */
const searchRevealField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    if (tr.isUserEvent("select.search")) return true;
    return tr.selection || tr.docChanged ? false : value;
  },
});

/**
 * True when a selection range touches `[from, to]` and the selection is live:
 * the editor has focus, or find just selected a match.
 */
function touches(state: EditorState, from: number, to: number): boolean {
  if (!state.field(focusedField) && !state.field(searchRevealField)) return false;
  return state.selection.ranges.some((r) => r.from <= to && r.to >= from);
}

/** True when a selection range touches any line in `[from, to]`. */
function touchesLines(state: EditorState, from: number, to: number): boolean {
  return touches(state, state.doc.lineAt(from).from, state.doc.lineAt(to).to);
}

// ---------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------

class BulletWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-md-bullet";
    el.textContent = "•";
    el.setAttribute("aria-hidden", "true");
    return el;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked;
  }
  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = this.checked;
    box.className = "cm-md-task";
    box.addEventListener("mousedown", (e) => {
      // Toggle without moving the cursor onto the marker (which would reveal it).
      e.preventDefault();
      if (view.state.readOnly) return;
      const pos = view.posAtDOM(box);
      const text = view.state.doc.sliceString(pos, pos + 3);
      if (!/^\[[ xX]\]$/.test(text)) return;
      view.dispatch({
        changes: { from: pos + 1, to: pos + 2, insert: this.checked ? " " : "x" },
        userEvent: "input.toggle-task",
      });
    });
    return box;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

class RuleWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-md-hr";
    el.setAttribute("role", "separator");
    return el;
  }
}

class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
  ) {
    super();
  }
  eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt;
  }
  toDOM(): HTMLElement {
    const img = document.createElement("img");
    img.src = this.src;
    img.alt = this.alt;
    img.className = "cm-md-image";
    return img;
  }
}

const blockCleanups = new WeakMap<HTMLElement, () => void>();

class RenderedBlockWidget extends WidgetType {
  constructor(
    readonly kind: RenderedBlockKind,
    readonly source: string,
    readonly render: RenderMarkdownBlock,
  ) {
    super();
  }
  eq(other: RenderedBlockWidget): boolean {
    return other.kind === this.kind && other.source === this.source;
  }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement("div");
    el.className = `cm-md-block cm-md-block--${this.kind}`;
    el.dataset.testid = `markdown-preview__block--${this.kind}`;
    // Clicking a rendered block puts the cursor in it, which reveals its source.
    el.addEventListener("mousedown", (e) => {
      if ((e.target as HTMLElement).closest("a")) return;
      e.preventDefault();
      view.dispatch({ selection: { anchor: view.posAtDOM(el) } });
      view.focus();
    });
    blockCleanups.set(el, this.render({ kind: this.kind, source: this.source }, el));
    return el;
  }
  destroy(dom: HTMLElement): void {
    blockCleanups.get(dom)?.();
    blockCleanups.delete(dom);
  }
  ignoreEvent(): boolean {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Rendered blocks (tables, frontmatter, mermaid)
// ---------------------------------------------------------------------------
//
// Replacements that span lines must come from a StateField, not a
// ViewPlugin, so these live apart from the inline decorations below.

/** The block kind a node renders as, or null when it stays as source. */
function renderedBlockKind(
  state: EditorState,
  name: string,
  from: number,
): RenderedBlockKind | null {
  if (name === "Table") return "table";
  if (name === "FencedCode") {
    const firstLine = state.doc.lineAt(from).text.trim();
    return /^(```|~~~)\s*mermaid\b/.test(firstLine) ? "mermaid" : null;
  }
  return null;
}

/** True when the block at `[from, to]` is shown rendered rather than as source. */
function isBlockRendered(state: EditorState, from: number, to: number): boolean {
  // Only whole-line blocks are replaced; a table nested in a list keeps its source.
  if (state.doc.lineAt(from).from !== from) return false;
  return !touchesLines(state, from, to);
}

interface RenderedBlocksState {
  decorations: DecorationSet;
  /** Every candidate block and whether it is currently shown rendered. */
  blocks: Array<{ from: number; to: number; rendered: boolean }>;
}

function buildBlockDecorations(
  state: EditorState,
  render: RenderMarkdownBlock,
): RenderedBlocksState {
  const decos: Range<Decoration>[] = [];
  const blocks: RenderedBlocksState["blocks"] = [];
  const addBlock = (kind: RenderedBlockKind, from: number, to: number) => {
    const rendered = isBlockRendered(state, from, to);
    blocks.push({ from, to, rendered });
    if (!rendered) return;
    decos.push(
      Decoration.replace({
        widget: new RenderedBlockWidget(kind, state.doc.sliceString(from, to), render),
        block: true,
      }).range(from, to),
    );
  };
  const fm = state.field(frontmatterField);
  if (fm) addBlock("frontmatter", fm.from, fm.to);
  syntaxTree(state).iterate({
    enter(node) {
      if (inFrontmatter(state, node.name, node.to)) return false;
      const kind = renderedBlockKind(state, node.name, node.from);
      if (kind) {
        addBlock(kind, node.from, state.doc.lineAt(node.to).to);
        return false;
      }
      // Tables and fences never sit inside inline content.
      return !(node.name === "Paragraph" || node.name.startsWith("ATXHeading"));
    },
  });
  return { decorations: Decoration.set(decos, true), blocks };
}

function renderedBlocks(render: RenderMarkdownBlock): Extension {
  return StateField.define<RenderedBlocksState>({
    create: (state) => buildBlockDecorations(state, render),
    update(value, tr) {
      if (tr.docChanged || syntaxTree(tr.startState) !== syntaxTree(tr.state)) {
        return buildBlockDecorations(tr.state, render);
      }
      if (!tr.selection && !tr.effects.some((e) => e.is(setFocused))) return value;
      // A cursor move only matters when it enters or leaves a block, so skip
      // the full-tree rebuild while every block keeps its rendered state.
      const changed = value.blocks.some(
        (b) => isBlockRendered(tr.state, b.from, b.to) !== b.rendered,
      );
      return changed ? buildBlockDecorations(tr.state, render) : value;
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.decorations),
  });
}

// ---------------------------------------------------------------------------
// Inline decorations
// ---------------------------------------------------------------------------

const hidden = Decoration.replace({});
const strong = Decoration.mark({ tagName: "strong", class: "cm-md-strong" });
const emphasis = Decoration.mark({ tagName: "em", class: "cm-md-em" });
const strike = Decoration.mark({ tagName: "del", class: "cm-md-strike" });
const inlineCode = Decoration.mark({ tagName: "code", class: "cm-md-code" });
const link = Decoration.mark({ class: "cm-md-link" });
const dim = Decoration.mark({ class: "cm-md-syntax" });

function headingLine(level: number): Decoration {
  return Decoration.line({
    class: `cm-md-heading cm-md-h${level}`,
    attributes: { role: "heading", "aria-level": String(level) },
  });
}
const HEADING_LINES = [1, 2, 3, 4, 5, 6].map(headingLine);
const listItemLine = Decoration.line({ class: "cm-md-li", attributes: { role: "listitem" } });
const quoteLine = Decoration.line({ class: "cm-md-blockquote" });
const codeLine = Decoration.line({ class: "cm-md-codeblock" });
const fenceLine = Decoration.line({ class: "cm-md-codeblock cm-md-fence" });
const sourceBlockLine = Decoration.line({ class: "cm-md-source-block" });

/** Hide a marker plus one following space (`# `, `> `). */
function hideMarker(state: EditorState, decos: Range<Decoration>[], from: number, to: number) {
  const end = state.doc.sliceString(to, to + 1) === " " ? to + 1 : to;
  if (end > from) decos.push(hidden.range(from, end));
}

function eachLine(state: EditorState, from: number, to: number, fn: (lineFrom: number) => void) {
  let pos = from;
  while (pos <= to) {
    const line = state.doc.lineAt(pos);
    fn(line.from);
    pos = line.to + 1;
  }
}

function buildInlineDecorations(view: EditorView, opts: InlineOptions): DecorationSet {
  const { state } = view;
  const decos: Range<Decoration>[] = [];
  const tree = syntaxTree(state);

  const fm = state.field(frontmatterField);
  const fmSource = fm != null && (!opts.renderBlocks || !isBlockRendered(state, fm.from, fm.to));

  for (const { from, to } of view.visibleRanges) {
    // Line decorations only for the visible lines of a block that runs off screen.
    const lines = (lineFrom: number, lineTo: number, fn: (lineStart: number) => void) =>
      eachLine(state, Math.max(lineFrom, from), Math.min(lineTo, to), fn);
    if (fm && fmSource) {
      lines(fm.from, fm.to, (lineFrom) => decos.push(sourceBlockLine.range(lineFrom)));
    }
    tree.iterate({
      from,
      to,
      enter(ref) {
        const { name } = ref;
        const node = ref.node;
        if (inFrontmatter(state, name, ref.to)) return false;

        const headingMatch = /^ATXHeading(\d)$/.exec(name);
        if (headingMatch) {
          const level = Number(headingMatch[1]);
          decos.push(HEADING_LINES[level - 1].range(state.doc.lineAt(ref.from).from));
          if (!touchesLines(state, ref.from, ref.to)) {
            for (const mark of node.getChildren("HeaderMark")) {
              if (mark.from === ref.from) {
                hideMarker(state, decos, mark.from, mark.to);
              } else {
                // Closing marks (`## Title ##`) take their leading space with them.
                const spaced = state.doc.sliceString(mark.from - 1, mark.from) === " ";
                decos.push(hidden.range(spaced ? mark.from - 1 : mark.from, mark.to));
              }
            }
          }
          return;
        }

        const setextMatch = /^SetextHeading(\d)$/.exec(name);
        if (setextMatch) {
          const level = Number(setextMatch[1]);
          const underline = node.getChild("HeaderMark");
          lines(ref.from, underline ? underline.from - 1 : ref.to, (lineFrom) =>
            decos.push(HEADING_LINES[level - 1].range(lineFrom)),
          );
          if (underline) decos.push(dim.range(underline.from, underline.to));
          return;
        }

        switch (name) {
          case "Table": {
            const lineEnd = state.doc.lineAt(ref.to).to;
            if (!opts.renderBlocks || !isBlockRendered(state, ref.from, lineEnd)) {
              lines(ref.from, ref.to, (lineFrom) => decos.push(sourceBlockLine.range(lineFrom)));
            }
            return false;
          }
          case "FencedCode": {
            const lineEnd = state.doc.lineAt(ref.to).to;
            if (
              opts.renderBlocks &&
              renderedBlockKind(state, name, ref.from) &&
              isBlockRendered(state, ref.from, lineEnd)
            ) {
              return false;
            }
            const firstLine = state.doc.lineAt(ref.from);
            const lastLine = state.doc.lineAt(ref.to);
            lines(ref.from, ref.to, (lineFrom) => {
              const isFence =
                (lineFrom === firstLine.from || lineFrom === lastLine.from) &&
                /^\s*(```|~~~)/.test(state.doc.lineAt(lineFrom).text);
              decos.push((isFence ? fenceLine : codeLine).range(lineFrom));
            });
            return false;
          }
          case "CodeBlock":
            lines(ref.from, ref.to, (lineFrom) => decos.push(codeLine.range(lineFrom)));
            return false;
          case "HTMLBlock":
            lines(ref.from, ref.to, (lineFrom) => decos.push(sourceBlockLine.range(lineFrom)));
            return false;
          case "Blockquote":
            lines(ref.from, ref.to, (lineFrom) => decos.push(quoteLine.range(lineFrom)));
            return;
          case "QuoteMark":
            if (!touchesLines(state, ref.from, ref.from))
              hideMarker(state, decos, ref.from, ref.to);
            return;
          case "ListItem":
            decos.push(listItemLine.range(state.doc.lineAt(ref.from).from));
            return;
          case "ListMark": {
            const list = node.parent?.parent;
            // Keep the raw marker while the cursor is right at it (`- |`), so
            // typing a list marker doesn't make it vanish under the cursor.
            if (list?.name === "BulletList" && !touches(state, ref.from, ref.to + 1)) {
              decos.push(
                Decoration.replace({ widget: new BulletWidget() }).range(ref.from, ref.to),
              );
            } else {
              decos.push(dim.range(ref.from, ref.to));
            }
            return;
          }
          case "TaskMarker":
            if (!touches(state, ref.from, ref.to)) {
              const checked = /x/i.test(state.doc.sliceString(ref.from, ref.to));
              decos.push(
                Decoration.replace({ widget: new CheckboxWidget(checked) }).range(ref.from, ref.to),
              );
            }
            return;
          case "HorizontalRule":
            if (!touchesLines(state, ref.from, ref.to)) {
              decos.push(Decoration.replace({ widget: new RuleWidget() }).range(ref.from, ref.to));
            } else {
              decos.push(dim.range(ref.from, ref.to));
            }
            return;
          case "StrongEmphasis":
          case "Emphasis":
          case "Strikethrough":
          case "InlineCode": {
            const deco =
              name === "StrongEmphasis"
                ? strong
                : name === "Emphasis"
                  ? emphasis
                  : name === "Strikethrough"
                    ? strike
                    : inlineCode;
            decos.push(deco.range(ref.from, ref.to));
            const markName =
              name === "InlineCode"
                ? "CodeMark"
                : name === "Strikethrough"
                  ? "StrikethroughMark"
                  : "EmphasisMark";
            const reveal = touches(state, ref.from, ref.to);
            for (const mark of node.getChildren(markName)) {
              decos.push((reveal ? dim : hidden).range(mark.from, mark.to));
            }
            // Inline code has no nested syntax worth decorating.
            return name === "InlineCode" ? false : undefined;
          }
          case "Image": {
            const url = node.getChild("URL");
            if (url && !touches(state, ref.from, ref.to)) {
              const src = state.doc.sliceString(url.from, url.to);
              const marks = node.getChildren("LinkMark");
              const alt =
                marks.length >= 2 ? state.doc.sliceString(marks[0].to, marks[1].from) : "";
              const resolved = opts.resolveImageUrl ? opts.resolveImageUrl(src) : src;
              if (resolved) {
                decos.push(
                  Decoration.replace({ widget: new ImageWidget(resolved, alt) }).range(
                    ref.from,
                    ref.to,
                  ),
                );
                return false;
              }
            }
            return;
          }
          case "Link": {
            const marks = node.getChildren("LinkMark");
            if (marks.length >= 2 && marks[1].from > marks[0].to) {
              decos.push(link.range(marks[0].to, marks[1].from));
            }
            const reveal = touches(state, ref.from, ref.to);
            for (const child of [
              ...marks,
              ...node.getChildren("URL"),
              ...node.getChildren("LinkTitle"),
              ...node.getChildren("LinkLabel"),
            ]) {
              if (child.to > child.from)
                decos.push((reveal ? dim : hidden).range(child.from, child.to));
            }
            return;
          }
          case "Autolink":
          case "URL":
            // Bare GFM autolinks (URL nodes outside a Link) render as links.
            if (name === "Autolink" || node.parent?.name === "Paragraph") {
              decos.push(link.range(ref.from, ref.to));
            }
            return false;
          case "Escape":
            if (!touches(state, ref.from, ref.to)) decos.push(hidden.range(ref.from, ref.from + 1));
            return false;
        }
        return;
      },
    });
  }
  return Decoration.set(decos, true);
}

interface InlineOptions {
  /** Whether tables, frontmatter and mermaid fences are replaced by `renderedBlocks`. */
  renderBlocks: boolean;
  resolveImageUrl?: (src: string) => string | undefined;
}

function inlineDecorations(opts: InlineOptions): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildInlineDecorations(view, opts);
      }
      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.selectionSet ||
          update.focusChanged ||
          syntaxTree(update.startState) !== syntaxTree(update.state)
        ) {
          this.decorations = buildInlineDecorations(update.view, opts);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}

// ---------------------------------------------------------------------------
// Styling
// ---------------------------------------------------------------------------

/**
 * Syntax colours for fenced code only. Markdown's own tags (heading,
 * emphasis, …) are left unstyled here because the decorations above render
 * them.
 */
function codeHighlightStyle(isDark: boolean): HighlightStyle {
  const c = isDark
    ? {
        kw: "#c586c0",
        str: "#ce9178",
        num: "#b5cea8",
        cmt: "#6a9955",
        fn: "#dcdcaa",
        type: "#4ec9b0",
        prop: "#9cdcfe",
      }
    : {
        kw: "#af00db",
        str: "#a31515",
        num: "#098658",
        cmt: "#008000",
        fn: "#795e26",
        type: "#267f99",
        prop: "#001080",
      };
  return HighlightStyle.define([
    {
      tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword, tags.operatorKeyword],
      color: c.kw,
    },
    { tag: [tags.string, tags.special(tags.string), tags.regexp], color: c.str },
    { tag: [tags.number, tags.bool, tags.null, tags.atom], color: c.num },
    { tag: [tags.comment, tags.lineComment, tags.blockComment], color: c.cmt, fontStyle: "italic" },
    { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: c.fn },
    { tag: [tags.typeName, tags.className, tags.namespace], color: c.type },
    { tag: [tags.propertyName, tags.attributeName], color: c.prop },
  ]);
}

function livePreviewTheme(isDark: boolean): Extension {
  const muted = isDark ? "rgba(255,255,255,0.45)" : "rgba(0,0,0,0.45)";
  const codeBg = isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.05)";
  const border = isDark ? "rgba(255,255,255,0.15)" : "rgba(0,0,0,0.15)";
  return EditorView.theme(
    {
      "&": { height: "100%", fontSize: "14px", backgroundColor: "var(--background)" },
      "&.cm-focused": { outline: "none" },
      ".cm-scroller": {
        overflow: "auto",
        fontFamily: "inherit",
        lineHeight: "1.65",
      },
      ".cm-content": {
        maxWidth: "48rem",
        margin: "0 auto",
        padding: "24px 32px 40vh",
        caretColor: "var(--foreground)",
        color: "var(--foreground)",
      },
      ".cm-line": { padding: "0" },
      "&.cm-focused .cm-cursor": { borderLeftColor: "var(--foreground)" },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
        backgroundColor: isDark ? "rgba(120,160,255,0.25)" : "rgba(0,90,255,0.15)",
      },
      ".cm-searchMatch": { backgroundColor: "rgba(255, 213, 0, 0.4)", borderRadius: "2px" },
      ".cm-searchMatch-selected": { backgroundColor: "rgba(255, 150, 50, 0.55)" },

      ".cm-md-heading": { fontWeight: "600", lineHeight: "1.3" },
      ".cm-md-h1": { fontSize: "1.9em", paddingTop: "0.6em", paddingBottom: "0.2em" },
      ".cm-md-h2": { fontSize: "1.5em", paddingTop: "0.5em", paddingBottom: "0.15em" },
      ".cm-md-h3": { fontSize: "1.25em", paddingTop: "0.4em" },
      ".cm-md-h4": { fontSize: "1.1em", paddingTop: "0.3em" },
      ".cm-md-h5, .cm-md-h6": { fontSize: "1em", paddingTop: "0.2em" },
      ".cm-md-strong": { fontWeight: "700" },
      ".cm-md-em": { fontStyle: "italic" },
      ".cm-md-strike": { textDecoration: "line-through" },
      ".cm-md-code": {
        fontFamily: "var(--font-mono, ui-monospace, monospace)",
        fontSize: "0.9em",
        backgroundColor: codeBg,
        borderRadius: "4px",
        padding: "0.1em 0.3em",
      },
      ".cm-md-link": { color: isDark ? "#6cb6ff" : "#0969da", textDecoration: "underline" },
      ".cm-md-syntax": { color: muted },
      ".cm-md-bullet": { color: muted, display: "inline-block", width: "1ch" },
      ".cm-md-task": { margin: "0 0.35em 0 0", verticalAlign: "middle", cursor: "pointer" },
      ".cm-md-blockquote": {
        borderLeft: `3px solid ${border}`,
        paddingLeft: "1em !important",
        color: muted,
      },
      ".cm-md-codeblock": {
        fontFamily: "var(--font-mono, ui-monospace, monospace)",
        fontSize: "0.88em",
        backgroundColor: codeBg,
        padding: "0 1em !important",
      },
      ".cm-md-fence": { color: muted },
      ".cm-md-source-block": {
        fontFamily: "var(--font-mono, ui-monospace, monospace)",
        fontSize: "0.88em",
      },
      ".cm-md-hr": {
        display: "inline-block",
        width: "100%",
        verticalAlign: "middle",
        borderTop: `1px solid ${border}`,
      },
      ".cm-md-image": { maxWidth: "100%" },
      ".cm-md-block": { padding: "0.4em 0", cursor: "text" },
    },
    { dark: isDark },
  );
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/** Languages for fenced code blocks, loaded on first use through `loadLanguage`. */
const CODE_LANGUAGES: Array<[name: string, aliases: string[]]> = [
  ["javascript", ["js", "mjs", "cjs"]],
  ["jsx", []],
  ["typescript", ["ts", "mts", "cts"]],
  ["tsx", []],
  ["python", ["py"]],
  ["html", []],
  ["css", []],
  ["scss", []],
  ["json", ["jsonc"]],
  ["yaml", ["yml"]],
  ["sql", []],
  ["rust", ["rs"]],
  ["go", ["golang"]],
  ["java", []],
  ["cpp", ["c++", "c"]],
  ["php", []],
  ["bash", ["sh", "shell", "zsh", "console"]],
  ["ruby", ["rb"]],
  ["toml", []],
  ["diff", ["patch"]],
  ["xml", []],
];

const codeLanguages = CODE_LANGUAGES.map(([name, alias]) =>
  LanguageDescription.of({
    name,
    alias,
    load: async () => {
      const support = await loadLanguage(name);
      if (!support) throw new Error(`No language support for ${name}`);
      return support;
    },
  }),
);

/**
 * All extensions for the editable markdown preview. Used instead of
 * `baseEditorExtensions`: no gutters, wrapped lines, prose styling.
 */
export function markdownLivePreviewExtensions(opts: MarkdownLivePreviewOptions): Extension[] {
  return [
    history(),
    EditorView.lineWrapping,
    EditorState.tabSize.of(4),
    focusedField,
    focusTracking,
    searchRevealField,
    frontmatterField,
    // Adds GFM (tables, task lists, strikethrough, autolinks) and the
    // list-continuing Enter / marker-aware Backspace keymap.
    markdown({ base: markdownLanguage, codeLanguages }),
    syntaxHighlighting(codeHighlightStyle(opts.isDark)),
    inlineDecorations({ renderBlocks: !!opts.renderBlock, resolveImageUrl: opts.resolveImageUrl }),
    ...(opts.renderBlock ? [renderedBlocks(opts.renderBlock)] : []),
    livePreviewTheme(opts.isDark),
    keymap.of([
      ...(opts.onSave
        ? [
            {
              key: "Mod-s",
              run: () => {
                opts.onSave?.();
                return true;
              },
            },
          ]
        : []),
      { key: "Tab", run: indentMore },
      { key: "Shift-Tab", run: indentLess },
      ...defaultKeymap,
      ...historyKeymap,
      { key: "Mod-z", run: () => true },
      { key: "Mod-Shift-z", run: () => true },
      { key: "Mod-y", run: () => true },
    ]),
    // Same as the code editor: keep keys the editor owns from reaching
    // window-level handlers.
    EditorView.domEventHandlers({
      keydown(event) {
        const mod = event.metaKey || event.ctrlKey;
        const key = event.key.toLowerCase();
        if (event.key === "Tab" || (mod && (key === "z" || key === "y"))) {
          event.stopPropagation();
        }
        return false;
      },
    }),
  ];
}
