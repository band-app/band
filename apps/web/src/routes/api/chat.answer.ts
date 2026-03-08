import { createFileRoute } from "@tanstack/react-router";
import { resolvePendingInput } from "../../lib/pending-inputs";

export const Route = createFileRoute("/api/chat/answer")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = (await request.json()) as {
          approvalId?: string;
          answers?: Record<string, string>;
        };

        if (!body.approvalId || !body.answers) {
          return Response.json({ error: "approvalId and answers required" }, { status: 400 });
        }

        const resolved = resolvePendingInput(body.approvalId, body.answers);
        if (!resolved) {
          return Response.json(
            { error: "No pending input found for this approvalId" },
            { status: 404 },
          );
        }

        return Response.json({ ok: true });
      },
    },
  },
});
