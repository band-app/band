/** Parsed file location with optional line, line range, or column. */
export interface FileLocation {
  /** The file path without line/column suffix. */
  filePath: string;
  /** Line number (1-based). */
  line?: number;
  /** End of line range (1-based, inclusive). Only set for range syntax `file:5-10`. */
  lineEnd?: number;
  /** Column number (1-based). Only set for column syntax `file:5:10`. */
  column?: number;
}

/**
 * Parses a file path that may include a line suffix.
 *
 * Supported formats:
 *   "src/main.ts"        -> { filePath: "src/main.ts" }
 *   "src/main.ts:89"     -> { filePath: "src/main.ts", line: 89 }
 *   "src/main.ts:5-10"   -> { filePath: "src/main.ts", line: 5, lineEnd: 10 }
 *   "src/main.ts:5:10"   -> { filePath: "src/main.ts", line: 5, column: 10 }
 */
export function parseFileLocation(raw: string): FileLocation {
  // Try :line-lineEnd (range with dash)
  const rangeMatch = raw.match(/:(\d+)-(\d+)$/);
  if (rangeMatch) {
    const line = parseInt(rangeMatch[1], 10);
    const lineEnd = parseInt(rangeMatch[2], 10);
    if (line > 0 && lineEnd > 0) {
      return {
        filePath: raw.slice(0, raw.length - rangeMatch[0].length),
        line,
        lineEnd,
      };
    }
  }

  // Try :line:column (two colon-separated numbers)
  const colMatch = raw.match(/:(\d+):(\d+)$/);
  if (colMatch) {
    const line = parseInt(colMatch[1], 10);
    const column = parseInt(colMatch[2], 10);
    if (line > 0 && column > 0) {
      return {
        filePath: raw.slice(0, raw.length - colMatch[0].length),
        line,
        column,
      };
    }
  }

  // Try :line (single number)
  const lineMatch = raw.match(/:(\d+)$/);
  if (lineMatch) {
    const line = parseInt(lineMatch[1], 10);
    if (line > 0) {
      return {
        filePath: raw.slice(0, raw.length - lineMatch[0].length),
        line,
      };
    }
  }

  return { filePath: raw };
}

/**
 * Formats a file path with optional line/range/column information.
 * Inverse of parseFileLocation.
 */
export function formatFileLocation(
  filePath: string,
  line?: number,
  options?: { lineEnd?: number; column?: number },
): string {
  if (line != null && options?.lineEnd != null) return `${filePath}:${line}-${options.lineEnd}`;
  if (line != null && options?.column != null) return `${filePath}:${line}:${options.column}`;
  if (line != null) return `${filePath}:${line}`;
  return filePath;
}
