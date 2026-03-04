import { useEffect, useState } from "react";
import {
  useSettingsStore,
  type CodingAgentConfig,
  type CodingAgentType,
} from "@/stores/settings-store";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  X,
} from "lucide-react";

const AGENT_TYPES: { value: CodingAgentType; label: string }[] = [
  { value: "claude-code", label: "Claude Code" },
];

const AGENT_LABEL: Record<string, string> = {
  "claude-code": "Claude Code",
};

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

type Section = "menu" | "general" | "coding-agent" | "defaults";

interface Props {
  onClose: () => void;
}

function SettingsRow({
  label,
  value,
  onClick,
}: {
  label: string;
  value?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="flex w-full items-center justify-between px-3 py-2.5 text-sm hover:bg-accent/50 rounded-md transition-colors text-left"
      onClick={onClick}
    >
      <span>{label}</span>
      <span className="flex items-center gap-1 text-muted-foreground">
        {value && <span className="text-xs truncate max-w-[140px]">{value}</span>}
        <ChevronRight className="size-4 shrink-0" />
      </span>
    </button>
  );
}

export function SettingsPage({ onClose }: Props) {
  const { settings, loadSettings, updateSettings } = useSettingsStore();
  const [section, setSection] = useState<Section>("menu");
  const [worktreesDir, setWorktreesDir] = useState(
    settings.worktreesDir ?? "",
  );
  const [defaultsJson, setDefaultsJson] = useState("");
  const [defaultsError, setDefaultsError] = useState<string | null>(null);
  const [agentType, setAgentType] = useState<CodingAgentType | "">(
    settings.codingAgent?.type ?? "",
  );
  const [agentCommand, setAgentCommand] = useState(
    settings.codingAgent?.command ?? "",
  );

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    setWorktreesDir(settings.worktreesDir ?? "");
    setDefaultsJson(
      settings.defaults ? JSON.stringify(settings.defaults, null, 2) : "",
    );
    setAgentType(settings.codingAgent?.type ?? "");
    setAgentCommand(settings.codingAgent?.command ?? "");
  }, [settings.worktreesDir, settings.defaults, settings.codingAgent]);

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
    let codingAgent: CodingAgentConfig | undefined = undefined;
    if (agentType) {
      codingAgent = { type: agentType };
      if (agentCommand.trim()) {
        codingAgent.command = agentCommand.trim();
      }
    }
    await updateSettings({
      worktreesDir: worktreesDir.trim() || null,
      defaults,
      codingAgent,
    });
  };

  const worktreesDirPreview = worktreesDir || "Default";
  const agentPreview = agentType ? AGENT_LABEL[agentType] : "None";
  const defaultsPreview = defaultsJson.trim() ? "Configured" : "None";

  if (section !== "menu") {
    return (
      <div>
        <div className="flex items-center gap-1 mb-3 px-1">
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => setSection("menu")}
          >
            <ChevronLeft />
          </Button>
          <h2 className="text-base font-semibold">
            {section === "general" && "General"}
            {section === "coding-agent" && "Coding Agent"}
            {section === "defaults" && "Workspace Settings"}
          </h2>
        </div>

        {section === "general" && (
          <div className="space-y-4 px-1">
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
                  size="icon-xs"
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
        )}

        {section === "coding-agent" && (
          <div className="space-y-4 px-1">
            <div className="space-y-2">
              <Label>Agent type</Label>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full justify-between font-normal h-7 text-xs px-2"
                  >
                    {agentType ? AGENT_LABEL[agentType] : "None"}
                    <ChevronDown className="size-3 opacity-50" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-[--radix-dropdown-menu-trigger-width]">
                  <DropdownMenuRadioGroup
                    value={agentType}
                    onValueChange={(v) =>
                      setAgentType(v as CodingAgentType | "")
                    }
                  >
                    <DropdownMenuRadioItem value="">
                      None
                    </DropdownMenuRadioItem>
                    {AGENT_TYPES.map((t) => (
                      <DropdownMenuRadioItem key={t.value} value={t.value}>
                        {t.label}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              <p className="text-xs text-muted-foreground">
                The coding agent used for background jobs.
              </p>
            </div>
            {agentType && (
              <div className="space-y-2">
                <Label htmlFor="agent-command">
                  Command{" "}
                  <span className="text-muted-foreground font-normal">
                    (optional)
                  </span>
                </Label>
                <Input
                  id="agent-command"
                  placeholder="claude --dangerously-skip-permissions"
                  value={agentCommand}
                  onChange={(e) => setAgentCommand(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Custom command with arguments to run the agent. Leave empty to
                  use the default command for the selected agent type.
                </p>
              </div>
            )}
            <Button onClick={handleSave} size="sm">
              Save
            </Button>
          </div>
        )}

        {section === "defaults" && (
          <div className="space-y-4 px-1">
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
                className="w-full min-h-[160px] rounded-md border border-input bg-background px-2 py-1.5 text-xs font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 dark:bg-input/30"
                placeholder='{"layout": {...}, "terminals": [...]}'
                value={defaultsJson}
                onChange={(e) => handleDefaultsChange(e.target.value)}
                autoCapitalize="off"
                autoCorrect="off"
                autoComplete="off"
                spellCheck={false}
              />
              {defaultsError && (
                <p className="text-xs text-destructive">{defaultsError}</p>
              )}
              <p className="text-xs text-muted-foreground">
                Default VS Code layout and terminal configuration applied to
                Band worktrees that don't have a project-level{" "}
                <code className="text-xs">.band/config.json</code>. Leave empty
                to disable.
              </p>
            </div>
            <Button
              onClick={handleSave}
              size="sm"
              disabled={!!defaultsError}
            >
              Save
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2 px-1">
        <h2 className="text-base font-semibold">Settings</h2>
        <Button variant="ghost" size="icon-xs" onClick={onClose}>
          <X />
        </Button>
      </div>
      <div className="flex flex-col gap-px">
        <SettingsRow
          label="General"
          value={worktreesDirPreview}
          onClick={() => setSection("general")}
        />
        <Separator />
        <SettingsRow
          label="Coding Agent"
          value={agentPreview}
          onClick={() => setSection("coding-agent")}
        />
        <Separator />
        <SettingsRow
          label="Workspace Settings"
          value={defaultsPreview}
          onClick={() => setSection("defaults")}
        />
      </div>
    </div>
  );
}
