import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@band-app/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { trpc } from "../../lib/trpc-client";

/**
 * Which Band-managed login this chat's agent uses. Shown only when the
 * agent has a login to choose, because "the default" alone is no choice. The pick applies when the
 * chat's agent next starts. Any device may pick, since a login's secret never reaches the UI.
 */
export function ChatLoginMenu({
  chatId,
  codingAgentId,
}: {
  chatId: string;
  codingAgentId: string | undefined;
}) {
  const queryClient = useQueryClient();
  const models = useQuery({
    queryKey: ["models.listAll"],
    queryFn: () => trpc.models.listAll.query(),
    staleTime: 30_000,
  });
  const chat = useQuery({
    queryKey: ["chats.get", chatId],
    queryFn: () => trpc.chats.get.query({ chatId }),
  });
  const agent = models.data?.agents.find((a) => a.agentId === codingAgentId);
  const logins = agent?.logins ?? [];
  if (logins.length === 0) return null;

  const pickedId = chat.data?.chat?.loginId ?? null;
  const picked = logins.find((l) => l.id === pickedId);
  // A pick that no longer exists (the login was removed) counts as no pick.
  const effectivePickedId = picked ? pickedId : null;
  const defaultLogin = logins.find((l) => l.isDefault);

  const select = async (loginId: string | null) => {
    await trpc.chats.update.mutate({ chatId, loginId });
    await queryClient.invalidateQueries({ queryKey: ["chats.get", chatId] });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="chat-pane__login-menu"
          aria-label="Agent login"
          className="inline-flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <span className="truncate" data-testid="chat-pane__login-menu-current">
            {picked?.label ?? defaultLogin?.label ?? "Machine login"}
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" className="min-w-[200px]">
        <DropdownMenuItem
          data-testid="chat-pane__login-option"
          data-login-id=""
          className="flex items-center justify-between gap-2"
          onClick={() => void select(null)}
        >
          <span>
            {defaultLogin ? `Default (${defaultLogin.label})` : "Default (machine login)"}
          </span>
          {effectivePickedId === null ? <Check className="size-4 shrink-0" /> : null}
        </DropdownMenuItem>
        {logins.map((login) => (
          <DropdownMenuItem
            key={login.id}
            data-testid="chat-pane__login-option"
            data-login-id={login.id}
            className="flex items-center justify-between gap-2"
            onClick={() => void select(login.id)}
          >
            <span className="truncate">{login.label}</span>
            {effectivePickedId === login.id ? <Check className="size-4 shrink-0" /> : null}
          </DropdownMenuItem>
        ))}
        <p className="px-2 py-1.5 text-xs text-muted-foreground">
          Applies when the agent next starts.
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
