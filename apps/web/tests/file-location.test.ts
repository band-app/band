import { describe, expect, it } from "vitest";
import { formatFileLocation, parseFileLocation } from "@/dashboard";

// ---------------------------------------------------------------------------
// parseFileLocation
// ---------------------------------------------------------------------------
describe("parseFileLocation", () => {
  it("returns bare path when there is no line suffix", () => {
    expect(parseFileLocation("src/main.ts")).toEqual({ filePath: "src/main.ts" });
  });

  it("returns bare path for an empty string", () => {
    expect(parseFileLocation("")).toEqual({ filePath: "" });
  });

  it("parses file:line format", () => {
    expect(parseFileLocation("src/main.rs:42")).toEqual({
      filePath: "src/main.rs",
      line: 42,
    });
  });

  it("parses file:line:col format", () => {
    expect(parseFileLocation("app.tsx:100:15")).toEqual({
      filePath: "app.tsx",
      line: 100,
      column: 15,
    });
  });

  it("parses file:line-lineEnd range format", () => {
    expect(parseFileLocation("src/lib.rs:5-10")).toEqual({
      filePath: "src/lib.rs",
      line: 5,
      lineEnd: 10,
    });
  });

  it("handles deeply nested paths with line reference", () => {
    expect(parseFileLocation("apps/web/src/dashboard/components/QuickOpenDialog.tsx:77")).toEqual({
      filePath: "apps/web/src/dashboard/components/QuickOpenDialog.tsx",
      line: 77,
    });
  });

  it("treats :0 as invalid and returns the raw string as path", () => {
    // Line numbers are 1-based, so :0 should not be treated as a line ref
    expect(parseFileLocation("file.ts:0")).toEqual({ filePath: "file.ts:0" });
  });

  it("treats :0:0 as invalid and returns raw string as path", () => {
    expect(parseFileLocation("file.ts:0:0")).toEqual({ filePath: "file.ts:0:0" });
  });

  it("handles file paths that already contain colons (Windows-style drive letters)", () => {
    // "C:" prefix should not be confused with a line suffix
    // The regex anchors to the end, so only the last `:N` is parsed
    const result = parseFileLocation("C:/Users/src/main.ts:10");
    expect(result).toEqual({ filePath: "C:/Users/src/main.ts", line: 10 });
  });

  it("handles very large line numbers", () => {
    expect(parseFileLocation("app.tsx:999999")).toEqual({
      filePath: "app.tsx",
      line: 999999,
    });
  });

  it("does not match a trailing colon without a number", () => {
    expect(parseFileLocation("file.ts:")).toEqual({ filePath: "file.ts:" });
  });

  it("does not match non-numeric suffix after colon", () => {
    expect(parseFileLocation("file.ts:abc")).toEqual({ filePath: "file.ts:abc" });
  });

  // Stack trace / compiler error formats that users paste directly
  it("handles grep-style output (file:line)", () => {
    expect(parseFileLocation("src/index.ts:23")).toEqual({
      filePath: "src/index.ts",
      line: 23,
    });
  });

  it("handles compiler error style (file:line:col)", () => {
    expect(parseFileLocation("src/app.tsx:45:12")).toEqual({
      filePath: "src/app.tsx",
      line: 45,
      column: 12,
    });
  });
});

// ---------------------------------------------------------------------------
// formatFileLocation
// ---------------------------------------------------------------------------
describe("formatFileLocation", () => {
  it("returns bare path when no line is given", () => {
    expect(formatFileLocation("src/main.ts")).toBe("src/main.ts");
  });

  it("returns bare path when line is undefined", () => {
    expect(formatFileLocation("src/main.ts", undefined)).toBe("src/main.ts");
  });

  it("formats file:line", () => {
    expect(formatFileLocation("src/main.rs", 42)).toBe("src/main.rs:42");
  });

  it("formats file:line:col", () => {
    expect(formatFileLocation("app.tsx", 100, { column: 15 })).toBe("app.tsx:100:15");
  });

  it("formats file:line-lineEnd", () => {
    expect(formatFileLocation("src/lib.rs", 5, { lineEnd: 10 })).toBe("src/lib.rs:5-10");
  });

  it("lineEnd takes precedence over column", () => {
    // formatFileLocation checks lineEnd before column
    expect(formatFileLocation("file.ts", 5, { lineEnd: 10, column: 3 })).toBe("file.ts:5-10");
  });
});

// ---------------------------------------------------------------------------
// Round-trip: parse ↔ format
// ---------------------------------------------------------------------------
describe("parseFileLocation ↔ formatFileLocation round-trip", () => {
  const cases = [
    "src/main.ts",
    "src/main.rs:42",
    "app.tsx:100:15",
    "src/lib.rs:5-10",
    "packages/core/src/index.ts:1",
  ];

  for (const input of cases) {
    it(`round-trips "${input}"`, () => {
      const parsed = parseFileLocation(input);
      const formatted = formatFileLocation(parsed.filePath, parsed.line, {
        lineEnd: parsed.lineEnd,
        column: parsed.column,
      });
      expect(formatted).toBe(input);
    });
  }
});
