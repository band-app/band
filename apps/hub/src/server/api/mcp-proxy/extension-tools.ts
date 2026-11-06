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
              return jsonText(result ?? null);
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
