import { useEffect, useState } from "react";

export interface TokenSpan {
  content: string;
  color?: string;
}

export type TokenLine = TokenSpan[];

let shikiPromise: Promise<typeof import("shiki")> | null = null;

function getShiki() {
  if (!shikiPromise) {
    shikiPromise = import("shiki");
  }
  return shikiPromise;
}

/**
 * Lazily loads Shiki and syntax-highlights the given content.
 * Returns tokenized lines for rendering, or null while loading / on failure.
 */
export function useSyntaxHighlight(
  content: string | null,
  language: string,
): { lines: TokenLine[] | null; loading: boolean } {
  const [lines, setLines] = useState<TokenLine[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!content) {
      setLines(null);
      return;
    }

    let cancelled = false;
    setLoading(true);

    (async () => {
      try {
        const shiki = await getShiki();
        const result = await shiki.codeToTokens(content, {
          lang: language as Parameters<typeof shiki.codeToTokens>[1] extends { lang: infer L }
            ? L
            : never,
          theme: "github-dark",
        });
        if (!cancelled) {
          setLines(
            result.tokens.map((line) =>
              line.map((t) => ({ content: t.content, color: t.color })),
            ),
          );
        }
      } catch {
        // Fall back — lines stays null, caller renders plain text
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [content, language]);

  return { lines, loading };
}
