import { cn } from "@band-app/ui";
import { GitCompare, Globe, MessageSquare, TerminalSquare } from "lucide-react";
import { AgentIcon, getFileIcon } from "@/dashboard";
import {
  readCachedTabMeta,
  TabStatusIndicator,
  useChatTabStatus,
  useTerminalTabStatus,
} from "./tab-status";

export interface SwitcherItem {
  id: string;
  title: string;
  /** Dockview component name: chat, term, browser, file or diff. */
  kind: string;
  /** The panel's params: the owning worktree and the chat or terminal id. */
  params?: { worktreeId?: string; chatId?: string; terminalId?: string };
}

function ItemIcon({ item }: { item: SwitcherItem }) {
  const className = "size-4 shrink-0 text-muted-foreground";
  switch (item.kind) {
    case "chat": {
      // The agent type ChatTab resolved and cached for this chat.
      const agentType = readCachedTabMeta(item.params?.chatId ?? "").agentType;
      return agentType ? (
        <AgentIcon type={agentType} className="size-4 shrink-0" />
      ) : (
        <MessageSquare className={className} />
      );
    }
    case "term":
      return <TerminalSquare className={className} />;
    case "browser":
      return <Globe className={className} />;
    case "diff":
      return <GitCompare className={className} />;
    default: {
      const FileIcon = getFileIcon(item.title);
      return <FileIcon className={className} />;
    }
  }
}

/** The agent status mark a tab shows, from the same store hooks. */
function ItemStatus({ item }: { item: SwitcherItem }) {
  const worktreeId = item.params?.worktreeId ?? "";
  const chatStatus = useChatTabStatus(worktreeId, item.params?.chatId ?? "");
  const termStatus = useTerminalTabStatus(worktreeId, item.params?.terminalId ?? "");
  const status = item.kind === "chat" ? chatStatus : item.kind === "term" ? termStatus : undefined;
  if (!status) return null;
  return <TabStatusIndicator status={status} testId={`tab-switcher__status--${item.id}`} />;
}

/** The Ctrl+Tab list: a centered popover of the group's tabs, newest first. */
export function TabSwitcher(props: { items: SwitcherItem[]; index: number }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center">
      <div
        data-testid="tab-switcher"
        className="max-h-[60%] w-80 max-w-[90%] overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg"
      >
        {props.items.map((item, i) => (
          <div
            key={item.id}
            aria-current={i === props.index}
            data-testid="tab-switcher__item"
            className={cn(
              "flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm",
              i === props.index && "bg-foreground/15 font-medium text-foreground",
            )}
          >
            <ItemIcon item={item} />
            <span className="min-w-0 flex-1 truncate">{item.title}</span>
            <ItemStatus item={item} />
          </div>
        ))}
      </div>
    </div>
  );
}
