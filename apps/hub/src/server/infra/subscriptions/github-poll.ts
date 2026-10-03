import type { SubscriptionEvent } from "./event";
import { githubPrKey } from "./github";

const SNIPPET_LIMIT = 200;
/** Newest comments, reviews and review threads one query reads per PR. */
const PAGE = 30;
const THREAD_COMMENTS = 10;

type Json = Record<string, unknown>;

function obj(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function snippet(text: unknown): string {
  const flat = str(text).replace(/\s+/g, " ").trim();
  return flat.length > SNIPPET_LIMIT ? `${flat.slice(0, SNIPPET_LIMIT)}...` : flat;
}

function nodes(value: unknown): Json[] {
  const list = obj(value)?.nodes;
  if (!Array.isArray(list)) return [];
  return list.flatMap((n) => {
    const node = obj(n);
    return node ? [node] : [];
  });
}

const AUTHOR = "author { login }";
const COMMENT_FIELDS = `id url body createdAt ${AUTHOR}`;

/**
 * One query for every subscribed PR of a repo: `pr<number>` aliases of
 * `pullRequest(number:)`. `repo` and the numbers were validated when the
 * subscription was created; they are still JSON-quoted here.
 */
export function buildPrActivityQuery(repo: string, numbers: number[]): string {
  const [owner, name] = repo.split("/");
  const prs = numbers
    .map(
      (n) => `pr${n}: pullRequest(number: ${Math.trunc(n)}) {
        url
        comments(last: ${PAGE}) { nodes { ${COMMENT_FIELDS} } }
        reviews(last: ${PAGE}) { nodes { id url body state createdAt ${AUTHOR} } }
        reviewThreads(last: ${PAGE}) { nodes { comments(last: ${THREAD_COMMENTS}) { nodes { ${COMMENT_FIELDS} path } } } }
      }`,
    )
    .join("\n");
  return `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${prs} } }`;
}

/** A comment or review on a PR, in the order GitHub created it. */
export interface PrActivity {
  /** Stable across polls: GraphQL node id. */
  id: string;
  createdAt: string;
  event: SubscriptionEvent;
}

/**
 * Activity of each PR in a `buildPrActivityQuery` response, keyed by PR
 * number. A PR the query could not see (deleted, no access) is absent.
 * Throws on a response that is not the expected shape.
 */
export function parsePrActivity(
  repo: string,
  numbers: number[],
  output: string,
  now = Date.now(),
): Map<number, PrActivity[]> {
  const repository = obj(obj(obj(JSON.parse(output))?.data)?.repository);
  if (!repository) throw new Error("Unexpected PR activity response");
  const result = new Map<number, PrActivity[]>();
  for (const number of numbers) {
    const pr = obj(repository[`pr${number}`]);
    if (!pr) continue;
    const key = githubPrKey(repo, number);
    const prUrl = str(pr.url);
    const items: PrActivity[] = [];
    const add = (
      node: Json,
      kind: string,
      summarize: (actor: string) => string,
      fallbackUrl: string,
    ) => {
      const id = str(node.id);
      const createdAt = str(node.createdAt);
      if (!id || !createdAt) return;
      const actor = str(obj(node.author)?.login) || "unknown";
      items.push({
        id,
        createdAt,
        event: {
          id: `poll:${id}`,
          source: "github",
          kind,
          key,
          url: str(node.url) || fallbackUrl,
          actor,
          summary: summarize(actor),
          at: now,
        },
      });
    };
    for (const c of nodes(pr.comments)) {
      add(c, "comment", (a) => `${a} commented on ${repo}#${number}: ${snippet(c.body)}`, prUrl);
    }
    for (const r of nodes(pr.reviews)) {
      const state = str(r.state).toLowerCase().replaceAll("_", " ") || "commented";
      const text = snippet(r.body);
      add(
        r,
        "review",
        (a) => `${a} reviewed ${repo}#${number} (${state})${text ? `: ${text}` : ""}`,
        prUrl,
      );
    }
    for (const thread of nodes(pr.reviewThreads)) {
      for (const c of nodes(thread.comments)) {
        const path = snippet(c.path) || "a file";
        add(
          c,
          "review_comment",
          (a) => `${a} commented on ${path} in ${repo}#${number}: ${snippet(c.body)}`,
          prUrl,
        );
      }
    }
    items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    result.set(number, items);
  }
  return result;
}

/** The cursor a subscription starts from: its creation time, to the second (GitHub's resolution). */
export function initialCursor(createdAt: number): string {
  return new Date(createdAt).toISOString().replace(/\.\d+Z$/, "Z");
}
