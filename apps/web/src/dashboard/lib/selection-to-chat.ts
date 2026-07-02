import { type Extension, StateEffect, StateField } from "@codemirror/state";
import { EditorView, showTooltip, type Tooltip, ViewPlugin } from "@codemirror/view";
import { writeClipboardText } from "../../lib/clipboard";

/**
 * Payload dispatched via the `band:add-to-chat` window CustomEvent when the
 * user clicks "Add to Chat" on a text selection inside a CodeMirror editor.
 */
export interface SelectionToChatDetail {
  filePath: string;
  selectedText: string;
  /** 1-based start line of the selection */
  startLine: number;
  /** 1-based end line of the selection */
  endLine: number;
}

/**
 * Payload dispatched via the `band:add-to-terminal` window CustomEvent when the
 * user clicks "Add to Terminal" on a text selection. This is the *intent*
 * event: the selection tooltip doesn't know which workspace it belongs to, so
 * the shared dockview layout (which does) listens, surfaces the terminal panel
 * for the active workspace, and re-dispatches the scoped `band:terminal-insert`
 * delivery event below. The reference string is pre-built so consumers stay
 * decoupled from the formatting logic.
 */
export interface AddToTerminalDetail {
  /**
   * The file reference to type into the terminal. The dispatcher appends a
   * trailing space to the bare `buildLineReference` output (so the result is
   * e.g. `"src/foo.ts:10-20 "`) to separate it from the next keystroke; the
   * builder itself never emits the space.
   */
  reference: string;
}

/**
 * Payload dispatched via the `band:terminal-insert` window CustomEvent by the
 * shared dockview layout after it has surfaced the active workspace's terminal.
 * Carries the resolved `workspaceId` so each mounted `TerminalPanel` (one per
 * terminal session × one per cached workspace) only reacts when the delivery
 * targets its own workspace — preventing a reference from leaking into a cached
 * background workspace's terminal.
 */
export interface TerminalInsertDetail {
  /**
   * The file reference to type into the terminal, carried through verbatim from
   * {@link AddToTerminalDetail.reference} (already includes the dispatcher's
   * trailing space, e.g. `"src/foo.ts:10-20 "`).
   */
  reference: string;
  /** The workspace whose terminal should receive the reference. */
  workspaceId: string;
  /**
   * The specific terminal that should receive the reference — the workspace's
   * last-focused terminal, resolved by `SharedDockviewLayout` from the server's
   * panel-focus record. When absent (no focus recorded yet), each mounted
   * `TerminalPanel` falls back to accepting the reference if it's the currently
   * *visible* terminal, preserving the pre-focus-tracking behavior.
   */
  terminalId?: string;
}

/**
 * Payload dispatched via the `band:chat-insert` window CustomEvent by
 * `SharedDockviewLayout` after it has resolved the workspace's last-focused
 * chat and surfaced the Chat panel. The chat mirror of
 * {@link TerminalInsertDetail}: each mounted `PromptInput` (one per chat pane ×
 * one per cached workspace) only appends the reference when the delivery
 * targets its own workspace AND its own chat, so a reference never leaks into
 * a sibling pane or a cached background workspace.
 */
export interface ChatInsertDetail {
  /** The workspace-relative file path shown in the reference. */
  filePath: string;
  /** 1-based start line of the selection. */
  startLine: number;
  /** 1-based end line of the selection. */
  endLine: number;
  /** The workspace whose chat should receive the reference. */
  workspaceId: string;
  /**
   * The specific chat pane that should receive the reference — the workspace's
   * last-focused chat. When absent (no focus recorded yet), the currently
   * *visible* chat pane accepts it instead.
   */
  chatId?: string;
}

/**
 * Build a bare file reference for a line range, e.g. `src/foo.ts:10-20` (or
 * `src/foo.ts:10` when the range is a single line). Shared by the chat,
 * terminal, and copy actions so every option produces an identical reference.
 */
export function buildLineReference(filePath: string, startLine: number, endLine: number): string {
  return startLine === endLine ? `${filePath}:${startLine}` : `${filePath}:${startLine}-${endLine}`;
}

/** Minimum number of characters selected before showing the button. */
const MIN_SELECTION_LENGTH = 1;

/** Delay in ms before showing the tooltip after selection stabilises. */
const SHOW_DELAY_MS = 500;

/** Effect used by the debounce plugin to set/clear the tooltip. */
const setSelectionTooltip = StateEffect.define<Tooltip | null>();

/** SVG `<path d>`/`<line>`/`<polyline>` definitions for each button's icon. */
type IconChild =
  | { tag: "path"; d: string }
  | { tag: "line"; x1: string; y1: string; x2: string; y2: string }
  | { tag: "polyline"; points: string }
  | { tag: "rect"; x: string; y: string; width: string; height: string; rx: string };

const SVG_NS = "http://www.w3.org/2000/svg";

/** Build a 14×14 Lucide-style stroke icon from child element definitions. */
function makeIcon(children: IconChild[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  for (const child of children) {
    const el = document.createElementNS(SVG_NS, child.tag);
    if (child.tag === "path") el.setAttribute("d", child.d);
    else if (child.tag === "polyline") el.setAttribute("points", child.points);
    else if (child.tag === "line") {
      el.setAttribute("x1", child.x1);
      el.setAttribute("y1", child.y1);
      el.setAttribute("x2", child.x2);
      el.setAttribute("y2", child.y2);
    } else {
      el.setAttribute("x", child.x);
      el.setAttribute("y", child.y);
      el.setAttribute("width", child.width);
      el.setAttribute("height", child.height);
      el.setAttribute("rx", child.rx);
    }
    svg.appendChild(el);
  }
  return svg;
}

// Lucide icon path data (https://lucide.dev).
const ICON_CHAT: IconChild[] = [
  { tag: "path", d: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" },
];
const ICON_TERMINAL: IconChild[] = [
  { tag: "polyline", points: "4 17 10 11 4 5" },
  { tag: "line", x1: "12", y1: "19", x2: "20", y2: "19" },
];
const ICON_COPY: IconChild[] = [
  { tag: "rect", x: "8", y: "8", width: "14", height: "14", rx: "2" },
  { tag: "path", d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" },
];

/**
 * CodeMirror extension that shows a floating "Add to Chat" button when the
 * user selects text. The button appears after a short delay so it doesn't
 * flash during casual clicking. Clicking the button dispatches a
 * `band:add-to-chat` CustomEvent on `window` with a
 * {@link SelectionToChatDetail} payload.
 *
 * @param filePath - The workspace-relative file path shown in the reference.
 * @param lineNumberMap - Optional 0-indexed array mapping document line numbers
 *   to actual file line numbers. When provided, the dispatched event will use
 *   the mapped line numbers instead of the raw document line numbers. This is
 *   used by the diff view where trimmed content starts at a line offset.
 */
export function selectionToChatExtension(filePath: string, lineNumberMap?: number[]): Extension {
  // --- StateField: holds the current tooltip (set via effect) ----------------

  const tooltipField = StateField.define<Tooltip | null>({
    create() {
      return null;
    },
    update(value, tr) {
      for (const e of tr.effects) {
        if (e.is(setSelectionTooltip)) return e.value;
      }
      return value;
    },
    provide: (f) => showTooltip.from(f),
  });

  // --- ViewPlugin: debounces selection changes and dispatches the effect ------

  const debouncePlugin = ViewPlugin.define((view) => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    function clearTimer() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    }

    /**
     * Read the current selection and resolve it to a file reference, applying
     * the optional line-number map (e.g. diff view with trimmed content) so the
     * reported lines match the real file. Returns null when nothing is selected.
     */
    function readSelection(): SelectionToChatDetail | null {
      const { from, to } = view.state.selection.main;
      if (from === to) return null;

      const selectedText = view.state.sliceDoc(from, to);
      const docStartLine = view.state.doc.lineAt(from).number;
      const docEndLine = view.state.doc.lineAt(to).number;
      const startLine =
        lineNumberMap && docStartLine >= 1 && docStartLine <= lineNumberMap.length
          ? lineNumberMap[docStartLine - 1]
          : docStartLine;
      const endLine =
        lineNumberMap && docEndLine >= 1 && docEndLine <= lineNumberMap.length
          ? lineNumberMap[docEndLine - 1]
          : docEndLine;

      return { filePath, selectedText, startLine, endLine };
    }

    /** Build a Tooltip for the current selection, or null to hide. */
    function buildTooltip(): Tooltip | null {
      const sel = view.state.selection.main;
      if (sel.empty || sel.to - sel.from < MIN_SELECTION_LENGTH) return null;

      return {
        pos: sel.head,
        // Prefer rendering below the selection so the buttons don't cover the
        // selected text. `strictSide: false` lets CodeMirror flip back above
        // when there isn't enough room below (e.g. a selection near the bottom
        // edge of the editor) instead of clipping the tooltip.
        above: false,
        strictSide: false,
        arrow: false,
        // Named `tooltipView` to avoid shadowing the outer `view` that
        // `readSelection` closes over (same instance, but the distinct name
        // keeps the data flow clear).
        create(tooltipView: EditorView) {
          const dom = document.createElement("div");
          dom.className = "cm-add-to-chat-tooltip";

          /**
           * Create a tooltip button. `onActivate` receives the resolved
           * selection; after it runs the selection is collapsed and the
           * tooltip hidden. Uses mousedown + preventDefault so clicking the
           * button doesn't deselect the text or blur the editor before we can
           * read it.
           */
          function makeButton(
            label: string,
            icon: IconChild[],
            testId: string,
            onActivate: (detail: SelectionToChatDetail) => void,
          ): HTMLButtonElement {
            const btn = document.createElement("button");
            btn.className = "cm-add-to-chat-btn";
            btn.setAttribute("type", "button");
            btn.setAttribute("data-testid", testId);
            btn.appendChild(makeIcon(icon));

            const span = document.createElement("span");
            span.textContent = label;
            btn.appendChild(span);

            btn.addEventListener("mousedown", (e) => {
              e.preventDefault();
              e.stopPropagation();

              const detail = readSelection();
              if (!detail) return;

              onActivate(detail);

              // Collapse selection and hide tooltip
              tooltipView.dispatch({
                selection: { anchor: tooltipView.state.selection.main.from },
                effects: setSelectionTooltip.of(null),
              });
            });
            return btn;
          }

          dom.appendChild(
            makeButton("Add to Chat", ICON_CHAT, "selection-tooltip__add-to-chat", (detail) => {
              window.dispatchEvent(new CustomEvent("band:add-to-chat", { detail }));
            }),
          );

          dom.appendChild(
            makeButton(
              "Add to Terminal",
              ICON_TERMINAL,
              "selection-tooltip__add-to-terminal",
              (detail) => {
                // Trailing space mirrors the chat reference's typing ergonomics;
                // no newline so the terminal agent decides when to submit.
                const reference = `${buildLineReference(detail.filePath, detail.startLine, detail.endLine)} `;
                window.dispatchEvent(
                  new CustomEvent<AddToTerminalDetail>("band:add-to-terminal", {
                    detail: { reference },
                  }),
                );
              },
            ),
          );

          dom.appendChild(
            makeButton(
              "Copy reference",
              ICON_COPY,
              "selection-tooltip__copy-reference",
              (detail) => {
                void writeClipboardText(
                  buildLineReference(detail.filePath, detail.startLine, detail.endLine),
                );
              },
            ),
          );

          return { dom };
        },
      };
    }

    /**
     * Schedule showing or hiding the tooltip. All `view.dispatch()` calls
     * happen inside `setTimeout` so they never run synchronously within a
     * CodeMirror update cycle (which would be silently dropped).
     */
    function schedule(immediate: boolean) {
      clearTimer();
      timer = setTimeout(
        () => {
          timer = null;
          view.dispatch({ effects: setSelectionTooltip.of(buildTooltip()) });
        },
        immediate ? 0 : SHOW_DELAY_MS,
      );
    }

    return {
      update(update) {
        if (update.selectionSet) {
          const sel = update.state.selection.main;
          // Hide immediately (but still deferred via setTimeout 0) when
          // selection is cleared; show after the full delay otherwise.
          schedule(sel.empty || sel.to - sel.from < MIN_SELECTION_LENGTH);
        }
      },
      destroy() {
        clearTimer();
      },
    };
  });

  // --- Theme -----------------------------------------------------------------

  const theme = EditorView.theme({
    ".cm-tooltip.cm-add-to-chat-tooltip": {
      backgroundColor: "transparent",
      border: "none",
      zIndex: "100",
      display: "flex",
      gap: "4px",
    },
    ".cm-add-to-chat-btn": {
      display: "inline-flex",
      alignItems: "center",
      gap: "4px",
      padding: "3px 10px",
      fontSize: "12px",
      fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
      fontWeight: "500",
      lineHeight: "1.4",
      color: "var(--foreground, #e4e4e7)",
      backgroundColor: "var(--popover, #18181b)",
      border: "1px solid var(--border, #27272a)",
      borderRadius: "6px",
      cursor: "pointer",
      boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
      whiteSpace: "nowrap",
      transition: "background-color 120ms ease, border-color 120ms ease",
    },
    ".cm-add-to-chat-btn:hover": {
      backgroundColor: "var(--accent, #27272a)",
      borderColor: "var(--ring, #3f3f46)",
    },
  });

  return [tooltipField, debouncePlugin, theme];
}
