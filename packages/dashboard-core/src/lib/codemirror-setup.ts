import { defaultKeymap } from "@codemirror/commands";
import {
  bracketMatching,
  defaultHighlightStyle,
  LanguageSupport,
  StreamLanguage,
  syntaxHighlighting,
} from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { EditorState, type Extension } from "@codemirror/state";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";

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
 */
export function baseViewerExtensions(): Extension[] {
  return [
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    lineNumbers(),
    bracketMatching(),
    highlightSelectionMatches(),
    syntaxHighlighting(oneDarkHighlightStyle),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    keymap.of([...defaultKeymap, ...searchKeymap]),
    EditorView.theme(
      {
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
      },
      { dark: true },
    ),
  ];
}
