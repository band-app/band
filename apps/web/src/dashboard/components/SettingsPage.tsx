import {
  Accordion,
  AccordionContent,
  AccordionHeader,
  AccordionItem,
  AccordionTriggerInline,
  Button,
  ColorPicker,
  cn,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from "@band-app/ui";
import { ChevronDown, FolderOpen, Plus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useAdapter, useCapabilities } from "../context";
import { useUpdateSettings } from "../hooks/use-settings-mutations";
import { useSettingsQuery } from "../hooks/use-settings-query";
import { useExperimentalContextMeter } from "../lib/experimental-flags";
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

interface Props {
  /** Whether the dialog is visible. */
  open: boolean;
  /** Called when the dialog wants to open or close (Esc, backdrop click, Done button). */
  onOpenChange: (open: boolean) => void;
}

/** Compact context-window label, e.g. 200000 → "200k", 1_000_000 → "1M". */
function formatCtxWindow(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${Number.isInteger(m) ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

export function SettingsPage({ open, onOpenChange }: Props) {
  const { settings } = useSettingsQuery();
  const updateSettingsMutation = useUpdateSettings();
  const capabilities = useCapabilities();

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
  const [enableFilePreviewTabs, setEnableFilePreviewTabs] = useState(
    settings.enableFilePreviewTabs ?? true,
  );
  const [claudeCodePartialMessages, setClaudeCodePartialMessages] = useState(
    settings.claudeCodePartialMessages ?? false,
  );
  const [maxCachedWorkspaces, setMaxCachedWorkspaces] = useState(
    settings.maxCachedWorkspaces?.toString() ?? "",
  );
  const [selectedTheme, setSelectedTheme] = useState<Theme>(settings.theme ?? "system");
  // Default true — see Settings.useWebGLTerminalRenderer JSDoc.
  const [useWebGLTerminalRenderer, setUseWebGLTerminalRenderer] = useState(
    settings.useWebGLTerminalRenderer ?? true,
  );
  const [webBrowserCdpEnabled, setWebBrowserCdpEnabled] = useState(
    settings.webBrowserCdpEnabled ?? false,
  );
  const [agentModels, setAgentModels] = useState<
    Record<string, { id: string; name: string; description?: string; contextWindow?: number }[]>
  >({});
  // Experimental flags live in localStorage (per-device) rather than the
  // settings store, so they don't participate in `isDirty` / Save.
  const [contextMeterEnabled, setContextMeterEnabled] = useExperimentalContextMeter();

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
    if (enableFilePreviewTabs !== (settings.enableFilePreviewTabs ?? true)) return true;
    if (claudeCodePartialMessages !== (settings.claudeCodePartialMessages ?? false)) return true;
    if (maxCachedWorkspaces !== (settings.maxCachedWorkspaces?.toString() ?? "")) return true;
    if (selectedTheme !== (settings.theme ?? "system")) return true;
    if (useWebGLTerminalRenderer !== (settings.useWebGLTerminalRenderer ?? true)) return true;
    if (webBrowserCdpEnabled !== (settings.webBrowserCdpEnabled ?? false)) return true;
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
    enableFilePreviewTabs,
    claudeCodePartialMessages,
    maxCachedWorkspaces,
    selectedTheme,
    useWebGLTerminalRenderer,
    webBrowserCdpEnabled,
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
    setEnableFilePreviewTabs(settings.enableFilePreviewTabs ?? true);
    setClaudeCodePartialMessages(settings.claudeCodePartialMessages ?? false);
    setMaxCachedWorkspaces(settings.maxCachedWorkspaces?.toString() ?? "");
    setSelectedTheme(settings.theme ?? "system");
    setUseWebGLTerminalRenderer(settings.useWebGLTerminalRenderer ?? true);
    setWebBrowserCdpEnabled(settings.webBrowserCdpEnabled ?? false);
  }, [
    settings.worktreesDir,
    settings.codingAgents,
    settings.defaultCodingAgent,
    settings.webServerPort,
    settings.notifications,
    settings.labels,
    settings.autoStartTunnel,
    settings.enableLSP,
    settings.enableFilePreviewTabs,
    settings.claudeCodePartialMessages,
    settings.maxCachedWorkspaces,
    settings.theme,
    settings.useWebGLTerminalRenderer,
    settings.webBrowserCdpEnabled,
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
    let parsedMaxCachedWorkspaces: number | undefined;
    if (maxCachedWorkspaces.trim()) {
      const n = parseInt(maxCachedWorkspaces.trim(), 10);
      if (Number.isNaN(n) || n < 1 || n > 20) return;
      parsedMaxCachedWorkspaces = n;
    }
    await updateSettingsMutation.mutateAsync({
      worktreesDir: worktreesDir.trim() || null,
      codingAgents: codingAgents.length > 0 ? codingAgents : undefined,
      defaultCodingAgent: defaultAgentId || undefined,
      webServerPort: parsedPort,
      notifications: { soundOnNeedsAttention, sound: selectedSound },
      labels: labels.length > 0 ? labels : undefined,
      tokenSecret: settings.tokenSecret,
      // Always send explicit booleans rather than `value || undefined`.
      // `saveSettings` does a shallow merge with the on-disk file, so
      // sending `undefined` (or omitting the key) keeps whatever value
      // was there before — meaning once a user ever turned a toggle on,
      // they could never turn it back off through the UI (and vice
      // versa, depending on the default). Sending the value
      // unconditionally avoids that trap.
      autoStartTunnel,
      enableLSP,
      enableFilePreviewTabs,
      claudeCodePartialMessages,
      maxCachedWorkspaces: parsedMaxCachedWorkspaces,
      theme: selectedTheme,
      useWebGLTerminalRenderer,
      webBrowserCdpEnabled,
    });
  };

  const handleSaveAndClose = async () => {
    await handleSave();
    onOpenChange(false);
  };

  /* ── Layout ─────────────────────────────────────────────── */

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={
          // Mobile: take the full viewport — no margin, no rounded corners,
          // top-anchored so the address-bar doesn't clip the footer.
          // Desktop (sm+): float as a centered, capped-width card.
          [
            "inset-0 left-0 top-0 h-dvh w-full max-w-none translate-x-0 translate-y-0 rounded-none",
            "sm:inset-auto sm:top-[50%] sm:left-[50%] sm:h-[80vh] sm:w-full sm:max-w-2xl sm:translate-x-[-50%] sm:translate-y-[-50%] sm:rounded-lg",
            "overflow-hidden p-0 flex flex-col gap-0",
          ].join(" ")
        }
      >
        <DialogHeader className="px-6 pt-6 pb-4 shrink-0">
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>
        {/* Body — every section stacked in a single scrolling column. */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="flex flex-col gap-6 px-6 pb-6">
            {/* ── Appearance ─────────────────────────────────── */}
            <SettingsSection title="Appearance">
              <SettingsRow
                variant="responsive"
                label="Theme"
                description="Choose between system default, light, and dark mode."
              >
                <Select
                  value={selectedTheme}
                  onValueChange={(v: string) => setSelectedTheme(v as Theme)}
                >
                  <SelectTrigger className="h-8 w-full text-sm sm:w-32" aria-label="Theme">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="system">System</SelectItem>
                    <SelectItem value="light">Light</SelectItem>
                    <SelectItem value="dark">Dark</SelectItem>
                  </SelectContent>
                </Select>
              </SettingsRow>
            </SettingsSection>

            {/* ── General ────────────────────────────────────── */}
            <SettingsSection title="General">
              <SettingsRow
                variant="responsive"
                htmlFor="worktrees-dir"
                label="Worktrees folder"
                description="Directory where new worktrees are created. Leave empty for the default location."
              >
                <div className="flex w-full gap-2 sm:w-[22rem]">
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
              <SettingsRow
                htmlFor="enable-file-preview-tabs"
                label="Preview tabs (single-click open)"
                description="Single-click a file in the tree to open it in a temporary preview tab. Double-click or edit to keep it open."
              >
                <Switch
                  id="enable-file-preview-tabs"
                  checked={enableFilePreviewTabs}
                  onCheckedChange={setEnableFilePreviewTabs}
                />
              </SettingsRow>
              <SettingsRow
                variant="responsive"
                htmlFor="max-cached-workspaces"
                label="Cached workspaces"
                description="How many recently visited workspaces to keep alive in memory for instant switching. Higher values use more memory. Leave empty for the default (3)."
              >
                <Input
                  id="max-cached-workspaces"
                  type="number"
                  placeholder="3 (default)"
                  value={maxCachedWorkspaces}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setMaxCachedWorkspaces(e.target.value)
                  }
                  min={1}
                  max={20}
                  className="h-8 w-full text-sm sm:w-32"
                />
              </SettingsRow>
            </SettingsSection>

            {/* ── Browser ────────────────────────────────────── */}
            <SettingsSection title="Browser">
              <SettingsRow
                htmlFor="web-browser-cdp"
                label="Stream desktop tabs to web (experimental)"
                description="When enabled, the desktop opens a chromium debug port and lets web clients view + drive your Browser-pane tabs over CDP. Disable to save CPU/memory if you don't use the web UI for browsing."
              >
                <Switch
                  id="web-browser-cdp"
                  checked={webBrowserCdpEnabled}
                  onCheckedChange={setWebBrowserCdpEnabled}
                />
              </SettingsRow>
            </SettingsSection>

            {/* ── Labels ─────────────────────────────────────── */}
            <SettingsSection
              title="Labels"
              description="Tag projects to filter and group them in the sidebar."
            >
              {labels.length === 0 ? (
                <SettingsRow
                  label="No labels yet"
                  description="Add a label to start tagging projects."
                >
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
                          setLabels((prev) =>
                            prev.map((l) => (l.id === lbl.id ? { ...l, color } : l)),
                          )
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
                        className="shrink-0 text-foreground hover:text-foreground"
                        onClick={() => setLabels((prev) => prev.filter((l) => l.id !== lbl.id))}
                      >
                        <X className="size-3.5" />
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

            {/* ── Coding Agents ──────────────────────────────── */}
            <SettingsSection
              title="Coding Agents"
              description="Enable the agents you have installed."
            >
              {codingAgents.length > 0 && (
                <SettingsRow
                  variant="responsive"
                  label="Default agent"
                  description="Used for new workspaces. You can switch agents per workspace from the workspace chat header."
                >
                  <Select
                    value={defaultAgentId || codingAgents[0].id}
                    onValueChange={(v: string) => setDefaultAgentId(v)}
                  >
                    <SelectTrigger
                      className="h-8 w-full text-sm sm:w-48"
                      aria-label="Default coding agent"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {codingAgents.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          <AgentIcon type={a.type} className="size-3.5" />
                          {a.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </SettingsRow>
              )}
              <SettingsRow
                htmlFor="agents-context-meter"
                label="Context window meter"
                description="Show a context-usage donut next to the session-history button in the chat input. Token counting accuracy varies by agent — disable if numbers look wrong."
              >
                <Switch
                  id="agents-context-meter"
                  checked={contextMeterEnabled}
                  onCheckedChange={setContextMeterEnabled}
                />
              </SettingsRow>
              <SettingsRow
                htmlFor="claude-code-partial-messages"
                label="Stream Claude Code text (experimental)"
                description="Forward the SDK's partial-message stream events so the chat bubble types in token-by-token instead of arriving in per-block bursts. Claude Code only; subagent text and partial tool args are not yet streamed. Off by default."
              >
                <Switch
                  id="claude-code-partial-messages"
                  checked={claudeCodePartialMessages}
                  onCheckedChange={setClaudeCodePartialMessages}
                />
              </SettingsRow>
              <Accordion type="multiple" className="w-full">
                {KNOWN_AGENTS.map((known) => {
                  const agent = codingAgents.find((a) => a.type === known.type);
                  const enabled = !!agent;
                  const models = agentModels[known.type] ?? [];
                  return (
                    <AccordionItem
                      key={known.id}
                      value={known.id}
                      data-slot="settings-row"
                      className={cn("border-b-0 transition-opacity", !enabled && "opacity-60")}
                    >
                      <AccordionHeader className="flex items-center gap-3 px-4 py-3">
                        <span
                          className={cn(
                            "size-2 shrink-0 rounded-full",
                            enabled ? "bg-green-500" : "bg-muted-foreground/30",
                          )}
                        />
                        <AgentIcon type={known.type} className="size-4 shrink-0" />
                        <AccordionTriggerInline
                          aria-label={`Toggle advanced settings for ${known.label}`}
                          className="flex-1 rounded-md text-left text-sm font-medium"
                        >
                          {known.label}
                        </AccordionTriggerInline>
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
                        <AccordionTriggerInline
                          aria-label={`Toggle advanced settings for ${known.label}`}
                          className="-mr-1 inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground [&[data-state=open]>svg]:rotate-180"
                        >
                          <ChevronDown className="size-4 shrink-0 transition-transform duration-200" />
                        </AccordionTriggerInline>
                      </AccordionHeader>
                      <AccordionContent className="space-y-2.5 px-4 pb-3 pl-11">
                        <div className="space-y-1">
                          <Label className="text-xs text-muted-foreground">Command</Label>
                          <Input
                            placeholder={known.defaultCommand}
                            disabled={!enabled}
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
                              disabled={!enabled}
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
                                    <span className="flex w-full items-baseline justify-between gap-2">
                                      <span>{m.name}</span>
                                      {m.contextWindow !== undefined && (
                                        <span className="text-[10px] uppercase tabular-nums text-muted-foreground">
                                          {formatCtxWindow(m.contextWindow)} ctx
                                        </span>
                                      )}
                                    </span>
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        )}
                      </AccordionContent>
                    </AccordionItem>
                  );
                })}
              </Accordion>
            </SettingsSection>

            {/* ── Notifications ──────────────────────────────── */}
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
                  variant="responsive"
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
                    <SelectTrigger className="h-8 w-full text-xs sm:min-w-[10rem]">
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

            {/* ── Web Server ─────────────────────────────────── */}
            <SettingsSection title="Web Server">
              <SettingsRow
                variant="responsive"
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
                  className="h-8 w-full text-sm sm:w-32"
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

            {/* ── Terminal ───────────────────────────────────── */}
            <SettingsSection title="Terminal">
              <SettingsRow
                htmlFor="use-webgl-terminal-renderer"
                label="GPU-accelerated rendering"
                description="Render terminal panels with WebGL. Enables continuous box-drawing, powerline, and block-element glyphs, and iTerm-style row spacing. Falls back to the DOM renderer automatically if WebGL is unavailable. Reopen the terminal for changes to take effect."
              >
                <Switch
                  id="use-webgl-terminal-renderer"
                  checked={useWebGLTerminalRenderer}
                  onCheckedChange={setUseWebGLTerminalRenderer}
                />
              </SettingsRow>
            </SettingsSection>
          </div>
        </div>
        <DialogFooter className="border-t border-border px-6 py-3 sm:justify-end">
          <Button
            type="button"
            size="sm"
            onClick={handleSaveAndClose}
            disabled={!isDirty}
            aria-label="Save"
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
