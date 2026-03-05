import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { ChatView } from "../components/ChatView";

export const Route = createFileRoute("/chat/$workspaceId")({
  component: ChatPage,
});

function ChatPage() {
  const { workspaceId } = Route.useParams();
  const decoded = decodeURIComponent(workspaceId);

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-border/50 px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <Link
          to="/"
          className="inline-flex size-8 items-center justify-center rounded-md hover:bg-accent"
        >
          <ArrowLeft className="size-4" />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">{decoded}</h1>
        </div>
      </header>
      <main className="min-h-0 flex-1">
        <ChatView workspaceId={decoded} workspaceName={decoded} />
      </main>
    </div>
  );
}
