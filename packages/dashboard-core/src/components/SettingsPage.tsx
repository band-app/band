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
} from "@band-app/ui";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  Plus,
  Save,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useAdapter, useCapabilities } from "../context";
import { useUpdateSettings } from "../hooks/use-settings-mutations";
import { useSettingsQuery } from "../hooks/use-settings-query";
import { playSound, SOUNDS, type SoundId } from "../lib/sounds";
import type {
  AppMode,
  CodingAgentDefinition,
  CodingAgentType,
  LabelDefinition,
  Theme,
} from "../types";
import { AgentIcon } from "./agent-icons";

const KNOWN_AGENTS: { id: string; type: CodingAgentType; label: string; defaultCommand: string }[] =
  [
    { id: "claude-code", type: "claude-code", label: "Claude Code", defaultCommand: "claude" },
    { id: "codex", type: "codex", label: "Codex", defaultCommand: "codex" },
    { id: "opencode", type: "opencode", label: "OpenCode", defaultCommand: "opencode" },
  ];

const DEFAULT_DEFAULTS = {
  apps: [
    {
      type: "vscode" as const,
      terminals: [
        { name: "claude", command: "band tasks watch && claude --continue" },
        { name: "shell", command: "", split: "vertical" as const },
      ],
    },
  ],
};

type Section =
  | "menu"
  | "app-mode"
  | "appearance"
  | "general"
  | "coding-agent"
  | "defaults"
  | "notifications"
  | "web-server"
  | "labels";

const SECTION_TITLES: Record<Exclude<Section, "menu">, string> = {
  "app-mode": "App Mode",
  appearance: "Appearance",
  general: "General",
  labels: "Labels",
  "coding-agent": "Coding Agents",
  defaults: "Workspace Settings",
  notifications: "Notifications",
  "web-server": "Web Server",
};

interface Props {
  onClose?: () => void;
  hideTitle?: boolean;
}

function SettingsRow({
  label,
  value,
  active,
  onClick,
}: {
  label: string;
  value?: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`flex w-full items-center justify-between px-3 py-2.5 text-sm hover:bg-accent/50 rounded-md transition-colors text-left ${active ? "bg-accent/50" : ""}`}
      onClick={onClick}
    >
      <span>{label}</span>
      <span className="flex items-center gap-1 text-muted-foreground">
        {value && <span className="text-xs truncate max-w-[140px]">{value}</span>}
        <ChevronRight className="size-4 shrink-0 lg:hidden" />
      </span>
    </button>
  );
}

export function SettingsPage({ onClose, hideTitle }: Props) {
  const { settings } = useSettingsQuery();
  const updateSettingsMutation = useUpdateSettings();
  const capabilities = useCapabilities();
  const [section, setSection] = useState<Section>(() => {
    if (typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches) {
      return "app-mode";
    }
    return "menu";
  });
  const [worktreesDir, setWorktreesDir] = useState(settings.worktreesDir ?? "");
  const [defaultsJson, setDefaultsJson] = useState("");
  const [defaultsError, setDefaultsError] = useState<string | null>(null);
  const [codingAgents, setCodingAgents] = useState<CodingAgentDefinition[]>(
    Array.isArray(settings.codingAgents) ? settings.codingAgents : [],
  );
  const [defaultAgentId, setDefaultAgentId] = useState(settings.defaultCodingAgent ?? "");
  const [webServerPort, setWebServerPort] = useState(settings.webServerPort?.toString() ?? "");
  const [soundOnNeedsAttention, setSoundOnNeedsAttention] = useState(
    settings.notifications?.soundOnNeedsAttention ?? false,
  );
  const [selectedSound, setSelectedSound] = useState<SoundId>(
    (settings.notifications?.sound as SoundId) ?? "chime",
  );
  const [labels, setLabels] = useState<LabelDefinition[]>(settings.labels ?? []);
  const [autoStartTunnel, setAutoStartTunnel] = useState(settings.autoStartTunnel ?? false);
  const [enableLSP, setEnableLSP] = useState(settings.enableLSP ?? false);
  const [selectedTheme, setSelectedTheme] = useState<Theme>(settings.theme ?? "system");
  const [appMode, setAppMode] = useState<AppMode>(settings.appMode ?? "side-panel");
  const [agentModels, setAgentModels] = useState<
    Record<string, { id: string; name: string; description?: string }[]>
  >({});

  const adapter = useAdapter();

  // Fetch available models for each enabled agent type
  useEffect(() => {
    if (!adapter.listModels) return;
    for (const agent of codingAgents) {
      adapter
        .listModels(agent.id)
        .then((models) => {
          setAgentModels((prev) => ({ ...prev, [agent.type]: models }));
        })
        .catch(() => {
          // Models unavailable for this agent type
        });
    }
  }, [codingAgents, adapter]);

  const isTauriApp = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  const isDirty = useMemo(() => {
    if (worktreesDir !== (settings.worktreesDir ?? "")) return true;
    const savedDefaults = settings.defaults ? JSON.stringify(settings.defaults, null, 2) : "";
    if (defaultsJson !== savedDefaults) return true;
    if (
      JSON.stringify(codingAgents) !==
      JSON.stringify(Array.isArray(settings.codingAgents) ? settings.codingAgents : [])
    )
      return true;
    if (defaultAgentId !== (settings.defaultCodingAgent ?? "")) return true;
    if (webServerPort !== (settings.webServerPort?.toString() ?? "")) return true;
    if (soundOnNeedsAttention !== (settings.notifications?.soundOnNeedsAttention ?? false))
      return true;
    if (selectedSound !== ((settings.notifications?.sound as SoundId) ?? "chime")) return true;
    if (JSON.stringify(labels) !== JSON.stringify(settings.labels ?? [])) return true;
    if (autoStartTunnel !== (settings.autoStartTunnel ?? false)) return true;
    if (enableLSP !== (settings.enableLSP ?? false)) return true;
    if (selectedTheme !== (settings.theme ?? "system")) return true;
    if (appMode !== (settings.appMode ?? "side-panel")) return true;
    return false;
  }, [
    worktreesDir,
    defaultsJson,
    codingAgents,
    defaultAgentId,
    webServerPort,
    soundOnNeedsAttention,
    selectedSound,
    labels,
    autoStartTunnel,
    enableLSP,
    selectedTheme,
    appMode,
    settings,
  ]);

  useEffect(() => {
    setWorktreesDir(settings.worktreesDir ?? "");
    setDefaultsJson(settings.defaults ? JSON.stringify(settings.defaults, null, 2) : "");
    setCodingAgents(Array.isArray(settings.codingAgents) ? settings.codingAgents : []);
    setDefaultAgentId(settings.defaultCodingAgent ?? "");
    setWebServerPort(settings.webServerPort?.toString() ?? "");
    setSoundOnNeedsAttention(settings.notifications?.soundOnNeedsAttention ?? false);
    setSelectedSound((settings.notifications?.sound as SoundId) ?? "chime");
    setLabels(settings.labels ?? []);
    setAutoStartTunnel(settings.autoStartTunnel ?? false);
    setEnableLSP(settings.enableLSP ?? false);
    setSelectedTheme(settings.theme ?? "system");
    setAppMode(settings.appMode ?? "side-panel");
  }, [
    settings.worktreesDir,
    settings.defaults,
    settings.codingAgents,
    settings.defaultCodingAgent,
    settings.webServerPort,
    settings.notifications,
    settings.labels,
    settings.autoStartTunnel,
    settings.enableLSP,
    settings.theme,
    settings.appMode,
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
    let parsedPort: number | undefined;
    if (webServerPort.trim()) {
      const n = parseInt(webServerPort.trim(), 10);
      if (Number.isNaN(n) || n <= 0 || n >= 65536) return;
      parsedPort = n;
    }
    await updateSettingsMutation.mutateAsync({
      worktreesDir: worktreesDir.trim() || null,
      defaults,
      codingAgents: codingAgents.length > 0 ? codingAgents : undefined,
      defaultCodingAgent: defaultAgentId || undefined,
      webServerPort: parsedPort,
      notifications: { soundOnNeedsAttention, sound: selectedSound },
      labels: labels.length > 0 ? labels : undefined,
      tokenSecret: settings.tokenSecret,
      autoStartTunnel: autoStartTunnel || undefined,
      enableLSP: enableLSP || undefined,
      theme: selectedTheme,
      appMode,
    });

    // If running in Tauri and the app mode changed, resize the window
    if (isTauriApp && appMode !== (settings.appMode ?? "side-panel")) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("set_app_mode", { mode: appMode });
      } catch {
        // Tauri command not available; mode will apply on next restart
      }
    }
  };

  const appModePreview = appMode === "full-editor" ? "Full Editor" : "Side Panel";
  const worktreesDirPreview = worktreesDir || "Default";
  const agentPreview =
    codingAgents.length > 0
      ? `${codingAgents.length} agent${codingAgents.length === 1 ? "" : "s"}`
      : "None";
  const defaultsPreview = defaultsJson.trim() ? "Configured" : "None";
  const portPreview = webServerPort || "3456";
  const labelsPreview =
    labels.length > 0 ? `${labels.length} label${labels.length === 1 ? "" : "s"}` : "None";
  const themePreview =
    selectedTheme === "system" ? "System" : selectedTheme === "dark" ? "Dark" : "Light";
  const notificationsPreview = soundOnNeedsAttention
    ? (SOUNDS.find((s) => s.id === selectedSound)?.label ?? "On")
    : "Off";

  const activeSection = section === "menu" ? null : section;

  /* ── Shared section content ─────────────────────────────── */

  const sectionContent = activeSection && (
    <>
      {activeSection === "app-mode" && (
        <div className="space-y-4 px-1">
          <div className="space-y-3">
            <Label>App Mode</Label>
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => setAppMode("side-panel")}
                className={`flex w-full items-start gap-3 rounded-md border p-3 text-left transition-colors ${
                  appMode === "side-panel"
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-muted-foreground/50"
                }`}
              >
                <div
                  className={`mt-0.5 size-4 shrink-0 rounded-full border-2 flex items-center justify-center ${
                    appMode === "side-panel" ? "border-primary" : "border-muted-foreground/40"
                  }`}
                >
                  {appMode === "side-panel" && <div className="size-2 rounded-full bg-primary" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">Side Panel</div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Compact sidebar alongside your IDE. Clicking a workspace opens it in an external
                    editor window.
                  </p>
                </div>
              </button>
              <button
                type="button"
                onClick={() => setAppMode("full-editor")}
                className={`flex w-full items-start gap-3 rounded-md border p-3 text-left transition-colors ${
                  appMode === "full-editor"
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-muted-foreground/50"
                }`}
              >
                <div
                  className={`mt-0.5 size-4 shrink-0 rounded-full border-2 flex items-center justify-center ${
                    appMode === "full-editor" ? "border-primary" : "border-muted-foreground/40"
                  }`}
                >
                  {appMode === "full-editor" && <div className="size-2 rounded-full bg-primary" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">Full Editor</div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Full-width editor with built-in file browser, changes view, chat, and terminal.
                    No external IDE windows needed.
                  </p>
                </div>
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              Choose how Band appears on your desktop.{" "}
              {isTauriApp
                ? "The window will resize immediately after saving."
                : "This setting applies to the desktop app."}
            </p>
          </div>
        </div>
      )}

      {activeSection === "appearance" && (
        <div className="space-y-4 px-1">
          <div className="space-y-2">
            <Label>Theme</Label>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full justify-between font-normal h-7 text-xs px-2"
                >
                  {selectedTheme === "system"
                    ? "System"
                    : selectedTheme === "dark"
                      ? "Dark"
                      : "Light"}
                  <ChevronDown className="size-3 opacity-50" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="w-[--radix-dropdown-menu-trigger-width]"
              >
                <DropdownMenuRadioGroup
                  value={selectedTheme}
                  onValueChange={(v: string) => setSelectedTheme(v as Theme)}
                >
                  <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <p className="text-xs text-muted-foreground">
              Choose between system default, light, and dark mode. System follows your OS
              preference. You can also cycle through themes using the toolbar button.
            </p>
          </div>
        </div>
      )}

      {activeSection === "general" && (
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
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="enable-lsp">Code intelligence (LSP)</Label>
              <Switch id="enable-lsp" checked={enableLSP} onCheckedChange={setEnableLSP} />
            </div>
            <p className="text-xs text-muted-foreground">
              Enable hover type info and go-to-definition in the code browser. Currently supports
              TypeScript and JavaScript. Uses additional memory per workspace.
            </p>
          </div>
        </div>
      )}

      {activeSection === "labels" && (
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

      {activeSection === "coding-agent" && (
        <div className="space-y-3 px-1">
          {KNOWN_AGENTS.map((known) => {
            const agent = codingAgents.find((a) => a.type === known.type);
            const enabled = !!agent;
            return (
              <div
                key={known.id}
                className={`space-y-2 rounded-md border border-border p-3 transition-opacity ${!enabled ? "opacity-50" : ""}`}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`size-2 rounded-full shrink-0 ${enabled ? "bg-green-500" : "bg-muted-foreground/30"}`}
                  />
                  <AgentIcon type={known.type} className="size-4 shrink-0" />
                  <span className="flex-1 text-sm font-medium">{known.label}</span>
                  <Switch
                    checked={enabled}
                    onCheckedChange={(checked: boolean) => {
                      if (checked) {
                        setCodingAgents((prev) => [
                          ...prev,
                          { id: known.id, type: known.type, label: known.label },
                        ]);
                        if (!defaultAgentId) setDefaultAgentId(known.id);
                      } else {
                        setCodingAgents((prev) => prev.filter((a) => a.type !== known.type));
                        if (defaultAgentId === known.id || defaultAgentId === agent?.id) {
                          const remaining = codingAgents.filter((a) => a.type !== known.type);
                          setDefaultAgentId(remaining.length > 0 ? remaining[0].id : "");
                        }
                      }
                    }}
                  />
                </div>
                {enabled && (
                  <div className="space-y-2">
                    <button
                      type="button"
                      onClick={() => setDefaultAgentId(agent?.id ?? known.id)}
                      className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium transition-colors ${
                        defaultAgentId === (agent?.id ?? known.id)
                          ? "bg-primary/15 text-primary"
                          : "text-muted-foreground hover:text-foreground hover:bg-muted"
                      }`}
                    >
                      {defaultAgentId === (agent?.id ?? known.id) ? "Default" : "Set as default"}
                    </button>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Command</Label>
                      <Input
                        placeholder={known.defaultCommand}
                        value={agent?.command ?? ""}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                          setCodingAgents((prev) =>
                            prev.map((a) =>
                              a.type === known.type
                                ? { ...a, command: e.target.value || undefined }
                                : a,
                            ),
                          )
                        }
                        className="h-7 text-xs"
                      />
                    </div>
                    {(agentModels[known.type]?.length ?? 0) > 0 && (
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">Default model</Label>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="outline"
                              size="sm"
                              className="w-full justify-between font-normal h-7 text-xs px-2"
                            >
                              {agentModels[known.type]?.find((m) => m.id === agent?.model)?.name ??
                                "Default"}
                              <ChevronDown className="size-3 opacity-50" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent
                            align="start"
                            className="w-[--radix-dropdown-menu-trigger-width]"
                          >
                            <DropdownMenuRadioGroup
                              value={agent?.model ?? ""}
                              onValueChange={(v: string) =>
                                setCodingAgents((prev) =>
                                  prev.map((a) =>
                                    a.type === known.type ? { ...a, model: v || undefined } : a,
                                  ),
                                )
                              }
                            >
                              <DropdownMenuRadioItem value="">Default</DropdownMenuRadioItem>
                              {agentModels[known.type]?.map((m) => (
                                <DropdownMenuRadioItem key={m.id} value={m.id}>
                                  {m.name}
                                </DropdownMenuRadioItem>
                              ))}
                            </DropdownMenuRadioGroup>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          <p className="text-xs text-muted-foreground">
            Enable agents and set a default. The default agent is used for new workspaces. You can
            switch agents per workspace from the workspace chat header.
          </p>
        </div>
      )}

      {activeSection === "defaults" && (
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
              className="w-full min-h-[400px] rounded-md border border-input bg-background px-2 py-1.5 text-xs font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 dark:bg-input/30"
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
              Cursor, Zed, iTerm, Chrome) to open and their layout. Leave empty to disable.
            </p>
          </div>
        </div>
      )}

      {activeSection === "notifications" && (
        <div className="space-y-4 px-1">
          <div className="space-y-2">
            <Label>Notification sound</Label>
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Play when agent needs attention</span>
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

      {activeSection === "web-server" && (
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
              Port the web server listens on for mobile access. Leave empty for the default (3456).
              Requires restart.
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
    </>
  );

  /* ── Menu items ─────────────────────────────────────────── */

  const menuItems = (
    <div className="flex flex-col gap-px">
      <SettingsRow
        label="App Mode"
        value={appModePreview}
        active={activeSection === "app-mode"}
        onClick={() => setSection("app-mode")}
      />
      <Separator />
      <SettingsRow
        label="Appearance"
        value={themePreview}
        active={activeSection === "appearance"}
        onClick={() => setSection("appearance")}
      />
      <Separator />
      <SettingsRow
        label="General"
        value={worktreesDirPreview}
        active={activeSection === "general"}
        onClick={() => setSection("general")}
      />
      <Separator />
      <SettingsRow
        label="Labels"
        value={labelsPreview}
        active={activeSection === "labels"}
        onClick={() => setSection("labels")}
      />
      <Separator />
      <SettingsRow
        label="Coding Agents"
        value={agentPreview}
        active={activeSection === "coding-agent"}
        onClick={() => setSection("coding-agent")}
      />
      <Separator />
      <SettingsRow
        label="Workspace Settings"
        value={defaultsPreview}
        active={activeSection === "defaults"}
        onClick={() => setSection("defaults")}
      />
      <Separator />
      <SettingsRow
        label="Notifications"
        value={notificationsPreview}
        active={activeSection === "notifications"}
        onClick={() => setSection("notifications")}
      />
      <Separator />
      <SettingsRow
        label="Web Server"
        value={portPreview}
        active={activeSection === "web-server"}
        onClick={() => setSection("web-server")}
      />
    </div>
  );

  /* ── Layout ─────────────────────────────────────────────── */

  return (
    <div className="flex flex-col lg:flex-row h-full">
      {/* ── Left: menu panel ──────────────────────────────── */}
      <div
        className={`lg:w-72 lg:shrink-0 lg:border-r lg:border-border lg:block overflow-y-auto ${section !== "menu" ? "hidden" : ""}`}
      >
        {!hideTitle && (
          <>
            <div className="flex items-center gap-1 mb-2 px-1">
              {onClose && (
                <Button variant="ghost" size="icon-sm" onClick={onClose} className="lg:hidden">
                  <ChevronLeft className="size-5" />
                </Button>
              )}
              <h2 className="text-base font-semibold">Settings</h2>
            </div>
            <Separator />
          </>
        )}
        {menuItems}
      </div>

      {/* ── Right: detail panel ───────────────────────────── */}
      <div
        className={`flex-1 min-w-0 overflow-y-auto lg:block ${section === "menu" ? "hidden" : ""}`}
      >
        {activeSection && (
          <div className="lg:px-4 lg:py-2">
            <div className="flex items-center gap-1 mb-3 px-1">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setSection("menu")}
                className="lg:hidden"
              >
                <ChevronLeft className="size-5" />
              </Button>
              <h2 className="text-base font-semibold flex-1">{SECTION_TITLES[activeSection]}</h2>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={handleSave}
                    disabled={activeSection === "defaults" && !!defaultsError}
                    className="relative"
                  >
                    <Save className="size-5" />
                    {isDirty && (
                      <span className="absolute top-0.5 right-0.5 size-2 rounded-full bg-blue-500" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Save</TooltipContent>
              </Tooltip>
            </div>
            <Separator className="mb-3" />
            {sectionContent}
          </div>
        )}
      </div>
    </div>
  );
}
