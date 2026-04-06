import { defaultKeymap } from "@codemirror/commands";
import {
  bracketMatching,
  defaultHighlightStyle,
  LanguageSupport,
  StreamLanguage,
  syntaxHighlighting,
} from "@codemirror/language";
import { highlightSelectionMatches, openSearchPanel, searchKeymap } from "@codemirror/search";
import {
  EditorState,
  type Extension,
  type Range,
  StateEffect,
  StateField,
} from "@codemirror/state";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import { Decoration, type DecorationSet, EditorView, keymap, lineNumbers } from "@codemirror/view";

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
 */
export function baseViewerExtensions(isDark = true): Extension[] {
  return [
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    lineNumbers(),
    bracketMatching(),
    highlightSelectionMatches(),
    ...(isDark
      ? [
          syntaxHighlighting(oneDarkHighlightStyle),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        ]
      : [
          syntaxHighlighting(defaultHighlightStyle),
          syntaxHighlighting(oneDarkHighlightStyle, { fallback: true }),
        ]),
    keymap.of([...defaultKeymap, ...searchKeymap]),
    EditorView.theme(
      isDark
        ? {
            "&": { height: "100%", backgroundColor: "#181818" },
            ".cm-scroller": { overflow: "auto" },
            ".cm-gutters": { backgroundColor: "#181818", border: "none" },
            ".cm-activeLineGutter": { backgroundColor: "transparent" },
            ".cm-activeLine": { backgroundColor: "transparent" },
            "&.cm-focused .cm-cursor": { borderLeftColor: "#fff" },
            "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
              backgroundColor: "rgba(255, 255, 255, 0.1)",
            },
            ".cm-line": { color: "#abb2bf" },
          }
        : {
            "&": { height: "100%", backgroundColor: "#ffffff" },
            ".cm-scroller": { overflow: "auto" },
            ".cm-gutters": { backgroundColor: "#f8f9fa", border: "none", color: "#6e7781" },
            ".cm-activeLineGutter": { backgroundColor: "transparent" },
            ".cm-activeLine": { backgroundColor: "transparent" },
            "&.cm-focused .cm-cursor": { borderLeftColor: "#24292f" },
            "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
              backgroundColor: "rgba(0, 0, 0, 0.07)",
            },
            ".cm-line": { color: "#24292f" },
          },
      { dark: isDark },
    ),
  ];
}

/**
 * Opens the CodeMirror search panel for find-in-file.
 * Accepts a loose type so consumers don't need a direct @codemirror dependency.
 */
// biome-ignore lint/suspicious/noExplicitAny: EditorView type from @codemirror/view — kept untyped for cross-package use
export function openFileSearchPanel(view: any): boolean {
  return openSearchPanel(view as EditorView);
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
 * Scrolls the editor to the given 1-based line and highlights the range.
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

  // Set highlight decorations
  view.dispatch({
    effects: setHighlightLines.of({ from: clampedLine, to: clampedEnd }),
  });

  // Scroll the target line into view (centered)
  const lineObj = doc.line(clampedLine);
  const scrollPos = column != null ? Math.min(lineObj.from + column - 1, lineObj.to) : lineObj.from;

  view.dispatch({
    effects: EditorView.scrollIntoView(scrollPos, { y: "center" }),
  });
}
