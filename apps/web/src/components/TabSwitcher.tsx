import { cn } from "@band-app/ui";
import { GitCompare, Globe, MessageSquare, TerminalSquare } from "lucide-react";
import { getFileIcon } from "@/dashboard";

export interface SwitcherItem {
  id: string;
  title: string;
  /** Dockview component name: chat, term, browser, file or diff. */
  kind: string;
}

function ItemIcon({ item }: { item: SwitcherItem }) {
  const className = "size-4 shrink-0 text-muted-foreground";
  switch (item.kind) {
    case "chat":
      return <MessageSquare className={className} />;
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
            <span className="truncate">{item.title}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
