import { createFileRoute } from "@tanstack/react-router";
import { getBufferedChunks, getTask, subscribe } from "../../lib/task-runner";

export const Route = createFileRoute("/api/tasks/$workspaceId/stream")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const workspaceId = decodeURIComponent(params.workspaceId);

        // Return 204 when there's no task at all
        const task = getTask(workspaceId);
        const buffered = getBufferedChunks(workspaceId);
        if (!task && buffered.length === 0) {
          return new Response(null, { status: 204 });
        }

        const encoder = new TextEncoder();
        let unsubscribe: (() => void) | undefined;
        let keepAlive: ReturnType<typeof setInterval> | undefined;

        const stream = new ReadableStream({
          start(controller) {
            // Replay buffered chunks
            for (const chunk of buffered) {
              try {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
              } catch {
                return;
              }
            }

            // If task is already done, close the stream
            if (!task || task.status !== "running") {
              try {
                controller.close();
              } catch {
                // already closed
              }
              return;
            }

            // Subscribe for live chunks
            unsubscribe = subscribe(workspaceId, (chunk) => {
              try {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));

                // Close stream when task completes
                if (chunk.type === "finish" || chunk.type === "error") {
                  try {
                    controller.close();
                  } catch {
                    // already closed
                  }
                  if (keepAlive) clearInterval(keepAlive);
                  unsubscribe?.();
                }
              } catch {
                // Controller may be closed
              }
            });

            keepAlive = setInterval(() => {
              try {
                controller.enqueue(encoder.encode(": keepalive\n\n"));
              } catch {
                if (keepAlive) clearInterval(keepAlive);
              }
            }, 30_000);
          },
          cancel() {
            if (keepAlive) clearInterval(keepAlive);
            unsubscribe?.();
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      },
    },
  },
});
