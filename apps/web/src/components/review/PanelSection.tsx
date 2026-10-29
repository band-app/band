import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@band-app/ui";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { type SectionId, useSectionOpen } from "./section-state";

/** A collapsible section: chevron, title and a one-line summary in the header. */
export function PanelSection({
  id,
  title,
  summary,
  children,
}: {
  id: SectionId;
  title: string;
  summary: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useSectionOpen(id);
  return (
    <Collapsible open={open} onOpenChange={setOpen} data-testid={`pr-${id}`}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left text-[11px] text-muted-foreground hover:bg-accent/50"
          aria-expanded={open}
          data-testid={`pr-${id}__header`}
        >
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          <span className="font-semibold text-foreground">{title}</span>
          <span data-testid={`pr-${id}__summary`}>{summary}</span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}
