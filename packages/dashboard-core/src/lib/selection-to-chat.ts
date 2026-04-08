import { type Extension, StateEffect, StateField } from "@codemirror/state";
import { EditorView, showTooltip, type Tooltip, ViewPlugin } from "@codemirror/view";

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

/** Minimum number of characters selected before showing the button. */
const MIN_SELECTION_LENGTH = 1;

/** Delay in ms before showing the tooltip after selection stabilises. */
const SHOW_DELAY_MS = 500;

/** Effect used by the debounce plugin to set/clear the tooltip. */
const setSelectionTooltip = StateEffect.define<Tooltip | null>();

/**
 * CodeMirror extension that shows a floating "Add to Chat" button when the
 * user selects text. The button appears after a short delay so it doesn't
 * flash during casual clicking. Clicking the button dispatches a
 * `band:add-to-chat` CustomEvent on `window` with a
 * {@link SelectionToChatDetail} payload.
 *
 * @param filePath - The workspace-relative file path shown in the reference.
 */
export function selectionToChatExtension(filePath: string): Extension {
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

    /** Build a Tooltip for the current selection, or null to hide. */
    function buildTooltip(): Tooltip | null {
      const sel = view.state.selection.main;
      if (sel.empty || sel.to - sel.from < MIN_SELECTION_LENGTH) return null;

      return {
        pos: sel.head,
        above: true,
        strictSide: true,
        arrow: false,
        create(view: EditorView) {
          const dom = document.createElement("div");
          dom.className = "cm-add-to-chat-tooltip";

          const btn = document.createElement("button");
          btn.className = "cm-add-to-chat-btn";
          btn.setAttribute("type", "button");

          // Chat bubble icon (Lucide MessageSquare, 14×14)
          const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
          svg.setAttribute("width", "14");
          svg.setAttribute("height", "14");
          svg.setAttribute("viewBox", "0 0 24 24");
          svg.setAttribute("fill", "none");
          svg.setAttribute("stroke", "currentColor");
          svg.setAttribute("stroke-width", "2");
          svg.setAttribute("stroke-linecap", "round");
          svg.setAttribute("stroke-linejoin", "round");
          const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
          path.setAttribute("d", "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z");
          svg.appendChild(path);
          btn.appendChild(svg);

          const label = document.createElement("span");
          label.textContent = "Add to Chat";
          btn.appendChild(label);

          // Use mousedown + preventDefault so clicking the button doesn't
          // deselect the text or blur the editor before we can read it.
          btn.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();

            const { from, to } = view.state.selection.main;
            if (from === to) return;

            const selectedText = view.state.sliceDoc(from, to);
            const startLine = view.state.doc.lineAt(from).number;
            const endLine = view.state.doc.lineAt(to).number;

            const detail: SelectionToChatDetail = {
              filePath,
              selectedText,
              startLine,
              endLine,
            };

            window.dispatchEvent(new CustomEvent("band:add-to-chat", { detail }));

            // Collapse selection and hide tooltip
            view.dispatch({
              selection: { anchor: from },
              effects: setSelectionTooltip.of(null),
            });
          });

          dom.appendChild(btn);
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
