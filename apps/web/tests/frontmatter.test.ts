import { describe, expect, it } from "vitest";
import {
  applyFrontmatterTable,
  frontmatterToMarkdownTable,
  parseFrontmatter,
} from "../src/lib/frontmatter";

// ---------------------------------------------------------------------------
// parseFrontmatter
// ---------------------------------------------------------------------------
describe("parseFrontmatter", () => {
  it("returns no frontmatter and the original body for an empty string", () => {
    expect(parseFrontmatter("")).toEqual({ frontmatter: [], body: "" });
  });

  it("returns no frontmatter when the document does not start with ---", () => {
    const content = "# Hello\n\nNo frontmatter here.";
    expect(parseFrontmatter(content)).toEqual({ frontmatter: [], body: content });
  });

  it("parses simple key/value pairs from a frontmatter block", () => {
    const content = [
      "---",
      "name: band-chat",
      "description: Send messages to coding agents",
      "type: skill",
      "---",
      "",
      "# Body",
    ].join("\n");
    expect(parseFrontmatter(content)).toEqual({
      frontmatter: [
        ["name", "band-chat"],
        ["description", "Send messages to coding agents"],
        ["type", "skill"],
      ],
      body: "# Body",
    });
  });

  it("preserves the source order of keys", () => {
    const content = ["---", "zebra: 1", "apple: 2", "mango: 3", "---", ""].join("\n");
    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter.map(([k]) => k)).toEqual(["zebra", "apple", "mango"]);
  });

  it("strips surrounding double quotes from values", () => {
    const content = ["---", 'title: "Hello, world"', "---", ""].join("\n");
    expect(parseFrontmatter(content).frontmatter).toEqual([["title", "Hello, world"]]);
  });

  it("strips surrounding single quotes from values", () => {
    const content = ["---", "title: 'Hello'", "---", ""].join("\n");
    expect(parseFrontmatter(content).frontmatter).toEqual([["title", "Hello"]]);
  });

  it("does not collapse a single-character quote value to an empty string", () => {
    // `key: "` is malformed YAML — both startsWith and endsWith match the
    // same character, but slice(1, -1) would silently drop the value.
    const content = ["---", 'key: "', "---", ""].join("\n");
    expect(parseFrontmatter(content).frontmatter).toEqual([["key", '"']]);
  });

  it("preserves colons inside the value", () => {
    const content = ["---", "url: https://example.com:8080/path", "---", ""].join("\n");
    expect(parseFrontmatter(content).frontmatter).toEqual([
      ["url", "https://example.com:8080/path"],
    ]);
  });

  it("skips lines without a colon", () => {
    const content = ["---", "name: foo", "this-line-has-no-colon", "type: skill", "---"].join("\n");
    expect(parseFrontmatter(content).frontmatter).toEqual([
      ["name", "foo"],
      ["type", "skill"],
    ]);
  });

  it("returns no frontmatter when the closing delimiter is missing", () => {
    const content = "---\nname: oops\n# Body without close";
    expect(parseFrontmatter(content)).toEqual({ frontmatter: [], body: content });
  });

  it("handles an empty frontmatter block", () => {
    const content = ["---", "---", "# Body"].join("\n");
    expect(parseFrontmatter(content)).toEqual({ frontmatter: [], body: "# Body" });
  });

  it("trims leading blank lines from the body", () => {
    const content = ["---", "name: foo", "---", "", "", "# Hello"].join("\n");
    expect(parseFrontmatter(content).body).toBe("# Hello");
  });

  it("leaves the body empty when there is nothing after the frontmatter", () => {
    const content = ["---", "name: foo", "---"].join("\n");
    expect(parseFrontmatter(content).body).toBe("");
  });

  it("ignores indented values' surrounding whitespace", () => {
    const content = ["---", "  name:   foo  ", "---"].join("\n");
    expect(parseFrontmatter(content).frontmatter).toEqual([["name", "foo"]]);
  });
});

// ---------------------------------------------------------------------------
// frontmatterToMarkdownTable
// ---------------------------------------------------------------------------
describe("frontmatterToMarkdownTable", () => {
  it("returns an empty string for no pairs", () => {
    expect(frontmatterToMarkdownTable([])).toBe("");
  });

  it("builds a GFM table with a Key / Value header", () => {
    expect(
      frontmatterToMarkdownTable([
        ["name", "band-chat"],
        ["type", "skill"],
      ]),
    ).toBe(
      ["| Key | Value |", "| --- | --- |", "| name | band-chat |", "| type | skill |"].join("\n"),
    );
  });

  it("escapes pipe characters in values so they don't break the column boundary", () => {
    const table = frontmatterToMarkdownTable([["pattern", "foo|bar"]]);
    expect(table).toContain("foo\\|bar");
    expect(table).not.toMatch(/\| foo\|bar \|/);
  });

  it("collapses newlines in a value to a single space", () => {
    const table = frontmatterToMarkdownTable([["desc", "line one\nline two"]]);
    expect(table).toContain("line one line two");
    // The row should still be a single line — the value's newline must not
    // split the table into two rows.
    const rowLines = table.split("\n").filter((l) => l.startsWith("| desc"));
    expect(rowLines).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// applyFrontmatterTable
// ---------------------------------------------------------------------------
describe("applyFrontmatterTable", () => {
  it("returns content unchanged when there is no frontmatter", () => {
    const content = "# Hello\n\nNo frontmatter.";
    expect(applyFrontmatterTable(content)).toBe(content);
  });

  it("returns content unchanged for an empty document", () => {
    expect(applyFrontmatterTable("")).toBe("");
  });

  it("rewrites a SKILL.md-style document into a table followed by the body", () => {
    const content = [
      "---",
      "name: band-chat",
      "description: Send messages to coding agents",
      "type: skill",
      "---",
      "",
      "# Band Chat",
      "",
      "Body paragraph.",
    ].join("\n");

    const expected = [
      "| Key | Value |",
      "| --- | --- |",
      "| name | band-chat |",
      "| description | Send messages to coding agents |",
      "| type | skill |",
      "",
      "# Band Chat",
      "",
      "Body paragraph.",
    ].join("\n");

    expect(applyFrontmatterTable(content)).toBe(expected);
  });

  it("does not leak the --- delimiters into the output", () => {
    const content = ["---", "name: foo", "---", "", "Body."].join("\n");
    const output = applyFrontmatterTable(content);
    expect(output.split("\n").filter((l) => l.trim() === "---")).toHaveLength(0);
  });

  it("renders just the table when the document has frontmatter but no body", () => {
    const content = ["---", "name: foo", "type: skill", "---"].join("\n");
    expect(applyFrontmatterTable(content)).toBe(
      ["| Key | Value |", "| --- | --- |", "| name | foo |", "| type | skill |"].join("\n"),
    );
  });

  it("renders content with malformed (unterminated) frontmatter as-is", () => {
    // The user is mid-edit; we don't want their content to disappear.
    const content = "---\nname: oops\n# No closing delimiter";
    expect(applyFrontmatterTable(content)).toBe(content);
  });

  it("escapes pipe characters in values when building the table", () => {
    const content = ["---", "pattern: foo|bar", "---", "", "body"].join("\n");
    const output = applyFrontmatterTable(content);
    expect(output).toContain("| pattern | foo\\|bar |");
  });

  it("preserves the rest of the document verbatim", () => {
    const body = [
      "# Heading",
      "",
      "Some **bold** text with `code` and a [link](https://example.com).",
      "",
      "```ts",
      "const x: number = 1;",
      "```",
      "",
      "- list item one",
      "- list item two",
    ].join("\n");
    const content = `---\nname: demo\n---\n\n${body}`;
    const output = applyFrontmatterTable(content);
    expect(output.endsWith(body)).toBe(true);
  });
});
