import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@band-app/ui";
import { Trash2 } from "lucide-react";
import {
  useBrowserProfiles,
  useRemoveBrowserProfile,
  useRepoBrowserProfiles,
  useSetRepoBrowserProfile,
} from "../../hooks/use-browser-profiles";
import { useRepos } from "../../hooks/use-repos";
import { SettingsRow } from "./SettingsRow";

/** Radix `Select` can't use `""` as a value, so Default gets a sentinel. */
const DEFAULT_VALUE = "__default__";

function sourceLabel(source: string | null): string {
  return source === "chrome" ? "Imported from Chrome" : "No cookies imported";
}

/**
 * Rows for the Settings dialog's Browser section: the browser profiles,
 * then a collapsed "Repo defaults" accordion with the profile each
 * repo's new browser tabs open with. Changes apply immediately; they
 * are not part of the dialog's Save.
 */
export function BrowserProfilesSettings() {
  const { profiles } = useBrowserProfiles();
  const repoDefaults = useRepoBrowserProfiles();
  const { repos } = useRepos();
  const removeProfile = useRemoveBrowserProfile();
  const setRepoProfile = useSetRepoBrowserProfile();

  return (
    <>
      <SettingsRow
        variant="stacked"
        label="Browser profiles"
        description="Each profile keeps its own cookies. Import a Chrome profile from the profile menu in a browser tab's toolbar. Deleting a profile signs you out of every site in it."
      >
        <ul className="divide-y divide-border rounded-md border border-border">
          <li className="flex items-center justify-between px-3 py-2 text-sm">
            <span>Default</span>
            <span className="text-xs text-muted-foreground">Built in</span>
          </li>
          {profiles.map((profile) => (
            <li
              key={profile.id}
              className="flex items-center justify-between gap-2 px-3 py-2 text-sm"
              data-testid="settings__browser-profile"
            >
              <div className="min-w-0">
                <div className="truncate">{profile.name}</div>
                <div className="text-xs text-muted-foreground">{sourceLabel(profile.source)}</div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0"
                aria-label={`Delete browser profile ${profile.name}`}
                disabled={removeProfile.isPending}
                onClick={() => removeProfile.mutate(profile.id)}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      </SettingsRow>

      {repos.length > 0 && (
        <Accordion type="single" collapsible>
          <AccordionItem value="repo-defaults" className="border-b-0">
            <AccordionTrigger
              className="px-4 py-3 hover:no-underline"
              data-testid="settings__repo-defaults-trigger"
            >
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-medium leading-tight text-foreground">
                  Repo defaults
                </div>
                <p className="text-xs font-normal leading-snug text-muted-foreground">
                  New browser tabs in any worktree of a repo open with its profile.
                </p>
              </div>
            </AccordionTrigger>
            <AccordionContent className="pb-0">
              <ul className="divide-y divide-border border-t border-border">
                {repos.map((repo) => (
                  <li
                    key={repo.name}
                    className="flex flex-col gap-2 px-4 py-2.5 sm:flex-row sm:items-center sm:gap-4"
                    data-testid="settings__repo-browser-profile"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm">{repo.name}</span>
                    <Select
                      value={repoDefaults[repo.name] ?? DEFAULT_VALUE}
                      onValueChange={(value: string) =>
                        setRepoProfile.mutate({
                          repoName: repo.name,
                          profileId: value === DEFAULT_VALUE ? null : value,
                        })
                      }
                    >
                      <SelectTrigger
                        className="h-8 w-full text-sm sm:w-48"
                        aria-label={`Browser profile for ${repo.name}`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={DEFAULT_VALUE}>Default</SelectItem>
                        {profiles.map((profile) => (
                          <SelectItem key={profile.id} value={profile.id}>
                            {profile.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </li>
                ))}
              </ul>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      )}
    </>
  );
}
