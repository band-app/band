import { useEffect, useState } from "react";
import { useSettingsStore } from "@/stores/settings-store";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { FolderOpen, X } from "lucide-react";

const DEFAULT_DEFAULTS = {
  layout: {
    orientation: "horizontal" as const,
    groups: [
      { size: 0.6 },
      { size: 0.4, browser: { url: "http://localhost:3000" } },
    ],
  },
  terminals: [
    { name: "claude", command: "claude", agentType: "claude-code" as const },
    { name: "shell", command: "", split: "vertical" as const },
  ],
};

interface Props {
  onClose: () => void;
}

export function SettingsPage({ onClose }: Props) {
  const { settings, loadSettings, updateSettings } = useSettingsStore();
  const [worktreesDir, setWorktreesDir] = useState(
    settings.worktreesDir ?? "",
  );
  const [defaultsJson, setDefaultsJson] = useState("");
  const [defaultsError, setDefaultsError] = useState<string | null>(null);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    setWorktreesDir(settings.worktreesDir ?? "");
    setDefaultsJson(
      settings.defaults
        ? JSON.stringify(settings.defaults, null, 2)
        : "",
    );
  }, [settings.worktreesDir, settings.defaults]);

  const handleBrowse = async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const selected = await invoke<string | null>("pick_folder");
      if (selected) setWorktreesDir(selected);
    } catch {
      // Dialog cancelled or not in Tauri
    }
  };

  const handleDefaultsChange = (value: string) => {
    setDefaultsJson(value);
    if (value.trim() === "") {
      setDefaultsError(null);
      return;
    }
    try {
      JSON.parse(value);
      setDefaultsError(null);
    } catch (e) {
      setDefaultsError(e instanceof Error ? e.message : "Invalid JSON");
    }
  };

  const handleInsertTemplate = () => {
    const json = JSON.stringify(DEFAULT_DEFAULTS, null, 2);
    setDefaultsJson(json);
    setDefaultsError(null);
  };

  const handleSave = async () => {
    let defaults = undefined;
    if (defaultsJson.trim()) {
      try {
        defaults = JSON.parse(defaultsJson);
      } catch {
        return;
      }
    }
    await updateSettings({
      worktreesDir: worktreesDir.trim() || null,
      defaults,
    });
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-2 px-1">
        <h2 className="text-base font-semibold">Settings</h2>
        <Button variant="ghost" size="icon-xs" onClick={onClose}>
          <X />
        </Button>
      </div>
      <Accordion type="multiple" defaultValue={["general", "defaults"]}>
        <AccordionItem value="general">
          <AccordionTrigger>General</AccordionTrigger>
          <AccordionContent>
            <div className="space-y-4 pt-1">
              <div className="space-y-2">
                <Label htmlFor="worktrees-dir">Worktrees folder</Label>
                <div className="flex gap-2">
                  <Input
                    id="worktrees-dir"
                    placeholder="~/.band/worktrees (default)"
                    value={worktreesDir}
                    onChange={(e) => setWorktreesDir(e.target.value)}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={handleBrowse}
                  >
                    <FolderOpen />
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Directory where new worktrees are created. Leave empty for the
                  default location.
                </p>
              </div>
            </div>
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="defaults">
          <AccordionTrigger>Default Workspace</AccordionTrigger>
          <AccordionContent>
            <div className="space-y-4 pt-1">
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="defaults-json">
                    Default layout &amp; terminals
                  </Label>
                  {!defaultsJson.trim() && (
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className="h-auto p-0 text-xs"
                      onClick={handleInsertTemplate}
                    >
                      Insert template
                    </Button>
                  )}
                </div>
                <textarea
                  id="defaults-json"
                  className="w-full min-h-[200px] rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  placeholder='{"layout": {...}, "terminals": [...]}'
                  value={defaultsJson}
                  onChange={(e) => handleDefaultsChange(e.target.value)}
                  spellCheck={false}
                />
                {defaultsError && (
                  <p className="text-xs text-destructive">{defaultsError}</p>
                )}
                <p className="text-xs text-muted-foreground">
                  Default VS Code layout and terminal configuration applied to
                  Band worktrees that don't have a project-level{" "}
                  <code className="text-xs">.band/config.json</code>. Leave
                  empty to disable.
                </p>
              </div>
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
      <div className="mt-4 px-1">
        <Button onClick={handleSave} size="sm" disabled={!!defaultsError}>
          Save
        </Button>
      </div>
    </div>
  );
}
