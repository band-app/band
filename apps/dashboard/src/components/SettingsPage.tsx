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

interface Props {
  onClose: () => void;
}

export function SettingsPage({ onClose }: Props) {
  const { settings, loadSettings, updateSettings } = useSettingsStore();
  const [worktreesDir, setWorktreesDir] = useState(
    settings.worktreesDir ?? "",
  );

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    setWorktreesDir(settings.worktreesDir ?? "");
  }, [settings.worktreesDir]);

  const handleBrowse = async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const selected = await invoke<string | null>("pick_folder");
      if (selected) setWorktreesDir(selected);
    } catch {
      // Dialog cancelled or not in Tauri
    }
  };

  const handleSave = async () => {
    await updateSettings({
      worktreesDir: worktreesDir.trim() || null,
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
      <Accordion type="single" collapsible defaultValue="general">
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
              <Button onClick={handleSave} size="sm">
                Save
              </Button>
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}
