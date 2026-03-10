import {
  Button,
  ColorPicker,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  Input,
  Label,
  Separator,
  Switch,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@band/ui";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  Plus,
  Save,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useCapabilities } from "../context";
import { useUpdateSettings } from "../hooks/use-settings-mutations";
import { useSettingsQuery } from "../hooks/use-settings-query";
import { playSound, SOUNDS, type SoundId } from "../lib/sounds";
import type { CodingAgentConfig, CodingAgentType, LabelDefinition } from "../types";

const AGENT_TYPES: { value: CodingAgentType; label: string }[] = [
  { value: "claude-code", label: "Claude Code" },
];

const AGENT_LABEL: Record<string, string> = {
  "claude-code": "Claude Code",
};

const DEFAULT_DEFAULTS = {
  apps: [
    {
      type: "vscode" as const,
      terminals: [
        { name: "claude", command: "claude", agentType: "claude-code" as const },
        { name: "shell", command: "", split: "vertical" as const },
      ],
    },
  ],
};

type Section =
  | "menu"
  | "general"
  | "coding-agent"
  | "defaults"
  | "notifications"
  | "web-server"
  | "labels";

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
  const { settings } = useSettingsQuery();
  const updateSettingsMutation = useUpdateSettings();
  const capabilities = useCapabilities();
  const [section, setSection] = useState<Section>("menu");
  const [worktreesDir, setWorktreesDir] = useState(settings.worktreesDir ?? "");
  const [defaultsJson, setDefaultsJson] = useState("");
  const [defaultsError, setDefaultsError] = useState<string | null>(null);
  const [agentType, setAgentType] = useState<CodingAgentType | "">(
    settings.codingAgent?.type ?? "",
  );
  const [agentCommand, setAgentCommand] = useState(settings.codingAgent?.command ?? "");
  const [webServerPort, setWebServerPort] = useState(settings.webServerPort?.toString() ?? "");
  const [soundOnNeedsAttention, setSoundOnNeedsAttention] = useState(
    settings.notifications?.soundOnNeedsAttention ?? false,
  );
  const [selectedSound, setSelectedSound] = useState<SoundId>(
    (settings.notifications?.sound as SoundId) ?? "chime",
  );
  const [labels, setLabels] = useState<LabelDefinition[]>(settings.labels ?? []);
  const [tunnelSubdomain, setTunnelSubdomain] = useState(settings.tunnelSubdomain ?? "");
  const [autoStartTunnel, setAutoStartTunnel] = useState(settings.autoStartTunnel ?? false);

  useEffect(() => {
    setWorktreesDir(settings.worktreesDir ?? "");
    setDefaultsJson(settings.defaults ? JSON.stringify(settings.defaults, null, 2) : "");
    setAgentType(settings.codingAgent?.type ?? "");
    setAgentCommand(settings.codingAgent?.command ?? "");
    setWebServerPort(settings.webServerPort?.toString() ?? "");
    setSoundOnNeedsAttention(settings.notifications?.soundOnNeedsAttention ?? false);
    setSelectedSound((settings.notifications?.sound as SoundId) ?? "chime");
    setLabels(settings.labels ?? []);
    setTunnelSubdomain(settings.tunnelSubdomain ?? "");
    setAutoStartTunnel(settings.autoStartTunnel ?? false);
  }, [
    settings.worktreesDir,
    settings.defaults,
    settings.codingAgent,
    settings.webServerPort,
    settings.notifications,
    settings.labels,
    settings.tunnelSubdomain,
    settings.autoStartTunnel,
  ]);

  const handleBrowse = async () => {
    if (!capabilities.pickFolder) return;
    try {
      const selected = await capabilities.pickFolder();
      if (selected) setWorktreesDir(selected);
    } catch {
      // Dialog cancelled
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
    let defaults: Record<string, unknown> | undefined;
    if (defaultsJson.trim()) {
      try {
        defaults = JSON.parse(defaultsJson);
      } catch {
        return;
      }
    }
    let codingAgent: CodingAgentConfig | undefined;
    if (agentType) {
      codingAgent = { type: agentType };
      if (agentCommand.trim()) {
        codingAgent.command = agentCommand.trim();
      }
    }
    let parsedPort: number | undefined;
    if (webServerPort.trim()) {
      const n = parseInt(webServerPort.trim(), 10);
      if (Number.isNaN(n) || n <= 0 || n >= 65536) return;
      parsedPort = n;
    }
    await updateSettingsMutation.mutateAsync({
      worktreesDir: worktreesDir.trim() || null,
      defaults,
      codingAgent,
      webServerPort: parsedPort,
      notifications: { soundOnNeedsAttention, sound: selectedSound },
      labels: labels.length > 0 ? labels : undefined,
      tokenSecret: settings.tokenSecret,
      tunnelSubdomain: tunnelSubdomain.trim() || undefined,
      autoStartTunnel: autoStartTunnel || undefined,
    });
  };

  const worktreesDirPreview = worktreesDir || "Default";
  const agentPreview = agentType ? AGENT_LABEL[agentType] : "None";
  const defaultsPreview = defaultsJson.trim() ? "Configured" : "None";
  const portPreview = tunnelSubdomain
    ? `${tunnelSubdomain}.instatunnel.my`
    : webServerPort || "3456";
  const labelsPreview =
    labels.length > 0 ? `${labels.length} label${labels.length === 1 ? "" : "s"}` : "None";
  const notificationsPreview = soundOnNeedsAttention
    ? (SOUNDS.find((s) => s.id === selectedSound)?.label ?? "On")
    : "Off";

  if (section !== "menu") {
    return (
      <div>
        <div className="flex items-center gap-1 mb-3 px-1">
          <Button variant="ghost" size="icon-sm" onClick={() => setSection("menu")}>
            <ChevronLeft className="size-5" />
          </Button>
          <h2 className="text-base font-semibold flex-1">
            {section === "general" && "General"}
            {section === "labels" && "Labels"}
            {section === "coding-agent" && "Coding Agent"}
            {section === "defaults" && "Workspace Settings"}
            {section === "notifications" && "Notifications"}
            {section === "web-server" && "Web Server"}
          </h2>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={handleSave}
                disabled={section === "defaults" && !!defaultsError}
              >
                <Save className="size-5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Save</TooltipContent>
          </Tooltip>
        </div>
        <Separator className="mb-3" />

        {section === "general" && (
          <div className="space-y-4 px-1">
            <div className="space-y-2">
              <Label htmlFor="worktrees-dir">Worktrees folder</Label>
              <div className="flex gap-2">
                <Input
                  id="worktrees-dir"
                  placeholder="~/.band/worktrees (default)"
                  value={worktreesDir}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setWorktreesDir(e.target.value)
                  }
                />
                {capabilities.pickFolder && (
                  <Button type="button" variant="ghost" size="icon" onClick={handleBrowse}>
                    <FolderOpen />
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Directory where new worktrees are created. Leave empty for the default location.
              </p>
            </div>
          </div>
        )}

        {section === "labels" && (
          <div className="space-y-3 px-1">
            {labels.map((lbl) => (
              <div key={lbl.id} className="flex items-center gap-2">
                <ColorPicker
                  value={lbl.color}
                  onChange={(color) =>
                    setLabels((prev) => prev.map((l) => (l.id === lbl.id ? { ...l, color } : l)))
                  }
                  showHex={false}
                  className="w-auto h-7 px-1.5 shrink-0"
                />
                <Input
                  value={lbl.name}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setLabels((prev) =>
                      prev.map((l) => (l.id === lbl.id ? { ...l, name: e.target.value } : l)),
                    )
                  }
                  className="flex-1 h-7 text-xs"
                />
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="text-destructive hover:text-destructive shrink-0"
                  onClick={() => setLabels((prev) => prev.filter((l) => l.id !== lbl.id))}
                >
                  <Trash2 className="size-3" />
                </Button>
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              className="w-full text-xs"
              onClick={() => {
                const id = `lbl_${Date.now()}`;
                setLabels((prev) => [...prev, { id, name: "New label", color: "#3b82f6" }]);
              }}
            >
              <Plus className="size-3 mr-1" />
              Add label
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
                <DropdownMenuContent
                  align="start"
                  className="w-[--radix-dropdown-menu-trigger-width]"
                >
                  <DropdownMenuRadioGroup
                    value={agentType}
                    onValueChange={(v: string) => setAgentType(v as CodingAgentType | "")}
                  >
                    <DropdownMenuRadioItem value="">None</DropdownMenuRadioItem>
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
                  Command <span className="text-muted-foreground font-normal">(optional)</span>
                </Label>
                <Input
                  id="agent-command"
                  placeholder="claude --dangerously-skip-permissions"
                  value={agentCommand}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setAgentCommand(e.target.value)
                  }
                />
                <p className="text-xs text-muted-foreground">
                  Custom command with arguments to run the agent. Leave empty to use the default
                  command for the selected agent type.
                </p>
              </div>
            )}
          </div>
        )}

        {section === "defaults" && (
          <div className="space-y-4 px-1">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="defaults-json">Default apps configuration</Label>
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
                placeholder='{"apps": [{"type": "vscode", ...}]}'
                value={defaultsJson}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                  handleDefaultsChange(e.target.value)
                }
                autoCapitalize="off"
                autoCorrect="off"
                autoComplete="off"
                spellCheck={false}
              />
              {defaultsError && <p className="text-xs text-destructive">{defaultsError}</p>}
              <p className="text-xs text-muted-foreground">
                Default apps configuration applied to Band worktrees that don't have a project-level{" "}
                <code className="text-xs">.band/config.json</code>. Defines which apps (VS Code,
                Zed, iTerm, Chrome) to open and their layout. Leave empty to disable.
              </p>
            </div>
          </div>
        )}

        {section === "notifications" && (
          <div className="space-y-4 px-1">
            <div className="space-y-2">
              <Label>Notification sound</Label>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  Play when agent needs attention
                </span>
                <Switch
                  id="sound-needs-attention"
                  checked={soundOnNeedsAttention}
                  onCheckedChange={(checked: boolean) => {
                    setSoundOnNeedsAttention(checked);
                    if (checked) {
                      playSound(selectedSound);
                    }
                  }}
                />
              </div>
            </div>
            {soundOnNeedsAttention && (
              <div className="space-y-2">
                <Label>Sound</Label>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full justify-between font-normal h-7 text-xs px-2"
                    >
                      {SOUNDS.find((s) => s.id === selectedSound)?.label ?? "Chime"}
                      <ChevronDown className="size-3 opacity-50" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="start"
                    className="w-[--radix-dropdown-menu-trigger-width]"
                  >
                    <DropdownMenuRadioGroup
                      value={selectedSound}
                      onValueChange={(v: string) => {
                        setSelectedSound(v as SoundId);
                        playSound(v as SoundId);
                      }}
                    >
                      {SOUNDS.map((s) => (
                        <DropdownMenuRadioItem key={s.id} value={s.id}>
                          {s.label}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
                <p className="text-xs text-muted-foreground">
                  Choose a sound to play when an agent transitions from working to needs attention.
                </p>
              </div>
            )}
          </div>
        )}

        {section === "web-server" && (
          <div className="space-y-4 px-1">
            <div className="space-y-2">
              <Label htmlFor="web-server-port">Port</Label>
              <Input
                id="web-server-port"
                type="number"
                placeholder="3456 (default)"
                value={webServerPort}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setWebServerPort(e.target.value)
                }
                min={1}
                max={65535}
              />
              <p className="text-xs text-muted-foreground">
                Port the web server listens on for mobile access. Leave empty for the default
                (3456). Requires restart.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="tunnel-subdomain">Tunnel subdomain</Label>
              <Input
                id="tunnel-subdomain"
                placeholder="e.g., myapp"
                value={tunnelSubdomain}
                onChange={(e) => setTunnelSubdomain(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Fixed subdomain for your tunnel URL (e.g., <code className="text-xs">myapp</code>{" "}
                becomes <code className="text-xs">myapp.instatunnel.my</code>). Requires instatunnel
                authentication.
              </p>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="auto-start-tunnel">Auto-start tunnel</Label>
                <Switch
                  id="auto-start-tunnel"
                  checked={autoStartTunnel}
                  onCheckedChange={setAutoStartTunnel}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Automatically start the web server and tunnel when the app launches.
              </p>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-1 mb-2 px-1">
        <Button variant="ghost" size="icon-sm" onClick={onClose}>
          <ChevronLeft className="size-5" />
        </Button>
        <h2 className="text-base font-semibold">Settings</h2>
      </div>
      <Separator />
      <div className="flex flex-col gap-px">
        <SettingsRow
          label="General"
          value={worktreesDirPreview}
          onClick={() => setSection("general")}
        />
        <Separator />
        <SettingsRow label="Labels" value={labelsPreview} onClick={() => setSection("labels")} />
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
        <Separator />
        <SettingsRow
          label="Notifications"
          value={notificationsPreview}
          onClick={() => setSection("notifications")}
        />
        <Separator />
        <SettingsRow
          label="Web Server"
          value={portPreview}
          onClick={() => setSection("web-server")}
        />
      </div>
    </div>
  );
}
