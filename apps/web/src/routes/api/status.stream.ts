import { createFileRoute } from "@tanstack/react-router";
import { subscribe } from "../../lib/watcher";

export const Route = createFileRoute("/api/status/stream")({
  server: {
    handlers: {
      GET: async () => {
        const encoder = new TextEncoder();
        let unsubscribe: (() => void) | undefined;
        let keepAlive: ReturnType<typeof setInterval> | undefined;

        const stream = new ReadableStream({
          start(controller) {
            unsubscribe = subscribe((event) => {
              try {
                const data = JSON.stringify(event);
                controller.enqueue(encoder.encode(`data: ${data}\n\n`));
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
