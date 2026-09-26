/**
 * Toolbar menu in a browser tab: shows which profile the tab uses, lets the
 * user switch it, and opens the Chrome import dialog. Picking a profile
 * here also makes it the default for new tabs in the tab's project.
 */

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@band-app/ui";
import { UserRound } from "lucide-react";
import { useState } from "react";
import type { BrowserProfileInfo } from "@/dashboard";
import { isDesktop } from "../lib/is-desktop";
import { ChromeImportDialog } from "./ChromeImportDialog";

/** Radix radio items need a string value; Default is `null` elsewhere. */
const DEFAULT_VALUE = "__default__";

export interface BrowserProfileMenuProps {
  profiles: BrowserProfileInfo[];
  /** The tab's current profile. `null` is Default. */
  profileId: string | null;
  onSelect: (profileId: string | null) => void;
  /** Called after a Chrome import created a new profile. */
  onImported: (profileId: string) => void;
}

export function BrowserProfileMenu({
  profiles,
  profileId,
  onSelect,
  onImported,
}: BrowserProfileMenuProps) {
  const [importOpen, setImportOpen] = useState(false);
  const current = profiles.find((p) => p.id === profileId);
  const currentName = current?.name ?? "Default";

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex max-w-40 items-center gap-1 rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title={`Browser profile: ${currentName}`}
            aria-label={`Browser profile: ${currentName}`}
          >
            <UserRound className="size-4 shrink-0" />
            {current ? <span className="truncate text-xs">{current.name}</span> : null}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuLabel>Browser profile</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={profileId ?? DEFAULT_VALUE}
            onValueChange={(value) => onSelect(value === DEFAULT_VALUE ? null : value)}
          >
            <DropdownMenuRadioItem value={DEFAULT_VALUE}>Default</DropdownMenuRadioItem>
            {profiles.map((p) => (
              <DropdownMenuRadioItem key={p.id} value={p.id}>
                <span className="truncate">{p.name}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          {isDesktop ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setImportOpen(true)}>
                Import from Chrome…
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {isDesktop ? (
        <ChromeImportDialog
          open={importOpen}
          onOpenChange={setImportOpen}
          onImported={onImported}
        />
      ) : null}
    </>
  );
}
