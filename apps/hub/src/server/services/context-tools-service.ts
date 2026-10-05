/**
 * The context tools an agent gets on the hub's MCP server (plan step 5.4):
 * `context_search`, `context_append_learning` and `context_handoff`.
 *
 * A call names its chat or worktree through the `x-band-chat-id` and
 * `x-band-worktree-id` headers. The hub maps that worktree's repo to the
 * project context bound to it (`contexts.repos`), and no tool takes a context
 * name, so an agent cannot reach another project's files. Without a project
 * context a session can search the user context only.
 */

import { randomBytes } from "node:crypto";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { ContextInputError } from "../errors";
import type { ContextRow } from "../infra/db/queries/contexts";
import { redactSecrets } from "./_utils/context-redaction";
import { chatService } from "./chat-service";
import { contextService } from "./context-service";
import { commitAppends, type SearchHit, searchContext } from "./context-store";
import { loadState } from "./state";

const SLUG = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const TAG = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,39}$/;
const MAX_TEXT = 8000;
const MAX_TAGS = 10;
const MAX_LINKS = 20;
const MAX_LINK = 500;

export interface ToolCaller {
  chatId?: string;
  worktreeId?: string;
}

export interface ToolSession {
  worktreeId: string;
  chatId?: string;
  agent: string;
  project: ContextRow | undefined;
}

export type SearchScope = "project" | "user" | "all";

export interface SearchResult {
  context: "user" | "project";
  contextName: string;
  hit: SearchHit;
}

function slug(value: string, fallback: string): string {
  const s = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+|-+$/g, "")
    .slice(0, 63);
  return s || fallback;
}

function utc(now: Date) {
  const iso = now.toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16), iso };
}

function repoOf(worktreeId: string): string | undefined {
  for (const repo of loadState().repos) {
    for (const wt of repo.worktrees) {
      if (toWorktreeId(repo.name, wt.name) === worktreeId) return repo.name;
    }
  }
  return undefined;
}

/** Session of a chat row the caller already holds, for a write after the chat is gone. */
export function sessionFromChat(
  chat: { id: string; worktreeId: string; agent: string },
  knownRepo?: string,
): ToolSession {
  // A worktree being removed has already left the state, so its caller passes the repo.
  const repo = knownRepo ?? repoOf(chat.worktreeId);
  return {
    worktreeId: chat.worktreeId,
    chatId: chat.id,
    agent: slug(chat.agent, "agent"),
    project: repo ? contextService.forRepo(repo) : undefined,
  };
}

/** Scope of a call: the worktree, chat and agent it comes from, and that worktree's project context. */
export function resolveSession(caller: ToolCaller): ToolSession {
  const chat = caller.chatId ? chatService.get(caller.chatId) : undefined;
  if (caller.chatId && !chat) throw new ContextInputError("Unknown chat");
  if (chat && caller.worktreeId && chat.worktreeId !== caller.worktreeId) {
    throw new ContextInputError("The chat does not belong to that worktree");
  }
  const worktreeId = chat?.worktreeId ?? caller.worktreeId;
  if (!worktreeId) {
    throw new ContextInputError(
      "The context tools work from an agent session. Call them with the chat or worktree headers.",
    );
  }
  const repo = repoOf(worktreeId);
  if (!repo) throw new ContextInputError("Unknown worktree");
  return {
    worktreeId,
    chatId: chat?.id,
    agent: slug(chat?.agent ?? "agent", "agent"),
    project: contextService.forRepo(repo),
  };
}

function requireProject(session: ToolSession): ContextRow {
  if (!session.project) {
    throw new ContextInputError(
      "No project context is set for this repo. An admin binds one with `context.update` (repos).",
    );
  }
  return session.project;
}

function cleanText(value: string, what: string): string {
  const text = redactSecrets(value).trim();
  if (!text) throw new ContextInputError(`${what} is empty`);
  if (text.length > MAX_TEXT) throw new ContextInputError(`${what} is over ${MAX_TEXT} characters`);
  return text;
}

function cleanTags(tags: string[] | undefined): string[] {
  const list = [...new Set((tags ?? []).map((t) => t.trim()).filter(Boolean))];
  if (list.length > MAX_TAGS) throw new ContextInputError(`At most ${MAX_TAGS} tags`);
  for (const tag of list) {
    if (!TAG.test(tag))
      throw new ContextInputError(`Tag "${tag}" has characters other than a-z 0-9 _ . : -`);
    if (redactSecrets(tag) !== tag) throw new ContextInputError("A tag looks like a secret");
  }
  return list;
}

export const contextToolsService = {
  async search(
    caller: ToolCaller,
    query: string,
    scope: SearchScope = "all",
    limit = 10,
  ): Promise<{ results: SearchResult[]; searched: string[] }> {
    const session = resolveSession(caller);
    const targets: Array<{ context: "user" | "project"; row: ContextRow }> = [];
    if (scope !== "user" && session.project) {
      targets.push({ context: "project", row: session.project });
    } else if (scope === "project") {
      requireProject(session);
    }
    const user = contextService.userContext();
    if (scope !== "project" && user) targets.push({ context: "user", row: user });

    const results: SearchResult[] = [];
    for (const t of targets) {
      for (const hit of await searchContext(t.row.name, query, limit)) {
        results.push({ context: t.context, contextName: t.row.name, hit });
      }
    }
    results.sort(
      (a, b) => Number(b.hit.nameMatch) - Number(a.hit.nameMatch) || b.hit.matches - a.hit.matches,
    );
    return { results: results.slice(0, limit), searched: targets.map((t) => t.row.name) };
  },

  /** Appends to `learnings/<date>-<agent>.md` in the project context. */
  async appendLearning(
    caller: ToolCaller | ToolSession,
    input: { text: string; tags?: string[]; source?: "agent" | "auto-captured" },
    now = new Date(),
  ): Promise<{ context: string; path: string; commit: string }> {
    const session = "agent" in caller ? caller : resolveSession(caller);
    const project = requireProject(session);
    const text = cleanText(input.text, "The learning");
    const tags = cleanTags(input.tags);
    const source = input.source ?? "agent";
    const { date, time } = utc(now);
    const path = `learnings/${date}-${session.agent}.md`;
    const initial = `---\ntype: learnings\nagent: ${session.agent}\ndate: ${date}\n---\n\n# Learnings ${date} (${session.agent})\n`;
    const entry = [
      "",
      `## ${time} UTC`,
      `source: ${source}`,
      ...(tags.length ? [`tags: ${tags.join(", ")}`] : []),
      ...(session.chatId ? [`chat: ${session.chatId}`] : []),
      "",
      text,
      "",
    ].join("\n");
    const commit = await commitAppends(
      project.name,
      [{ path, append: entry, initial }],
      `learning (${source}): ${session.agent}`,
    );
    return { context: project.name, path, commit };
  },

  /** Writes `handoffs/<stamp>-<from>-to-<to>.md` and adds a pointer line to `inbox/<to>.md`. */
  async handoff(
    caller: ToolCaller,
    input: { to: string; summary: string; links?: string[] },
    now = new Date(),
  ): Promise<{ context: string; path: string; inbox: string; commit: string }> {
    const session = resolveSession(caller);
    const project = requireProject(session);
    const to = input.to.trim().toLowerCase();
    if (!SLUG.test(to)) {
      throw new ContextInputError("`to` is lowercase letters, digits, hyphens and underscores");
    }
    if (redactSecrets(to) !== to) throw new ContextInputError("`to` looks like a secret");
    const summary = cleanText(input.summary, "The summary");
    const links = (input.links ?? []).map((l) => redactSecrets(l.trim())).filter(Boolean);
    if (links.length > MAX_LINKS) throw new ContextInputError(`At most ${MAX_LINKS} links`);
    if (links.some((l) => l.length > MAX_LINK)) {
      throw new ContextInputError(`A link is over ${MAX_LINK} characters`);
    }
    const { date, time, iso } = utc(now);
    const stamp = `${date.replaceAll("-", "")}-${time.replace(":", "")}${now.getUTCSeconds().toString().padStart(2, "0")}`;
    const path = `handoffs/${stamp}-${session.agent}-to-${to}-${randomBytes(2).toString("hex")}.md`;
    const inbox = `inbox/${to}.md`;
    const body = [
      "---",
      "type: handoff",
      `from: ${session.agent}`,
      `to: ${to}`,
      `date: ${iso}`,
      `worktree: ${JSON.stringify(session.worktreeId)}`,
      ...(session.chatId ? [`chat: ${session.chatId}`] : []),
      `links: ${JSON.stringify(links)}`,
      "---",
      "",
      summary,
      "",
    ].join("\n");
    const firstLine = summary.split("\n")[0].slice(0, 160);
    const pointer = `- ${date} ${time} UTC from ${session.agent}: ${firstLine} (${path})\n`;
    const commit = await commitAppends(
      project.name,
      [
        { path, append: body },
        {
          path: inbox,
          append: pointer,
          initial: `---\ntype: inbox\nfor: ${to}\n---\n\n# Inbox for ${to}\n\n`,
        },
      ],
      `handoff: ${session.agent} to ${to}`,
    );
    return { context: project.name, path, inbox, commit };
  },
};
