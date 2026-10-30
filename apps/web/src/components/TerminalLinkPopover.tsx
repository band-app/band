import { Popover, PopoverAnchor, PopoverContent } from "@band-app/ui";
import { Check, Copy, ExternalLink, Globe } from "lucide-react";
import { useEffect, useState } from "react";
import { writeClipboardText } from "../lib/clipboard";
import { openExternalUrl } from "../lib/open-external-url";
import {
  canOpenInBandBrowser,
  openUrlInBandBrowser,
  TERMINAL_LINK_MENU_EVENT,
  type TerminalLinkMenuDetail,
} from "../lib/terminal-links";

const COPIED_MS = 1500;
const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

const ROW_CLASS =
  "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-list-highlight focus-visible:bg-list-highlight focus-visible:outline-hidden";

/**
 * The menu a plain click on a terminal URL opens: the URL, a copy button and
 * one row per action. It lives in the worktree's center layout and answers
 * only the events of its own worktree.
 */
export function TerminalLinkPopover({ worktreeId }: { worktreeId: string }) {
  const [menu, setMenu] = useState<TerminalLinkMenuDetail | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onMenu = (e: Event) => {
      const detail = (e as CustomEvent<TerminalLinkMenuDetail>).detail;
      if (detail.worktreeId !== worktreeId) return;
      setCopied(false);
      setMenu(detail);
    };
    window.addEventListener(TERMINAL_LINK_MENU_EVENT, onMenu);
    return () => window.removeEventListener(TERMINAL_LINK_MENU_EVENT, onMenu);
  }, [worktreeId]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  if (!menu) return null;
  const { url } = menu;
  const close = () => setMenu(null);

  return (
    <Popover open onOpenChange={(open) => !open && close()}>
      <PopoverAnchor asChild>
        <span
          aria-hidden
          className="pointer-events-none fixed size-0"
          style={{ left: menu.x, top: menu.y }}
        />
      </PopoverAnchor>
      <PopoverContent
        align="start"
        className="w-80 p-1"
        data-testid="terminal-link-popover"
        aria-label="Link actions"
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          menu.focusTerminal();
        }}
      >
        <div className="flex items-center gap-1 px-2 py-1">
          <span
            className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
            title={url}
            data-testid="terminal-link-popover__url"
          >
            {url}
          </span>
          <button
            type="button"
            aria-label={copied ? "Copied" : "Copy link"}
            data-testid="terminal-link-popover__copy"
            onClick={() => {
              void writeClipboardText(url).then((ok) => setCopied(ok));
            }}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </button>
        </div>
        {canOpenInBandBrowser(url) && (
          <button
            type="button"
            className={ROW_CLASS}
            data-testid="terminal-link-popover__open-band"
            onClick={() => {
              close();
              openUrlInBandBrowser({ worktreeId, terminalId: menu.terminalId, url });
            }}
          >
            <Globe className="size-4 shrink-0" />
            <span className="flex-1">Open in Band browser</span>
            <kbd className="text-xs text-muted-foreground">{MOD} Click</kbd>
          </button>
        )}
        <button
          type="button"
          className={ROW_CLASS}
          data-testid="terminal-link-popover__open-system"
          onClick={() => {
            close();
            openExternalUrl(url);
          }}
        >
          <ExternalLink className="size-4 shrink-0" />
          <span className="flex-1">Open in system browser</span>
          <kbd className="text-xs text-muted-foreground">
            {canOpenInBandBrowser(url) ? `⇧ ${MOD} Click` : `${MOD} Click`}
          </kbd>
        </button>
      </PopoverContent>
    </Popover>
  );
}
