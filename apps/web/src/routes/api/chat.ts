import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createFileRoute } from "@tanstack/react-router";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { getOrCreateAgent } from "../../lib/agent-pool";
import { bandHome } from "../../lib/state";
import { writeAgentStream } from "../../lib/stream-writer";
import { resolveWorkspace } from "../../lib/workspace";

interface FilePart {
  type: "file";
  mediaType: string;
  url: string;
  filename?: string;
}

interface MessagePart {
  type: string;
  text?: string;
  mediaType?: string;
  url?: string;
  filename?: string;
}

async function saveUploadedFiles(fileParts: FilePart[]): Promise<string[]> {
  const uploadDir = join(bandHome(), "uploads");
  await mkdir(uploadDir, { recursive: true });

  const savedPaths: string[] = [];

  for (const part of fileParts) {
    const dataUrlMatch = part.url.match(/^data:[^;]+;base64,(.+)$/);
    if (!dataUrlMatch) continue;

    const buffer = Buffer.from(dataUrlMatch[1], "base64");
    const timestamp = Date.now();
    const filename = part.filename || `file-${timestamp}`;
    const safeName = `${timestamp}-${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const filePath = join(uploadDir, safeName);

    await writeFile(filePath, buffer);
    savedPaths.push(filePath);
  }

  return savedPaths;
}

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = await request.json();
        const { messages, sessionId, workspaceId } = body as {
          messages?: Array<{
            parts?: MessagePart[];
            content?: string;
          }>;
          sessionId?: string;
          workspaceId?: string;
        };

        if (!workspaceId) {
          return Response.json({ error: "workspaceId required" }, { status: 400 });
        }

        const workspace = resolveWorkspace(workspaceId);
        if (!workspace) {
          return Response.json({ error: "Workspace not found" }, { status: 404 });
        }

        const agent = await getOrCreateAgent(workspaceId, workspace.worktree.path);

        const lastMessage = messages?.[messages.length - 1];
        const userText =
          lastMessage?.parts?.find((p) => p.type === "text")?.text ?? lastMessage?.content ?? "";

        // Extract file parts and save them to the workspace
        const fileParts = (lastMessage?.parts?.filter((p) => p.type === "file") ??
          []) as FilePart[];
        let enhancedText = userText;

        if (fileParts.length > 0) {
          const savedPaths = await saveUploadedFiles(fileParts);
          if (savedPaths.length > 0) {
            const fileList = savedPaths.map((p) => `- ${p}`).join("\n");
            enhancedText = `I'm sharing these files with you:\n${fileList}\n\n${userText}`;
          }
        }

        const stream = createUIMessageStream({
          execute: async ({ writer }) => {
            await writeAgentStream(agent, enhancedText, sessionId, writer);
          },
        });

        return createUIMessageStreamResponse({ stream });
      },
    },
  },
});
