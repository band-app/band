/**
 * The agent's way into the editor tabs a person has open (docs/architecture/extensions.md, Agent
 * access). They are tools of the built-in `band` MCP server: `band_editor_list`,
 * `band_editor_open`, `band_editor_selection`, and one tool per entry in each installed editor's
 * `tools.json` (named `<extension id>_<tool>`, with a required `file`). A chat reaches only the
 * editor tabs of its own worktree, and nothing here saves: the person saves.
 */

import { randomUUID } from "node:crypto";
import { type FileEditorManifest, matchesSelector } from "@band-app/plugin-api";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  EditorCallError,
  type EditorTab,
  editorRegistryService,
} from "../../services/editor-registry-service";
import { type EditorToolDef, extensionService } from "../../services/extension-service";
import type { ToolScope } from "./tool-scope";

function jsonText(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

function plainText(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) };
}

/** A path inside the worktree, with `/` separators. Null for anything that leaves it. */
export function worktreeRelativePath(raw: string): string | null {
  const parts = raw
    .replace(/\\/g, "/")
    .split("/")
    .filter((p) => p !== "" && p !== ".");
  if (parts.length === 0 || raw.startsWith("/") || parts.includes("..")) return null;
  return parts.join("/");
}

const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

interface ToolRoute {
  extensionId: string;
  editorIds: string[];
  tool: EditorToolDef;
}

/** Every agent-visible tool of every installed editor, keyed by the name the agent sees. */
async function manifestTools(): Promise<Map<string, ToolRoute>> {
  const routes = new Map<string, ToolRoute>();
  const { extensions } = await extensionService.list();
  for (const extension of extensions) {
    for (const editor of extension.contributes.fileEditors) {
      for (const tool of await extensionService.agentTools(extension.id, editor.id)) {
        const name = `${extension.id}_${tool.name}`;
        const known = routes.get(name);
        if (known) known.editorIds.push(editor.id);
        else routes.set(name, { extensionId: extension.id, editorIds: [editor.id], tool });
      }
    }
  }
  return routes;
}

const fileArg = z.string().min(1).max(2000);
const openInput = z.object({
  file: fileArg.describe("Path of the file, relative to this worktree"),
  editor: z
    .string()
    .max(130)
    .optional()
    .describe("Editor as <extension id>/<editor id>. Defaults to the editor that opens the file."),
});

function describeTab(tab: EditorTab) {
  return {
    file: tab.file,
    editor: `${tab.extensionId}/${tab.editorId}`,
    window: tab.clientId.slice(0, 8),
    dirty: tab.dirty,
  };
}

export async function registerEditorTools(server: McpServer, scope: ToolScope): Promise<void> {
  const worktreeOf = (): string | null => scope.worktreeId();
  const noWorktree = () => jsonText({ error: "This chat has no worktree" }, true);

  server.registerTool(
    "band_editor_list",
    {
      description:
        "List the editor tabs (spreadsheets, documents and so on) open in this worktree: file, editor, window and whether it has unsaved edits.",
    },
    async () => {
      const worktreeId = worktreeOf();
      if (!worktreeId) return noWorktree();
      return jsonText({ tabs: editorRegistryService.list(worktreeId).map(describeTab) });
    },
  );

  server.registerTool(
    "band_editor_open",
    {
      description:
        "Open a file in its editor in the person's Band window, or reuse the tab that is open, and wait until the editor is ready. Call this before an editor tool when the file is not open.",
      // biome-ignore lint/suspicious/noExplicitAny: the SDK accepts a Zod object here
      inputSchema: openInput as any,
    },
    // biome-ignore lint/suspicious/noExplicitAny: arguments are validated by the schema above
    async (args: any) => {
      try {
        const worktreeId = worktreeOf();
        if (!worktreeId) return noWorktree();
        const input = openInput.parse(args);
        const file = worktreeRelativePath(input.file);
        if (!file) return plainText("The file must be a path inside this worktree", true);
        const choice = await resolveEditor(file, input.editor);
        if (typeof choice === "string") return plainText(choice, true);
        const tab = await editorRegistryService.open({ worktreeId, file, ...choice });
        return jsonText(describeTab(tab));
      } catch (err) {
        return plainText(err instanceof Error ? err.message : String(err), true);
      }
    },
  );

  server.registerTool(
    "band_editor_selection",
    {
      description:
        "What the person has selected in an open editor tab of this worktree: file, editor, the address the editor's tools accept, a label and the selected text. Says so when nothing is selected.",
    },
    async () => {
      const worktreeId = worktreeOf();
      if (!worktreeId) return noWorktree();
      const state = editorRegistryService.selection(worktreeId);
      if (!state) return plainText("Nothing is selected in an open editor.");
      return jsonText({
        file: state.file,
        editor: `${state.extensionId}/${state.editorId}`,
        selection: state.selection,
      });
    },
  );

  const routes = await manifestTools();
  const advertised = new Map<string, Record<string, unknown>>();
  for (const [name, route] of routes) {
    // One bad manifest (a name clash with a built-in tool, an odd character) must not take
    // down the whole `band` server for every chat.
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) continue;
    try {
      registerEditorTool(server, name, route);
    } catch (err) {
      console.warn(
        `[editor-tools] skipped tool ${name}: ${err instanceof Error ? err.message : err}`,
      );
      continue;
    }
    advertised.set(name, withFileProperty(route.tool.inputSchema));
  }
  advertiseToolSchemas(server, advertised);

  function registerEditorTool(server: McpServer, name: string, route: ToolRoute) {
    server.registerTool(
      name,
      {
        description: `${route.tool.description}\nActs on the document open in the editor tab for \`file\`. Unsaved: the person saves.`,
        // Accepts any object; the editor validates its own arguments. The real schema is
        // advertised through `tools/list` (see `advertiseToolSchemas`).
        // biome-ignore lint/suspicious/noExplicitAny: the SDK accepts a Zod object here
        inputSchema: z.object({ file: fileArg }).passthrough() as any,
        ...(route.tool.annotations ? { annotations: route.tool.annotations } : {}),
      },
      // biome-ignore lint/suspicious/noExplicitAny: arguments are validated by the schema above
      async (args: any) => {
        try {
          const worktreeId = worktreeOf();
          if (!worktreeId) return noWorktree();
          const { file: rawFile, ...rest } = args as { file: string } & Record<string, unknown>;
          const file = worktreeRelativePath(rawFile);
          if (!file) return plainText("The file must be a path inside this worktree", true);
          const answer = await editorRegistryService.call({
            worktreeId,
            file,
            extensionId: route.extensionId,
            message: {
              jsonrpc: "2.0",
              id: randomUUID(),
              method: "tools/call",
              params: { name: route.tool.name, arguments: rest },
            },
          });
          if (answer.error && typeof answer.error === "object") {
            const message = (answer.error as { message?: unknown }).message;
            return plainText(
              typeof message === "string" ? message : "The editor refused the call",
              true,
            );
          }
          const result = answer.result as { content?: unknown; isError?: boolean } | undefined;
          if (result && Array.isArray(result.content)) {
            // biome-ignore lint/suspicious/noExplicitAny: the editor's own MCP content, passed through
            return { content: result.content as any, ...(result.isError ? { isError: true } : {}) };
          }
          return jsonText(result ?? null);
        } catch (err) {
          if (err instanceof EditorCallError) return plainText(err.message, true);
          return plainText(err instanceof Error ? err.message : String(err), true);
        }
      },
    );
  }
}

/** The editor to open a file in: the named one, else the default or first whose selector matches. */
async function resolveEditor(
  file: string,
  named: string | undefined,
): Promise<{ extensionId: string; editorId: string } | string> {
  const { extensions } = await extensionService.list();
  if (named) {
    const slash = named.indexOf("/");
    const extensionId = slash > 0 ? named.slice(0, slash) : "";
    const editorId = slash > 0 ? named.slice(slash + 1) : "";
    const found = extensions
      .find((e) => e.id === extensionId)
      ?.contributes.fileEditors.find((e) => e.id === editorId);
    return found ? { extensionId, editorId } : `No editor "${named}" is installed`;
  }
  const matches: { extensionId: string; editor: FileEditorManifest }[] = [];
  for (const extension of extensions) {
    for (const editor of extension.contributes.fileEditors) {
      if (editor.selector.some((s) => matchesSelector(s, fileName(file)))) {
        matches.push({ extensionId: extension.id, editor });
      }
    }
  }
  const pick = matches.find((m) => m.editor.default) ?? matches[0];
  return pick
    ? { extensionId: pick.extensionId, editorId: pick.editor.id }
    : `No installed editor opens ${fileName(file)}`;
}

function withFileProperty(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = {
    file: {
      type: "string",
      description: "Path of the file in this worktree, as opened in its editor tab",
    },
    ...((schema.properties as Record<string, unknown> | undefined) ?? {}),
  };
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  return {
    ...schema,
    type: "object",
    properties,
    required: ["file", ...required.filter((r) => r !== "file")],
  };
}

/**
 * `McpServer` builds each tool's schema from Zod, so an editor's own JSON Schema would be lost.
 * This wraps the `tools/list` handler it installed and swaps in the real schema for editor tools.
 * `_requestHandlers` is the SDK's private map; the wrapper falls back to the unpatched list if
 * a later SDK version moves it.
 */
export function advertiseToolSchemas(
  server: McpServer,
  schemas: Map<string, Record<string, unknown>>,
) {
  if (schemas.size === 0) return;
  const handlers = (
    server.server as unknown as {
      _requestHandlers?: Map<string, (request: unknown, extra: unknown) => Promise<unknown>>;
    }
  )._requestHandlers;
  const original = handlers?.get("tools/list");
  if (!handlers || !original) return;
  handlers.set("tools/list", async (request, extra) => {
    const reply = (await original(request, extra)) as { tools: { name: string }[] };
    return {
      ...reply,
      tools: reply.tools.map((tool) => {
        const schema = schemas.get(tool.name);
        return schema ? { ...tool, inputSchema: schema } : tool;
      }),
    };
  });
}
