/**
 * Prose an agent writes renders as written, and real math still renders.
 *
 * Runs the chat's Streamdown pipeline (same plugins as `MessageResponse`) over a
 * fixture of realistic lines and checks the static HTML. Pure markdown-in,
 * HTML-out: there is no state to fake.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import remarkBreaks from "remark-breaks";
import { defaultRehypePlugins, defaultRemarkPlugins, Streamdown } from "streamdown";
import { describe, expect, it } from "vitest";
import { streamdownPlugins } from "../src/components/streamdown-components";

function render(markdown: string): string {
  return renderToStaticMarkup(
    createElement(
      Streamdown,
      {
        plugins: streamdownPlugins,
        remarkPlugins: [...Object.values(defaultRemarkPlugins), remarkBreaks],
        rehypePlugins: Object.values(defaultRehypePlugins),
        mode: "static",
      },
      markdown,
    ),
  );
}

/** The text a reader sees: tags removed, entities decoded. */
function visibleText(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

const VERBATIM = [
  // The reported sentence: suffix currency.
  "Premiuma od 10 $. Od januara 2026. on košta 19,80 $.",
  "1.000,50$ i 5$ i 7$.",
  "Max gets $100 a month and Ultra gets $200",
  "costs $5 and $10, or $1,000 to $2,000",
  "US$10 i $ 10",
  "$10–$20",
  "$10-$20",
  "€10 and $20",
  "$1 and $2",
  // Shell variables and prose dollars.
  "$HOME and $PATH",
  "$PATH/$HOME",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal shell syntax is the input
  "${foo}",
  "^foo$ and a$b$c",
  // Tildes.
  "~30 min and ~2 h",
  "~/Projects/x and ~ 5",
  // Identifiers and globs that CommonMark leaves alone.
  "snake_case_name",
  "*.ts and *.tsx",
  // Angle brackets.
  "<repo>-<branch>",
  "Array<string>",
  // Words that look like markup.
  "#1117 and @name",
  "Cena je 5 EUR. 5. novembar je dan",
  "Rok je 2026. 5. novembra",
];

describe("prose with symbols", () => {
  for (const line of VERBATIM) {
    it(`shows "${line}" as written`, () => {
      const html = render(line);
      expect(html).not.toContain("katex");
      expect(html).not.toContain("<del");
      expect(html).not.toContain("<em");
      expect(html).not.toContain("<li");
      expect(visibleText(html)).toBe(line);
    });
  }

  it("keeps an escaped dollar as a literal dollar", () => {
    const html = render("\\$5 and \\$6");
    expect(html).not.toContain("katex");
    expect(visibleText(html)).toBe("$5 and $6");
  });

  it("does not render an unknown tag as HTML and keeps real tags", () => {
    expect(render("see <repo>-<branch>")).not.toMatch(/<repo|<branch/);
    expect(render("press <kbd>Esc</kbd>")).toContain("<kbd>Esc</kbd>");
    expect(render("<details>x</details>")).toContain("<details>x</details>");
  });

  it("does not execute raw HTML", () => {
    const html = render('hi <script>alert(1)</script> <img src=x onerror="alert(1)">');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
  });

  it("links bare URLs without their trailing punctuation", () => {
    const html = render("see https://a.com/x. and (https://b.com/y), ok");
    expect(visibleText(html)).toBe("see https://a.com/x. and (https://b.com/y), ok");
    expect(html.match(/data-streamdown="link"/g)).toHaveLength(2);
  });

  it("starts a list only at the start of a line", () => {
    expect(render("1. one\n2. two")).toContain("<li");
    expect(render("Datum: 5. novembar")).not.toContain("<li");
  });

  it("keeps markup working next to Serbian and CJK punctuation", () => {
    expect(render("to je **važno**, zar ne?")).toContain("font-semibold");
    expect(render("这是**重要**的")).toContain("font-semibold");
    expect(render("~~stari~~ cena")).toContain("<del");
  });

  it("keeps CommonMark emphasis for underscores and asterisks", () => {
    expect(render("__init__")).toContain('data-streamdown="strong"');
    expect(render("2*3*4")).toContain("<em>3</em>");
  });
});

describe("math", () => {
  for (const math of ["$x^2$", "$$\\sum_i i$$", "$\\alpha$ and $\\beta$", "the $n$th term"]) {
    it(`renders ${math}`, () => {
      expect(render(math)).toContain("katex");
    });
  }

  it("renders two formulas in one line as two", () => {
    expect(render("$\\alpha$ and $\\beta$").match(/class="katex"/g)).toHaveLength(2);
  });
});
