import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createFileRoute } from "@tanstack/react-router";
import { bandHome } from "../../lib/state";
import { submitTask, TaskConflictError } from "../../lib/task-runner";

interface FilePart {
  mediaType: string;
  url: string;
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

export const Route = createFileRoute("/api/tasks/submit")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = await request.json();
        const { workspaceId, prompt, sessionId, files } = body as {
          workspaceId?: string;
          prompt?: string;
          sessionId?: string;
          files?: FilePart[];
        };

        if (!workspaceId || !prompt) {
          return Response.json({ error: "workspaceId and prompt are required" }, { status: 400 });
        }

        // Build an enhanced prompt for the agent that includes saved file paths,
        // while keeping the original prompt for display in the UI
        let agentPrompt: string | undefined;
        if (files && files.length > 0) {
          const savedPaths = await saveUploadedFiles(files);
          if (savedPaths.length > 0) {
            const fileList = savedPaths.map((p) => `- ${p}`).join("\n");
            agentPrompt = `I'm sharing these files with you:\n${fileList}\n\n${prompt}`;
          }
        }

        try {
          const task = submitTask(workspaceId, prompt, sessionId, agentPrompt);
          return Response.json(
            { workspaceId: task.workspaceId, sessionId: task.sessionId },
            { status: 202 },
          );
        } catch (err) {
          if (err instanceof TaskConflictError) {
            return Response.json(
              { error: "Task already running for this workspace" },
              { status: 409 },
            );
          }
          throw err;
        }
      },
    },
  },
});
