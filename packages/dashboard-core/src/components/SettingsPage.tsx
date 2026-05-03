import {
  Button,
  ColorPicker,
  Input,
  Label,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  Switch,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@band-app/ui";
import { ChevronLeft, ChevronRight, FolderOpen, Plus, Save, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useAdapter, useCapabilities } from "../context";
import { useUpdateSettings } from "../hooks/use-settings-mutations";
import { useSettingsQuery } from "../hooks/use-settings-query";
import { playSound, SOUNDS, type SoundId } from "../lib/sounds";
import type { CodingAgentDefinition, CodingAgentType, LabelDefinition, Theme } from "../types";
import { AgentIcon } from "./agent-icons";
import { SettingsRow } from "./settings/SettingsRow";
import { SettingsSection } from "./settings/SettingsSection";

const KNOWN_AGENTS: { id: string; type: CodingAgentType; label: string; defaultCommand: string }[] =
  [
    { id: "claude-code", type: "claude-code", label: "Claude Code", defaultCommand: "claude" },
    { id: "codex", type: "codex", label: "Codex", defaultCommand: "codex" },
    { id: "opencode", type: "opencode", label: "OpenCode", defaultCommand: "opencode" },
  ];

// Sentinel used by the per-agent "Default model" Select. Radix forbids
// empty-string SelectItem values (it reserves them for "no selection"), so
// we use this opaque token in the UI and translate to/from `undefined`
// when reading or writing the persisted agent definition.
const MODEL_DEFAULT_SENTINEL = "__band_default__";

type Section =
  | "menu"
  | "appearance"
  | "general"
  | "coding-agent"
  | "notifications"
  | "web-server"
  | "labels";

const SECTION_TITLES: Record<Exclude<Section, "menu">, string> = {
  appearance: "Appearance",
  general: "General",
  labels: "Labels",
  "coding-agent": "Coding Agents",
  notifications: "Notifications",
  "web-server": "Web Server",
};

interface Props {
  onClose?: () => void;
  hideTitle?: boolean;
}

function SettingsMenuRow({
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
      return "appearance";
    }
    return "menu";
  });
  const [worktreesDir, setWorktreesDir] = useState(settings.worktreesDir ?? "");
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

  const isDirty = useMemo(() => {
    if (worktreesDir !== (settings.worktreesDir ?? "")) return true;
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
    return false;
  }, [
    worktreesDir,
    codingAgents,
    defaultAgentId,
    webServerPort,
    soundOnNeedsAttention,
    selectedSound,
    labels,
    autoStartTunnel,
    enableLSP,
    selectedTheme,
    settings,
  ]);

  useEffect(() => {
    setWorktreesDir(settings.worktreesDir ?? "");
    setCodingAgents(Array.isArray(settings.codingAgents) ? settings.codingAgents : []);
    setDefaultAgentId(settings.defaultCodingAgent ?? "");
    setWebServerPort(settings.webServerPort?.toString() ?? "");
    setSoundOnNeedsAttention(settings.notifications?.soundOnNeedsAttention ?? false);
    setSelectedSound((settings.notifications?.sound as SoundId) ?? "chime");
    setLabels(settings.labels ?? []);
    setAutoStartTunnel(settings.autoStartTunnel ?? false);
    setEnableLSP(settings.enableLSP ?? false);
    setSelectedTheme(settings.theme ?? "system");
  }, [
    settings.worktreesDir,
    settings.codingAgents,
    settings.defaultCodingAgent,
    settings.webServerPort,
    settings.notifications,
    settings.labels,
    settings.autoStartTunnel,
    settings.enableLSP,
    settings.theme,
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

  const handleSave = async () => {
    let parsedPort: number | undefined;
    if (webServerPort.trim()) {
      const n = parseInt(webServerPort.trim(), 10);
      if (Number.isNaN(n) || n <= 0 || n >= 65536) return;
      parsedPort = n;
    }
    await updateSettingsMutation.mutateAsync({
      worktreesDir: worktreesDir.trim() || null,
      codingAgents: codingAgents.length > 0 ? codingAgents : undefined,
      defaultCodingAgent: defaultAgentId || undefined,
      webServerPort: parsedPort,
      notifications: { soundOnNeedsAttention, sound: selectedSound },
      labels: labels.length > 0 ? labels : undefined,
      tokenSecret: settings.tokenSecret,
      autoStartTunnel: autoStartTunnel || undefined,
      enableLSP: enableLSP || undefined,
      theme: selectedTheme,
    });
  };

  const worktreesDirPreview = worktreesDir || "Default";
  const agentPreview =
    codingAgents.length > 0
      ? `${codingAgents.length} agent${codingAgents.length === 1 ? "" : "s"}`
      : "None";
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
      {activeSection === "appearance" && (
        <SettingsSection title="Appearance">
          <SettingsRow
            label="Theme"
            description="Choose between system default, light, and dark mode. System follows your OS preference. You can also cycle through themes using the toolbar button."
          >
            <SegmentedControl<Theme>
              ariaLabel="Theme"
              options={[
                { value: "system", label: "System" },
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
              ]}
              value={selectedTheme}
              onChange={(v) => setSelectedTheme(v)}
            />
          </SettingsRow>
        </SettingsSection>
      )}

      {activeSection === "general" && (
        <SettingsSection title="General">
          <SettingsRow
            htmlFor="worktrees-dir"
            label="Worktrees folder"
            description="Directory where new worktrees are created. Leave empty for the default location."
          >
            <div className="flex w-[22rem] max-w-full gap-2">
              <Input
                id="worktrees-dir"
                placeholder="~/.band/worktrees (default)"
                value={worktreesDir}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setWorktreesDir(e.target.value)
                }
                className="h-8 text-sm"
              />
              {capabilities.pickFolder && (
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  onClick={handleBrowse}
                  aria-label="Browse for folder"
                >
                  <FolderOpen />
                </Button>
              )}
            </div>
          </SettingsRow>
          <SettingsRow
            htmlFor="enable-lsp"
            label="Code intelligence (LSP)"
            description="Enable hover type info and go-to-definition in the code browser. Currently supports TypeScript and JavaScript. Uses additional memory per workspace."
          >
            <Switch id="enable-lsp" checked={enableLSP} onCheckedChange={setEnableLSP} />
          </SettingsRow>
        </SettingsSection>
      )}

      {activeSection === "labels" && (
        <SettingsSection
          title="Labels"
          description="Tag projects to filter and group them in the sidebar."
        >
          {labels.length === 0 ? (
            <SettingsRow label="No labels yet" description="Add a label to start tagging projects.">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const id = `lbl_${Date.now()}`;
                  setLabels((prev) => [...prev, { id, name: "New label", color: "#3b82f6" }]);
                }}
              >
                <Plus className="size-3" />
                Add label
              </Button>
            </SettingsRow>
          ) : (
            <>
              {labels.map((lbl) => (
                <div
                  key={lbl.id}
                  data-slot="settings-row"
                  className="flex items-center gap-2 px-4 py-2.5"
                >
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
                    className="flex-1 h-8 text-sm"
                  />
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Remove label"
                    className="text-destructive hover:text-destructive shrink-0"
                    onClick={() => setLabels((prev) => prev.filter((l) => l.id !== lbl.id))}
                  >
                    <Trash2 className="size-3" />
                  </Button>
                </div>
              ))}
              <div data-slot="settings-row" className="flex items-center px-4 py-2.5">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const id = `lbl_${Date.now()}`;
                    setLabels((prev) => [...prev, { id, name: "New label", color: "#3b82f6" }]);
                  }}
                >
                  <Plus className="size-3" />
                  Add label
                </Button>
              </div>
            </>
          )}
        </SettingsSection>
      )}

      {activeSection === "coding-agent" && (
        <SettingsSection
          title="Coding Agents"
          description="Enable agents and set a default. The default agent is used for new workspaces. You can switch agents per workspace from the workspace chat header."
        >
          {KNOWN_AGENTS.map((known) => {
            const agent = codingAgents.find((a) => a.type === known.type);
            const enabled = !!agent;
            const isDefault = enabled && defaultAgentId === (agent?.id ?? known.id);
            const models = agentModels[known.type] ?? [];
            return (
              <div
                key={known.id}
                data-slot="settings-row"
                className={`px-4 py-3 transition-opacity ${!enabled ? "opacity-60" : ""}`}
              >
                <div className="flex items-center gap-3">
                  <span
                    className={`size-2 rounded-full shrink-0 ${enabled ? "bg-green-500" : "bg-muted-foreground/30"}`}
                  />
                  <AgentIcon type={known.type} className="size-4 shrink-0" />
                  <span className="flex-1 text-sm font-medium">{known.label}</span>
                  <Switch
                    aria-label={`Enable ${known.label}`}
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
                  <div className="mt-3 space-y-2.5 pl-7">
                    <button
                      type="button"
                      onClick={() => setDefaultAgentId(agent?.id ?? known.id)}
                      className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium transition-colors ${
                        isDefault
                          ? "bg-primary/15 text-primary"
                          : "text-muted-foreground hover:text-foreground hover:bg-muted"
                      }`}
                    >
                      {isDefault ? "Default" : "Set as default"}
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
                        className="h-8 text-xs"
                      />
                    </div>
                    {models.length > 0 && (
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">Default model</Label>
                        <Select
                          // Radix Select reserves the empty string for the
                          // "no selection / show placeholder" state, so we
                          // round-trip through a sentinel for "use the agent's
                          // built-in default model".
                          value={agent?.model ?? MODEL_DEFAULT_SENTINEL}
                          onValueChange={(v: string) =>
                            setCodingAgents((prev) =>
                              prev.map((a) =>
                                a.type === known.type
                                  ? {
                                      ...a,
                                      model: v === MODEL_DEFAULT_SENTINEL ? undefined : v,
                                    }
                                  : a,
                              ),
                            )
                          }
                        >
                          <SelectTrigger className="h-8 text-xs">
                            <SelectValue placeholder="Default" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={MODEL_DEFAULT_SENTINEL}>Default</SelectItem>
                            {models.map((m) => (
                              <SelectItem key={m.id} value={m.id}>
                                {m.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </SettingsSection>
      )}

      {activeSection === "notifications" && (
        <SettingsSection title="Notifications">
          <SettingsRow
            htmlFor="sound-needs-attention"
            label="Play sound on needs attention"
            description="Play a sound when an agent transitions from working to needs attention."
          >
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
          </SettingsRow>
          {soundOnNeedsAttention && (
            <SettingsRow
              label="Sound"
              description="Choose which sound plays. Selecting one previews it."
            >
              <Select
                value={selectedSound}
                onValueChange={(v: string) => {
                  setSelectedSound(v as SoundId);
                  playSound(v as SoundId);
                }}
              >
                <SelectTrigger className="h-8 min-w-[10rem] text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SOUNDS.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsRow>
          )}
        </SettingsSection>
      )}

      {activeSection === "web-server" && (
        <SettingsSection title="Web Server">
          <SettingsRow
            htmlFor="web-server-port"
            label="Port"
            description="Port the web server listens on for mobile access. Leave empty for the default (3456). Requires restart."
          >
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
              className="h-8 w-32 text-sm"
            />
          </SettingsRow>
          <SettingsRow
            htmlFor="auto-start-tunnel"
            label="Auto-start tunnel"
            description="Automatically start the web server and tunnel when the app launches."
          >
            <Switch
              id="auto-start-tunnel"
              checked={autoStartTunnel}
              onCheckedChange={setAutoStartTunnel}
            />
          </SettingsRow>
        </SettingsSection>
      )}
    </>
  );

  /* ── Menu items ─────────────────────────────────────────── */

  const menuItems = (
    <div className="flex flex-col gap-px">
      <SettingsMenuRow
        label="Appearance"
        value={themePreview}
        active={activeSection === "appearance"}
        onClick={() => setSection("appearance")}
      />
      <Separator />
      <SettingsMenuRow
        label="General"
        value={worktreesDirPreview}
        active={activeSection === "general"}
        onClick={() => setSection("general")}
      />
      <Separator />
      <SettingsMenuRow
        label="Labels"
        value={labelsPreview}
        active={activeSection === "labels"}
        onClick={() => setSection("labels")}
      />
      <Separator />
      <SettingsMenuRow
        label="Coding Agents"
        value={agentPreview}
        active={activeSection === "coding-agent"}
        onClick={() => setSection("coding-agent")}
      />
      <Separator />
      <SettingsMenuRow
        label="Notifications"
        value={notificationsPreview}
        active={activeSection === "notifications"}
        onClick={() => setSection("notifications")}
      />
      <Separator />
      <SettingsMenuRow
        label="Web Server"
        value={portPreview}
        active={activeSection === "web-server"}
        onClick={() => setSection("web-server")}
      />
    </div>
  );

  /* ── Layout ─────────────────────────────────────────────── */

  return (
    <div className="flex flex-col lg:flex-row h-full bg-background">
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
          <div className="px-4 pb-6 lg:px-6 lg:py-4">
            <div className="flex items-center gap-1 mb-3">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setSection("menu")}
                className="lg:hidden"
              >
                <ChevronLeft className="size-5" />
              </Button>
              <h2 className="text-base font-semibold flex-1 lg:hidden">
                {SECTION_TITLES[activeSection]}
              </h2>
              <div className="flex-1 hidden lg:block" />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={handleSave}
                    aria-label="Save"
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
            {sectionContent}
          </div>
        )}
      </div>
    </div>
  );
}
