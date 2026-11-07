import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { chatService } from "../../services/chat-service";
import { worktreeService } from "../../services/worktree-service";
import { listBandTools, runBandTool } from "../mcp-proxy/tool-runner";
import { chatScope, type ToolScope, worktreeScope } from "../mcp-proxy/tool-scope";
import { publicProcedure, t } from "../trpc";

const target = z.object({
  /** The chat the call acts for. Wins over `worktreeId`. */
  chatId: z.string().min(1).optional(),
  /** The worktree of a terminal with no chat. */
  worktreeId: z.string().min(1).optional(),
});

function scopeOf(input: z.infer<typeof target>): ToolScope {
  if (input.chatId !== undefined) {
    if (!chatService.get(input.chatId)) {
      throw new TRPCError({ code: "NOT_FOUND", message: `Chat ${input.chatId} not found` });
    }
    return chatScope(input.chatId);
  }
  if (input.worktreeId !== undefined) {
    if (!worktreeService.resolve(input.worktreeId)) {
      throw new TRPCError({ code: "NOT_FOUND", message: `Worktree ${input.worktreeId} not found` });
    }
    return worktreeScope(input.worktreeId);
  }
  throw new TRPCError({
    code: "BAD_REQUEST",
    message: "A chat or worktree is required. Pass chatId or worktreeId",
  });
}

/**
 * The tools of the built-in `band` MCP server, for a caller with a shell. Both procedures build
 * the server `/mcp-proxy/band` builds (`createBandServer`), so the list and the checks on each call
 * (origin, cross-worker, trust) are the same code as over MCP.
 */
export const toolsRouter = t.router({
  list: publicProcedure.input(target).query(async ({ input }) => {
    const tools = await listBandTools(scopeOf(input));
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema,
    }));
  }),

  run: publicProcedure
    .input(
      target.extend({
        name: z.string().min(1).max(200),
        arguments: z.record(z.string(), z.unknown()).default({}),
      }),
    )
    .mutation(async ({ input }) => {
      const scope = scopeOf(input);
      const result = await runBandTool(scope, input.name, input.arguments);
      if (result === null) {
        throw new TRPCError({ code: "NOT_FOUND", message: `Unknown tool "${input.name}"` });
      }
      return {
        isError: result.isError === true,
        content: Array.isArray(result.content) ? result.content : [],
      };
    }),
});
