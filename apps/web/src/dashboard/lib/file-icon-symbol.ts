// Root <svg> attributes that describe the icon's geometry or the document, not
// how it is painted. Everything else (fill, stroke, stroke-width, …) is a
// presentation attribute the icon's children inherit, so it has to move onto
// the <symbol> or those children fall back to the default black fill.
const NON_PRESENTATION_ATTRS = new Set([
  "xmlns",
  "viewBox",
  "width",
  "height",
  "id",
  "version",
  "x",
  "y",
  "preserveAspectRatio",
  "style",
  "class",
]);

function carriedAttributes(rootTag: string): string {
  const carried: string[] = [];
  for (const match of rootTag.matchAll(/\s([\w:-]+)="([^"]*)"/g)) {
    const name = match[1];
    if (!name || name.startsWith("xmlns")) continue;
    if (NON_PRESENTATION_ATTRS.has(name)) continue;
    carried.push(`${name}="${match[2]}"`);
  }
  return carried.join(" ");
}

/** Turns one icon's `<svg>` source into a `<symbol>`, or null when it has no body. */
export function buildSymbolMarkup(id: string, src: string): string | null {
  const rootTag = src.match(/<svg[^>]*>/)?.[0] ?? "";
  const inner = src.match(/<svg[^>]*>([\s\S]*?)<\/svg>\s*$/)?.[1];
  if (!inner) return null;
  const viewBox = rootTag.match(/viewBox="([^"]+)"/)?.[1] ?? "0 0 32 32";
  const carried = carriedAttributes(rootTag);
  return `<symbol id="${id}" viewBox="${viewBox}"${carried ? ` ${carried}` : ""}>${inner}</symbol>`;
}
