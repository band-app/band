import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";

/**
 * Editor colors from the design tokens (`--syntax-*`, `--background`, ...), so
 * the Appearance settings and presets apply to every editor, diff and
 * markdown preview as CSS variables change, with no rebuild.
 */

const v = (name: string) => `var(--syntax-${name})`;

const codeSpecs = [
  {
    tag: [tags.keyword, tags.modifier, tags.definitionKeyword, tags.moduleKeyword],
    color: v("keyword"),
  },
  { tag: [tags.controlKeyword, tags.operatorKeyword], color: v("control") },
  { tag: [tags.string, tags.special(tags.string), tags.character], color: v("string") },
  { tag: [tags.regexp, tags.escape], color: v("regexp") },
  { tag: [tags.number, tags.integer, tags.float], color: v("number") },
  {
    tag: [tags.bool, tags.null, tags.atom, tags.constant(tags.variableName)],
    color: v("constant"),
  },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment],
    color: v("comment"),
    fontStyle: "italic",
  },
  {
    tag: [
      tags.function(tags.variableName),
      tags.function(tags.propertyName),
      tags.definition(tags.function(tags.variableName)),
    ],
    color: v("function"),
  },
  { tag: [tags.variableName, tags.definition(tags.variableName)], color: v("variable") },
  { tag: [tags.typeName, tags.className, tags.namespace, tags.macroName], color: v("type") },
  { tag: [tags.propertyName, tags.definition(tags.propertyName)], color: v("property") },
  { tag: [tags.operator, tags.derefOperator, tags.compareOperator], color: v("operator") },
  { tag: [tags.tagName], color: v("tag") },
  { tag: [tags.attributeName], color: v("attribute") },
  {
    tag: [tags.punctuation, tags.bracket, tags.angleBracket, tags.separator],
    color: v("punctuation"),
  },
  { tag: tags.inserted, color: v("inserted") },
  { tag: tags.deleted, color: v("deleted") },
  { tag: tags.invalid, color: v("invalid") },
];

const documentSpecs = [
  { tag: tags.heading, color: v("heading"), fontWeight: "bold" },
  { tag: [tags.link, tags.url], color: "var(--link)", textDecoration: "underline" },
  { tag: tags.strong, fontWeight: "bold" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
];

/** Syntax colors for source code. */
export const bandCodeHighlightStyle = HighlightStyle.define(codeSpecs);

/** Code colors plus the markup tags (headings, links, emphasis) of prose formats. */
export const bandHighlightStyle = HighlightStyle.define([...codeSpecs, ...documentSpecs]);

/** Code font size for the editor, the diff and the preview: the setting, else `fallback`. */
export function codeFontSize(fallback: number): string {
  return `var(--code-font-size, ${fallback}px)`;
}

/**
 * Surface, caret, selection, gutter and find colors, plus the syntax
 * highlighting. `isDark` only tells CodeMirror which of its built-in base
 * styles to build on; every color here is a variable.
 */
export function bandEditorTheme(isDark: boolean): Extension {
  return [
    EditorView.theme(
      {
        "&": { color: "var(--foreground)", backgroundColor: "var(--background)" },
        ".cm-scroller": { fontFamily: "var(--font-code)" },
        ".cm-content": { caretColor: "var(--foreground)" },
        ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--foreground)" },
        "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
          { backgroundColor: "var(--selection)" },
        ".cm-gutters": {
          backgroundColor: "var(--background)",
          color: "var(--muted-foreground)",
          border: "none",
        },
        ".cm-activeLine": { backgroundColor: "var(--editor-active-line)" },
        ".cm-activeLineGutter": {
          backgroundColor: "var(--editor-active-line)",
          color: "var(--foreground)",
        },
        ".cm-selectionMatch": { backgroundColor: "var(--search-match)" },
        ".cm-searchMatch": { backgroundColor: "var(--search-match)", borderRadius: "2px" },
        ".cm-searchMatch-selected": { backgroundColor: "var(--search-match-current)" },
        "&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket": {
          backgroundColor: "var(--selection)",
        },
        ".cm-foldPlaceholder": {
          backgroundColor: "var(--muted)",
          color: "var(--muted-foreground)",
          border: "none",
        },
        ".cm-tooltip": {
          backgroundColor: "var(--popover)",
          color: "var(--popover-foreground)",
          border: "1px solid var(--border)",
        },
        ".cm-panels": { backgroundColor: "var(--popover)", color: "var(--popover-foreground)" },
      },
      { dark: isDark },
    ),
    syntaxHighlighting(bandHighlightStyle),
  ];
}
