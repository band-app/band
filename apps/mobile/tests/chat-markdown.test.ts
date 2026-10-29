import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { highlight, languageOf } from "../src/lib/chat/highlight.ts";
import { parseMarkdown, spansText } from "../src/lib/chat/markdown.ts";

describe("parseMarkdown", () => {
  it("reads headings, styled text and links", () => {
    const [heading, para] = parseMarkdown(
      "## Plan &amp; scope\n\nSome **bold _both_** ~~gone~~ and [docs](https://example.com).",
    );
    assert.deepEqual(heading, { type: "heading", depth: 2, spans: [{ text: "Plan & scope" }] });
    assert.equal(para.type, "paragraph");
    if (para.type !== "paragraph") return;
    assert.deepEqual(para.spans, [
      { text: "Some " },
      { text: "bold ", bold: true },
      { text: "both", bold: true, italic: true },
      { text: " " },
      { text: "gone", strike: true },
      { text: " and " },
      { text: "docs", link: { url: "https://example.com" } },
      { text: "." },
    ]);
  });

  it("keeps a single newline as a line break, like the web chat", () => {
    const [para] = parseMarkdown("one\ntwo");
    assert.equal(para.type === "paragraph" && spansText(para.spans), "one\ntwo");
  });

  it("links only web and mail schemes, so agent text can't open the app's own or another app's links", () => {
    const [para] = parseMarkdown(
      "[pair](band://pair?hub=x) [call](tel:123) [web](https://a.b) [mail](mailto:a@b.c) " +
        "[top](#section) [api](/api/x) [f](src/app.ts)",
    );
    if (para.type !== "paragraph") throw new Error("expected a paragraph");
    assert.deepEqual(
      para.spans.filter((s) => s.text.trim()),
      [
        { text: "pair" },
        { text: "call" },
        { text: "web", link: { url: "https://a.b" } },
        { text: "mail", link: { url: "mailto:a@b.c" } },
        { text: "top" },
        { text: "api" },
        { text: "f", link: { file: "src/app.ts" } },
      ],
    );
  });

  it("turns file paths in inline code and in text with a line number into file links", () => {
    const [para] = parseMarkdown("Edited `src/app.ts`, see lib/util.ts:12 and `npm test`.");
    assert.equal(para.type, "paragraph");
    if (para.type !== "paragraph") return;
    const links = para.spans.filter((s) => s.link);
    assert.deepEqual(links, [
      { text: "src/app.ts", code: true, link: { file: "src/app.ts" } },
      { text: "lib/util.ts:12", link: { file: "lib/util.ts:12" } },
    ]);
    assert.ok(para.spans.some((s) => s.code && s.text === "npm test" && !s.link));
  });

  it("reads lists, task lists and tables", () => {
    const [tasks, numbered, table] = parseMarkdown(
      "- [x] done\n- [ ] todo\n\n3. three\n4. four\n\n| a | b |\n|---|:-:|\n| 1 | `x` |",
    );
    assert.deepEqual(tasks, {
      type: "list",
      ordered: false,
      start: 1,
      items: [
        { checked: true, blocks: [{ type: "paragraph", spans: [{ text: "done" }] }] },
        { checked: false, blocks: [{ type: "paragraph", spans: [{ text: "todo" }] }] },
      ],
    });
    assert.equal(numbered.type === "list" && numbered.start, 3);
    assert.deepEqual(table, {
      type: "table",
      align: [null, "center"],
      header: [[{ text: "a" }], [{ text: "b" }]],
      rows: [[[{ text: "1" }], [{ text: "x", code: true }]]],
    });
  });

  it("labels mermaid and math as code blocks", () => {
    const blocks = parseMarkdown("```mermaid\ngraph TD\n```\n\n$$\nx^2\n$$\n\nInline $$y$$ math");
    assert.deepEqual(blocks[0], {
      type: "code",
      lang: "mermaid",
      text: "graph TD",
      label: "diagram",
    });
    assert.deepEqual(blocks[1], { type: "code", lang: "latex", text: "x^2", label: "math" });
    assert.ok(
      blocks[2].type === "paragraph" && blocks[2].spans.some((s) => s.code && s.text === "y"),
    );
  });

  it("shows an unclosed fence while it streams", () => {
    const [code] = parseMarkdown("```ts\nconst a = 1");
    assert.deepEqual(code, { type: "code", lang: "ts", text: "const a = 1", open: true });
    const [closed] = parseMarkdown("```ts\nconst a = 1\n```");
    assert.deepEqual(closed, { type: "code", lang: "ts", text: "const a = 1" });
    const [indented] = parseMarkdown("    const a = 1");
    assert.equal(indented.type === "code" && indented.open, undefined);
  });
});

describe("highlight", () => {
  it("colors a known language and keeps every character", () => {
    const code = 'const a = "x"; // note';
    const runs = highlight(code, "ts");
    assert.equal(runs.map((r) => r.text).join(""), code);
    assert.deepEqual(
      runs.filter((r) => r.scope).map((r) => r.scope),
      ["keyword", "string", "comment"],
    );
  });

  it("knows the fence names agents use", () => {
    assert.equal(languageOf("sh"), "bash");
    assert.equal(languageOf("tsx"), "tsx");
    assert.equal(languageOf("nope"), null);
  });

  it("gives the same runs for a repeated block, and each language its own", () => {
    const code = "def f(): return 1";
    assert.deepEqual(highlight(code, "python"), highlight(code, "python"));
    assert.notDeepEqual(highlight(code, "python"), highlight(code, "text"));
  });

  it("leaves an unknown language plain", () => {
    assert.deepEqual(highlight("x y", "nope"), [{ text: "x y" }]);
  });
});

describe("parseMarkdown with github html", () => {
  const gh = (src: string) => parseMarkdown(src, { html: "github" });
  const reviewer = [
    "<!-- epic-pr-reviewer:sticky:v1 -->",
    '## <img src="https://github.ol.epicgames.net/x/argus-avatar-64.png" width="32" align="absmiddle"> Review by Epic PR Reviewer',
    "",
    "> quote",
    "",
    "<details>",
    "<summary>Resolved &amp; retired (5)</summary>",
    "",
    "- one [link](https://example.com)",
    "- `two`",
    "",
    "</details>",
  ].join("\n");

  it("drops comments, single and multi line", () => {
    assert.deepEqual(gh("<!-- a -->\n\ntext"), [{ type: "paragraph", spans: [{ text: "text" }] }]);
    assert.deepEqual(gh("<!-- a\nb -->\n\ntext"), [
      { type: "paragraph", spans: [{ text: "text" }] },
    ]);
  });

  it("drops a long multi line comment with blank lines and keeps what follows", () => {
    const src = [
      "<!-- claude-review-state -->",
      "<!-- REVIEW_STATE_START -->",
      "<!--",
      "{",
      '  "agent": "psc-adversarial-pr-reviewer",',
      "",
      '  "findings": ["see <url> and \\"q\\" in src/a.ts"]',
      "}",
      "-->",
      "<!-- REVIEW_STATE_END -->",
      "",
      "after",
    ].join("\n");
    assert.deepEqual(gh(src), [{ type: "paragraph", spans: [{ text: "after" }] }]);
    assert.deepEqual(gh("a <!-- x\n\ny --> b"), [{ type: "paragraph", spans: [{ text: "a  b" }] }]);
  });

  it("keeps comments in code and an unclosed comment as text", () => {
    assert.deepEqual(gh("```\n<!-- keep -->\n```"), [
      { type: "code", lang: "", text: "<!-- keep -->" },
    ]);
    const out = gh("<!-- unclosed\n\nnext");
    assert.ok(out.length > 0);
    assert.ok(out.some((b) => b.type === "paragraph" && spansText(b.spans).includes("next")));
  });

  it("shows an image's alt text and nothing without one", () => {
    const [withAlt, without] = gh('## <img src="u" alt="Logo"> Title\n\n<img src="u"> after');
    assert.equal(withAlt.type === "heading" && spansText(withAlt.spans), "Logo Title");
    assert.equal(without.type === "paragraph" && spansText(without.spans).trim(), "after");
  });

  it("reads the reviewer comment: no tag or entity is left", () => {
    const out = gh(reviewer);
    assert.equal(out[0].type, "heading");
    assert.equal(
      out[0].type === "heading" && spansText(out[0].spans).trim(),
      "Review by Epic PR Reviewer",
    );
    assert.equal(out[1].type, "quote");
    const details = out[2];
    assert.equal(details.type, "details");
    if (details.type !== "details") return;
    assert.equal(spansText(details.summary), "Resolved & retired (5)");
    assert.equal(details.open, false);
    assert.equal(details.blocks.length, 1);
    assert.equal(details.blocks[0].type, "list");
    assert.equal(out.length, 3);
  });

  it("starts expanded with the open attribute and reads one-block details", () => {
    const [d] = gh("<details open><summary>T</summary>\n\n**x**\n\n</details>");
    assert.equal(d.type === "details" && d.open, true);
    const [one] = gh("<details><summary>T &lt;1&gt;</summary>inner text</details>");
    assert.equal(one.type, "details");
    if (one.type !== "details") return;
    assert.equal(spansText(one.summary), "T <1>");
    assert.equal(one.blocks.length, 1);
  });

  it("decodes entities, including in table cells", () => {
    const [table] = gh("| a &amp; b |\n| - |\n| &#39;x&#39; &lt;y&gt; &quot; |");
    assert.equal(table.type === "table" && spansText(table.header[0]), "a & b");
    assert.equal(table.type === "table" && spansText(table.rows[0][0]), "'x' <y> \"");
  });

  it("keeps inline tag styles, links only http(s), and drops other tags", () => {
    const [p] = gh(
      'a<br>b <b>B</b> <i>I</i> <kbd>K</kbd> H<sub>2</sub>O <a href="https://e.com">L</a> <a href="javascript:x">J</a> <script>alert(1)</script><span style="x">S</span>',
    );
    assert.equal(p.type, "paragraph");
    if (p.type !== "paragraph") return;
    const find = (t: string) => p.spans.find((s) => s.text === t);
    assert.equal(find("B")?.bold, true);
    assert.equal(find("I")?.italic, true);
    assert.equal(find("K")?.code, true);
    assert.deepEqual(find("L")?.link, { url: "https://e.com" });
    assert.equal(find("J")?.link, undefined);
    const text = spansText(p.spans);
    assert.ok(text.startsWith("a\nb "));
    assert.ok(text.includes("H2O"));
    assert.ok(!text.includes("<"));
  });

  it("leaves html as literal text without the option", () => {
    const [p] = parseMarkdown("use <div> here");
    assert.equal(p.type === "paragraph" && spansText(p.spans), "use <div> here");
  });
});
