import type { BundledTheme } from "streamdown";

/**
 * A Shiki theme whose colors are the `--syntax-*` tokens, so chat code blocks
 * follow the Appearance settings and the active preset without being
 * re-highlighted. The same theme serves as light and dark: the variables
 * already change with the mode.
 */
const syntax = (name: string) => `var(--syntax-${name})`;

const rules: [string | string[], string][] = [
  [["comment", "punctuation.definition.comment"], "comment"],
  [["keyword", "storage", "storage.type", "storage.modifier"], "keyword"],
  [["keyword.control", "keyword.operator.new", "keyword.operator.expression"], "control"],
  [["string", "string.quoted", "punctuation.definition.string"], "string"],
  [["string.regexp", "constant.character.escape"], "regexp"],
  [["constant.numeric"], "number"],
  [["constant.language", "support.constant", "variable.other.constant"], "constant"],
  [
    ["entity.name.function", "support.function", "meta.function-call entity.name.function"],
    "function",
  ],
  [["variable", "variable.other.readwrite", "variable.parameter"], "variable"],
  [["entity.name.type", "entity.name.class", "support.class", "support.type"], "type"],
  [
    ["variable.other.property", "support.type.property-name", "meta.object-literal.key"],
    "property",
  ],
  [["keyword.operator"], "operator"],
  [["entity.name.tag", "punctuation.definition.tag"], "tag"],
  [["entity.other.attribute-name"], "attribute"],
  [["punctuation", "meta.brace"], "punctuation"],
  [["markup.heading", "entity.name.section"], "heading"],
  [["markup.inserted", "meta.diff.header.to-file"], "inserted"],
  [["markup.deleted", "meta.diff.header.from-file"], "deleted"],
  [["invalid"], "invalid"],
];

const theme = {
  name: "band-syntax",
  type: "dark" as const,
  fg: "var(--foreground)",
  bg: "transparent",
  colors: { "editor.foreground": "var(--foreground)", "editor.background": "transparent" },
  settings: [
    { settings: { foreground: "var(--foreground)" } },
    ...rules.map(([scope, token]) => ({ scope, settings: { foreground: syntax(token) } })),
  ],
};

/** The theme pair Streamdown's code plugin takes, as a BundledTheme tuple for its types. */
export const BAND_SHIKI_THEMES = [theme, theme] as unknown as [BundledTheme, BundledTheme];
