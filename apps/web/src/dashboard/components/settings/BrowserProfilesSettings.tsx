import {
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
  useProjectBrowserProfiles,
  useRemoveBrowserProfile,
  useSetProjectBrowserProfile,
} from "../../hooks/use-browser-profiles";
import { useProjects } from "../../hooks/use-projects";
import { SettingsRow } from "./SettingsRow";

/** Radix `Select` can't use `""` as a value, so Default gets a sentinel. */
const DEFAULT_VALUE = "__default__";

function sourceLabel(source: string | null): string {
  return source === "chrome" ? "Imported from Chrome" : "No cookies imported";
}

/**
 * Rows for the Settings dialog's Browser section: the browser profiles,
 * and which profile each project's new browser tabs open with. Changes
 * apply immediately; they are not part of the dialog's Save.
 */
export function BrowserProfilesSettings() {
  const { profiles } = useBrowserProfiles();
  const projectDefaults = useProjectBrowserProfiles();
  const { projects } = useProjects();
  const removeProfile = useRemoveBrowserProfile();
  const setProjectProfile = useSetProjectBrowserProfile();

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

      {projects.map((project) => {
        const label = project.label || project.name;
        const current = projectDefaults[project.name] ?? DEFAULT_VALUE;
        return (
          <SettingsRow
            key={project.name}
            variant="responsive"
            label={`Browser profile for ${label}`}
            description="New browser tabs in any workspace of this project open with this profile."
          >
            <Select
              value={current}
              onValueChange={(value: string) =>
                setProjectProfile.mutate({
                  projectName: project.name,
                  profileId: value === DEFAULT_VALUE ? null : value,
                })
              }
            >
              <SelectTrigger
                className="h-8 w-full text-sm sm:w-48"
                aria-label={`Browser profile for ${label}`}
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
          </SettingsRow>
        );
      })}
    </>
  );
}
