/**
 * The agent tools extensions contribute (`contributes.tools`). They join the built-in `band` MCP
 * server as `<extension id>_<tool name>`. A call goes to the worker service the manifest names, on
 * the worker of the calling chat's worktree, and needs no open tab. The arguments cannot name
 * another worktree, and a worker that does not run the service answers an error naming it.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { chatService } from "../../services/chat-service";
import { extensionService } from "../../services/extension-service";
import { pluginHost } from "../../services/plugin-host-service";
import { worktreeService } from "../../services/worktree-service";
import { advertiseToolSchemas } from "./editor-tools";

function jsonText(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

/** Decoded size cap for one image block in a tool result. */
const MAX_TOOL_IMAGE_BYTES = 5 * 1024 * 1024;
/** Most content blocks one tool result may hold. */
const MAX_TOOL_BLOCKS = 8;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg"]);

type ToolContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/** Whether a service result has the `{ content: [...] }` shape of an MCP tool result. */
function isContentResult(value: unknown): value is { content: unknown[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    Array.isArray((value as { content?: unknown }).content)
  );
}

/** The problem with a content block, or null when it is a valid text or image block. */
function contentBlockProblem(block: unknown, index: number): string | null {
  const at = `content[${index}]`;
  if (typeof block !== "object" || block === null) return `${at} is not an object`;
  const b = block as Record<string, unknown>;
  if (b.type === "text") {
    return typeof b.text === "string" ? null : `${at} is a text block without a text string`;
  }
  if (b.type === "image") {
    // Check the length before the regex scans the string.
    if (
      typeof b.data === "string" &&
      b.data.length > Math.ceil((MAX_TOOL_IMAGE_BYTES * 4) / 3) + 4
    ) {
      return `${at} is an image over the size cap; the limit is ${MAX_TOOL_IMAGE_BYTES}`;
    }
    if (typeof b.data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(b.data)) {
      return `${at} is an image block without base64 data`;
    }
    if (typeof b.mimeType !== "string" || !IMAGE_TYPES.has(b.mimeType)) {
      return `${at} has image type ${String(b.mimeType)}; only image/png and image/jpeg are allowed`;
    }
    const decoded =
      Math.floor((b.data.length * 3) / 4) -
      (b.data.endsWith("==") ? 2 : b.data.endsWith("=") ? 1 : 0);
    if (decoded > MAX_TOOL_IMAGE_BYTES) {
      return `${at} is an image of ${decoded} bytes; the limit is ${MAX_TOOL_IMAGE_BYTES}`;
    }
    return null;
  }
  return `${at} has block type ${String(b.type)}; only text and image blocks are allowed`;
}

/**
 * Turns a service result into an MCP tool result. A result of the shape
 * `{ content: [text | image blocks] }` passes through as is. Any other result is JSON text, as
 * before. A `{ content }` result with a bad block is a tool error that names the problem.
 */
function toolResultFor(result: unknown) {
  if (isContentResult(result)) {
    if (result.content.length > MAX_TOOL_BLOCKS) {
      return jsonText(
        {
          error: `The tool returned an invalid result: content has ${result.content.length} blocks; the limit is ${MAX_TOOL_BLOCKS}`,
        },
        true,
      );
    }
    for (const [i, block] of result.content.entries()) {
      const problem = contentBlockProblem(block, i);
      if (problem)
        return jsonText({ error: `The tool returned an invalid result: ${problem}` }, true);
    }
    // Rebuild each block from the checked fields, so extra keys never reach the agent.
    const content = (result.content as ToolContentBlock[]).map(
      (b): ToolContentBlock =>
        b.type === "text"
          ? { type: "text", text: b.text }
          : { type: "image", data: b.data, mimeType: b.mimeType },
    );
    return { content };
  }
  return jsonText(result ?? null);
}

/**
 * The text the `band` MCP server sends as its `instructions`: one line per installed extension
 * that declares an `agentHint`, prefixed with the extension id, ordered by id. A hint is author
 * text that reaches every chat's system prompt, so newlines collapse to spaces. Returns undefined
 * when no extension has a hint.
 */
export async function extensionInstructions(): Promise<string | undefined> {
  const { extensions } = await extensionService.list();
  const lines = extensions
    .filter((e) => e.agentHint)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((e) => ({ id: e.id, hint: (e.agentHint ?? "").replace(/\s+/g, " ").trim() }))
    .filter((e) => e.hint)
    .map((e) => `- ${e.id}: ${e.hint}`);
  return lines.length > 0 ? lines.join("\n") : undefined;
}

export async function registerExtensionTools(server: McpServer, chatId: string): Promise<void> {
  const schemas = new Map<string, Record<string, unknown>>();
  const { extensions } = await extensionService.list();
  for (const extension of extensions) {
    for (const tool of extension.contributes.tools) {
      if (!tool.agent) continue;
      const name = `${extension.id}_${tool.name}`;
      const service = extension.contributes.workerServices.find((s) => s.id === tool.service);
      if (!service || !/^[A-Za-z0-9_-]{1,64}$/.test(name)) continue;
      try {
        server.registerTool(
          name,
          {
            description: tool.description,
            // Accepts any object; the service validates its own arguments. The real schema is
            // advertised through `tools/list`.
            // biome-ignore lint/suspicious/noExplicitAny: the SDK accepts a Zod object here
            inputSchema: z.object({}).passthrough() as any,
          },
          // biome-ignore lint/suspicious/noExplicitAny: arguments are checked by the service
          async (args: any) => {
            try {
              const chat = chatService.get(chatId);
              const resolved = chat?.worktreeId ? worktreeService.resolve(chat.worktreeId) : null;
              if (!chat || !resolved) return jsonText({ error: "This chat has no worktree" }, true);
              const result = await pluginHost.callWorker(
                service.capability,
                resolved.host.id,
                tool.method,
                args ?? {},
                { worktreeKey: chat.worktreeId, worktreePath: resolved.worktree.path },
              );
              return toolResultFor(result);
            } catch (err) {
              return jsonText({ error: err instanceof Error ? err.message : String(err) }, true);
            }
          },
        );
      } catch (err) {
        console.warn(
          `[extension-tools] skipped tool ${name}: ${err instanceof Error ? err.message : err}`,
        );
        continue;
      }
      schemas.set(name, { type: "object", ...tool.inputSchema });
    }
  }
  advertiseToolSchemas(server, schemas);
}
