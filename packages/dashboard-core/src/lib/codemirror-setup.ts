import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  LanguageSupport,
  StreamLanguage,
  syntaxHighlighting,
} from "@codemirror/language";
import { highlightSelectionMatches, SearchQuery } from "@codemirror/search";
import {
  EditorState,
  type Extension,
  type Range,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  type KeyBinding,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { vscodeDarkInit } from "@uiw/codemirror-theme-vscode";

/**
 * Lazy-loads a CodeMirror LanguageSupport for the given language name.
 * Language names match those from language-map.ts (e.g. "javascript", "python").
 * Returns null for unsupported languages (renders without highlighting).
 */
export async function loadLanguage(lang: string): Promise<LanguageSupport | null> {
  try {
    switch (lang) {
      case "javascript":
        return import("@codemirror/lang-javascript").then((m) => m.javascript());
      case "jsx":
        return import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true }));
      case "typescript":
        return import("@codemirror/lang-javascript").then((m) =>
          m.javascript({ typescript: true }),
        );
      case "tsx":
        return import("@codemirror/lang-javascript").then((m) =>
          m.javascript({ jsx: true, typescript: true }),
        );
      case "python":
        return import("@codemirror/lang-python").then((m) => m.python());
      case "html":
        return import("@codemirror/lang-html").then((m) => m.html());
      case "css":
        return import("@codemirror/lang-css").then((m) => m.css());
      case "scss":
      case "sass":
        return import("@codemirror/lang-sass").then((m) => m.sass());
      case "less":
        return import("@codemirror/lang-less").then((m) => m.less());
      case "json":
      case "jsonc":
        return import("@codemirror/lang-json").then((m) => m.json());
      case "markdown":
      case "mdx":
        return import("@codemirror/lang-markdown").then((m) => m.markdown());
      case "xml":
        return import("@codemirror/lang-xml").then((m) => m.xml());
      case "yaml":
        return import("@codemirror/lang-yaml").then((m) => m.yaml());
      case "sql":
        return import("@codemirror/lang-sql").then((m) => m.sql());
      case "rust":
        return import("@codemirror/lang-rust").then((m) => m.rust());
      case "go":
        return import("@codemirror/lang-go").then((m) => m.go());
      case "java":
        return import("@codemirror/lang-java").then((m) => m.java());
      case "kotlin":
        return import("@codemirror/lang-java").then((m) => m.java());
      case "c":
      case "cpp":
        return import("@codemirror/lang-cpp").then((m) => m.cpp());
      case "php":
        return import("@codemirror/lang-php").then((m) => m.php());
      // Legacy modes via StreamLanguage
      case "bash":
      case "fish":
      case "powershell":
        return import("@codemirror/legacy-modes/mode/shell").then(
          ({ shell }) => new LanguageSupport(StreamLanguage.define(shell)),
        );
      case "ruby":
        return import("@codemirror/legacy-modes/mode/ruby").then(
          ({ ruby }) => new LanguageSupport(StreamLanguage.define(ruby)),
        );
      case "dockerfile":
        return import("@codemirror/legacy-modes/mode/dockerfile").then(
          ({ dockerFile }) => new LanguageSupport(StreamLanguage.define(dockerFile)),
        );
      case "toml":
        return import("@codemirror/legacy-modes/mode/toml").then(
          ({ toml }) => new LanguageSupport(StreamLanguage.define(toml)),
        );
      case "lua":
        return import("@codemirror/legacy-modes/mode/lua").then(
          ({ lua }) => new LanguageSupport(StreamLanguage.define(lua)),
        );
      case "r":
        return import("@codemirror/legacy-modes/mode/r").then(
          ({ r }) => new LanguageSupport(StreamLanguage.define(r)),
        );
      case "swift":
        return import("@codemirror/legacy-modes/mode/swift").then(
          ({ swift }) => new LanguageSupport(StreamLanguage.define(swift)),
        );
      case "clojure":
        return import("@codemirror/legacy-modes/mode/clojure").then(
          ({ clojure }) => new LanguageSupport(StreamLanguage.define(clojure)),
        );
      case "erlang":
        return import("@codemirror/legacy-modes/mode/erlang").then(
          ({ erlang }) => new LanguageSupport(StreamLanguage.define(erlang)),
        );
      case "haskell":
        return import("@codemirror/legacy-modes/mode/haskell").then(
          ({ haskell }) => new LanguageSupport(StreamLanguage.define(haskell)),
        );
      case "diff":
        return import("@codemirror/legacy-modes/mode/diff").then(
          ({ diff }) => new LanguageSupport(StreamLanguage.define(diff)),
        );
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Base extensions for a read-only CodeMirror viewer.
 * @param isDark - Whether to use dark theme colours. Defaults to true for backwards compat.
 * @param opts.skipLineNumbers - When true, omit the default lineNumbers() extension
 *   so callers can supply a custom one (e.g. with remapped line numbers for diffs).
 */
export function baseViewerExtensions(
  isDark = true,
  opts?: { skipLineNumbers?: boolean },
): Extension[] {
  return [
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    ...(opts?.skipLineNumbers ? [] : [lineNumbers()]),
    bracketMatching(),
    highlightSelectionMatches(),
    ...(isDark
      ? [
          vscodeDarkInit({
            settings: {
              background: "var(--background)",
              gutterBackground: "var(--background)",
              lineHighlight: "transparent",
            },
          }),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        ]
      : [syntaxHighlighting(defaultHighlightStyle)]),
    keymap.of([...defaultKeymap]),
    // Viewer-specific overrides
    EditorView.theme(
      isDark
        ? {
            "&": { height: "100%", fontSize: "13px" },
            ".cm-scroller": { overflow: "auto" },
            ".cm-lineNumbers": { paddingLeft: "12px", paddingRight: "12px" },
            ".cm-activeLineGutter": { backgroundColor: "transparent" },
            ".cm-searchMatch": {
              backgroundColor: "rgba(255, 213, 0, 0.35)",
              borderRadius: "2px",
            },
            ".cm-searchMatch-selected": {
              backgroundColor: "rgba(255, 150, 50, 0.5)",
            },
          }
        : {
            "&": { height: "100%", fontSize: "13px", backgroundColor: "var(--background)" },
            ".cm-scroller": { overflow: "auto" },
            ".cm-lineNumbers": { paddingLeft: "12px", paddingRight: "12px" },
            ".cm-gutters": {
              backgroundColor: "var(--background)",
              border: "none",
              color: "#6e7781",
            },
            ".cm-activeLineGutter": { backgroundColor: "transparent" },
            ".cm-activeLine": { backgroundColor: "transparent" },
            "&.cm-focused .cm-cursor": { borderLeftColor: "#24292f" },
            "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
              backgroundColor: "rgba(0, 0, 0, 0.07)",
            },
            ".cm-line": { color: "#24292f" },
            ".cm-searchMatch": {
              backgroundColor: "rgba(255, 213, 0, 0.4)",
              borderRadius: "2px",
            },
            ".cm-searchMatch-selected": {
              backgroundColor: "rgba(255, 150, 50, 0.55)",
            },
          },
      { dark: isDark },
    ),
  ];
}

/**
 * Base extensions for an editable CodeMirror editor.
 * Includes editing features: undo/redo, indent-on-input, fold gutter.
 * Does NOT include readOnly or editable(false).
 * @param isDark - Whether to use dark theme colours. Defaults to true for backwards compat.
 * @param onSave - Optional callback invoked on Cmd/Ctrl+S.
 */
export function baseEditorExtensions(isDark = true, onSave?: () => void): Extension[] {
  const saveKeyBinding: KeyBinding[] = onSave
    ? [
        {
          key: "Mod-s",
          run: () => {
            onSave();
            return true;
          },
        },
      ]
    : [];

  return [
    lineNumbers(),
    history(),
    foldGutter(),
    bracketMatching(),
    indentOnInput(),
    highlightSelectionMatches(),
    ...(isDark
      ? [
          vscodeDarkInit({
            settings: {
              background: "var(--background)",
              gutterBackground: "var(--background)",
            },
          }),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        ]
      : [syntaxHighlighting(defaultHighlightStyle)]),
    keymap.of([...saveKeyBinding, ...defaultKeymap, ...historyKeymap, ...foldKeymap]),
    EditorView.theme(
      isDark
        ? {
            "&": { height: "100%", fontSize: "13px" },
            ".cm-scroller": { overflow: "auto" },
            ".cm-lineNumbers": { paddingLeft: "12px", paddingRight: "12px" },
            ".cm-activeLine": { backgroundColor: "rgba(255,255,255,0.03)" },
            ".cm-activeLineGutter": { backgroundColor: "rgba(255,255,255,0.03)" },
            ".cm-searchMatch": {
              backgroundColor: "rgba(255, 213, 0, 0.35)",
              borderRadius: "2px",
            },
            ".cm-searchMatch-selected": {
              backgroundColor: "rgba(255, 150, 50, 0.5)",
            },
          }
        : {
            "&": { height: "100%", fontSize: "13px", backgroundColor: "var(--background)" },
            ".cm-scroller": { overflow: "auto" },
            ".cm-lineNumbers": { paddingLeft: "12px", paddingRight: "12px" },
            ".cm-gutters": {
              backgroundColor: "var(--background)",
              border: "none",
              color: "#6e7781",
            },
            ".cm-activeLine": { backgroundColor: "rgba(0,0,0,0.03)" },
            ".cm-activeLineGutter": { backgroundColor: "rgba(0,0,0,0.03)" },
            "&.cm-focused .cm-cursor": { borderLeftColor: "#24292f" },
            "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
              backgroundColor: "rgba(0, 0, 0, 0.07)",
            },
            ".cm-line": { color: "#24292f" },
            ".cm-searchMatch": {
              backgroundColor: "rgba(255, 213, 0, 0.4)",
              borderRadius: "2px",
            },
            ".cm-searchMatch-selected": {
              backgroundColor: "rgba(255, 150, 50, 0.55)",
            },
          },
      { dark: isDark },
    ),
  ];
}

// ---------------------------------------------------------------------------
// Search highlight extension (custom — replaces @codemirror/search's built-in
// searchHighlighter to avoid module-identity issues with setSearchQuery)
// ---------------------------------------------------------------------------

/** Effect that replaces the current search-match decorations. */
const setSearchDecorations = StateEffect.define<DecorationSet>();

const searchMatchMark = Decoration.mark({ class: "cm-searchMatch" });

/** StateField that holds search-match decorations. */
const searchHighlightField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setSearchDecorations)) return effect.value;
    }
    // Map existing decorations through document changes so positions stay correct.
    return value.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

/**
 * Extension that enables search-match highlighting via `dispatchSearch`.
 * Include this in editor extensions to support find-in-file highlighting.
 */
export function searchHighlightOnly(): Extension {
  return searchHighlightField;
}

/** Build a sorted DecorationSet for the given query against a view. */
function buildSearchDecorations(view: EditorView, query: string, opts?: SearchOpts): DecorationSet {
  if (!query) return Decoration.none;
  const cmQuery = makeSearchQuery(query, opts);
  const builder = new RangeSetBuilder<Decoration>();
  const cursor = cmQuery.getCursor(view.state);
  let result = cursor.next();
  while (!result.done) {
    builder.add(result.value.from, result.value.to, searchMatchMark);
    result = cursor.next();
  }
  return builder.finish();
}

type SearchOpts = { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean };

function makeSearchQuery(query: string, opts?: SearchOpts): SearchQuery {
  return new SearchQuery({
    search: query,
    caseSensitive: opts?.caseSensitive ?? false,
    literal: !opts?.regex,
    regexp: opts?.regex ?? false,
    wholeWord: opts?.wholeWord ?? false,
  });
}

/**
 * Dispatches a search query to one or more CodeMirror `EditorView` instances.
 * Highlights matches inside each editor.
 */
export function dispatchSearch(views: EditorView[], query: string, opts?: SearchOpts): void {
  for (const view of views) {
    view.dispatch({
      effects: setSearchDecorations.of(buildSearchDecorations(view, query, opts)),
    });
  }
}

/**
 * Counts all matches in the given editor views and returns them as an ordered
 * list of `{ view, from, to }` objects suitable for next/prev navigation.
 */
export function collectSearchMatches(
  views: EditorView[],
  query: string,
  opts?: SearchOpts,
): Array<{ view: EditorView; from: number; to: number }> {
  if (!query) return [];
  const cmQuery = makeSearchQuery(query, opts);
  const matches: Array<{ view: EditorView; from: number; to: number }> = [];
  for (const view of views) {
    const cursor = cmQuery.getCursor(view.state);
    let result = cursor.next();
    while (!result.done) {
      matches.push({ view, from: result.value.from, to: result.value.to });
      result = cursor.next();
    }
  }
  return matches;
}

/**
 * Selects the given match range and scrolls it into view (centered).
 */
export function scrollToSearchMatch(match: { view: EditorView; from: number; to: number }): void {
  match.view.dispatch({
    selection: { anchor: match.from, head: match.to },
    effects: EditorView.scrollIntoView(match.from, { y: "center" }),
  });
}

/**
 * Clears search highlights and collapses the selection in all given views.
 */
export function clearSearch(views: EditorView[]): void {
  for (const view of views) {
    view.dispatch({
      effects: setSearchDecorations.of(Decoration.none),
      selection: { anchor: view.state.selection.main.head },
    });
  }
}

// ---------------------------------------------------------------------------
// Line highlight extension
// ---------------------------------------------------------------------------

/** Effect to set or clear the highlighted line range. */
export const setHighlightLines = StateEffect.define<{
  from: number;
  to: number;
} | null>();

const highlightLineDeco = Decoration.line({ class: "cm-highlighted-line" });

const highlightLineField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(decos, tr) {
    for (const e of tr.effects) {
      if (e.is(setHighlightLines)) {
        if (!e.value) return Decoration.none;
        const { from, to } = e.value;
        const doc = tr.state.doc;
        const decorations: Range<Decoration>[] = [];
        for (let line = from; line <= to && line <= doc.lines; line++) {
          decorations.push(highlightLineDeco.range(doc.line(line).from));
        }
        return Decoration.set(decorations);
      }
    }
    return decos;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/**
 * Extension that enables line highlighting via the setHighlightLines effect.
 * Include this in the editor's extensions to support scroll-to-line + highlight.
 */
export function lineHighlightExtension(isDark = true): Extension[] {
  return [
    highlightLineField,
    EditorView.theme(
      {
        ".cm-highlighted-line": {
          backgroundColor: isDark ? "rgba(255, 213, 79, 0.12)" : "rgba(255, 213, 79, 0.25)",
        },
      },
      { dark: isDark },
    ),
  ];
}

/**
 * Scrolls the editor to the given 1-based line, highlights the range,
 * and places the cursor at the target position.
 * Optionally positions cursor at a specific column.
 */
export function scrollToLine(
  view: EditorView,
  line: number,
  lineEnd?: number,
  column?: number,
): void {
  const doc = view.state.doc;
  const clampedLine = Math.max(1, Math.min(line, doc.lines));
  const clampedEnd = lineEnd ? Math.max(clampedLine, Math.min(lineEnd, doc.lines)) : clampedLine;

  const lineObj = doc.line(clampedLine);
  const cursorPos = column != null ? Math.min(lineObj.from + column - 1, lineObj.to) : lineObj.from;

  // Set highlight, move cursor, and scroll in a single dispatch
  view.dispatch({
    selection: { anchor: cursorPos },
    effects: [
      setHighlightLines.of({ from: clampedLine, to: clampedEnd }),
      EditorView.scrollIntoView(cursorPos, { y: "center" }),
    ],
  });
}

// ---------------------------------------------------------------------------
// Cursor line tracker extension
// ---------------------------------------------------------------------------

const CURSOR_JUMP_THRESHOLD = 10;

/**
 * Extension that detects user-initiated cursor jumps across distant lines
 * (e.g. clicking a far-away line, Page Up/Down). Fires the callback with the
 * departure line when the cursor moves ≥ CURSOR_JUMP_THRESHOLD lines.
 *
 * Only reacts to user events (mouse clicks, keyboard navigation) — programmatic
 * cursor changes (scrollToLine, goBack/goForward) are ignored because they
 * don't carry `isUserEvent("select")` annotations.
 */
export function cursorLineTracker(
  onSignificantJump: (departureLine: number, arrivalLine: number) => void,
): Extension {
  let lastLine = -1;
  return EditorView.updateListener.of((update) => {
    if (!update.selectionSet) return;
    // Only track user-initiated cursor moves (clicks, keyboard nav).
    // Programmatic dispatches (scrollToLine, history navigation) don't
    // carry user-event annotations and are silently ignored.
    if (!update.transactions.some((t) => t.isUserEvent("select"))) return;

    const newLine = update.state.doc.lineAt(update.state.selection.main.head).number;
    if (lastLine >= 0 && Math.abs(newLine - lastLine) >= CURSOR_JUMP_THRESHOLD) {
      onSignificantJump(lastLine, newLine);
    }
    lastLine = newLine;
  });
}
