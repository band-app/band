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
import { ChevronDown, FolderOpen, Plus, RefreshCcw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
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

// Delimiter for the joined-string proxy used as a memoisation key over
// the configured agent ids (see the `agentIdsKey` useMemo below). U+001F
// INFORMATION SEPARATOR ONE is a C0 control character that no user can
// type into a settings.json agent id through the Settings form's `id`
// Input, so the join/split round-trip is lossless. Hoisted to module
// scope so the constant isn't re-created on every component render.
// Written as the explicit `\u001f` escape (not a literal control byte)
// so the value is unambiguous in source — a literal renders as an
// invisible character in editors and diffs.
const ID_DELIMITER = "\u001f";

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

/**
 * Human-friendly relative timestamp ("just now", "3m ago", "2h ago",
 * "yesterday", "Jan 5, 2026"). Doesn't set any timers — re-rendering on a
 * stale value is the caller's responsibility (in practice the parent
 * component re-renders on every settings/model state change). The
 * absolute-date fallback uses `toLocaleDateString()` so the format
 * follows the user's browser locale.
 */
function formatLastRefreshed(epochMs: number): string {
  const diff = Date.now() - epochMs;
  if (diff < 60_000) return "just now";
  if (diff < 60 * 60_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 24 * 60 * 60_000) return `${Math.round(diff / (60 * 60_000))}h ago`;
  if (diff < 48 * 60 * 60_000) return "yesterday";
  try {
    return new Date(epochMs).toLocaleDateString();
  } catch {
    return new Date(epochMs).toISOString();
  }
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
  // String-backed so the input can hold an empty/in-flight value; parsed
  // on Save and rejected if outside [1, 3650]. Empty = "use default".
  const [usageRetentionDays, setUsageRetentionDays] = useState(
    settings.usageRetentionDays?.toString() ?? "",
  );
  // Default true — see Settings.usagePollingEnabled JSDoc.
  const [usagePollingEnabled, setUsagePollingEnabled] = useState(
    settings.usagePollingEnabled ?? true,
  );
  // Per-agent model cache surfaced from `~/.band/settings.json` via
  // `models.list`. Keyed by agent id (not agent type) so two registered
  // agents of the same type stay independent. Each entry tracks the
  // model array + last-refresh timestamp + an `isRefreshing` flag so the
  // "Refresh models" button can show a spinner without bouncing the
  // whole list out of state.
  const [agentModels, setAgentModels] = useState<
    Record<
      string,
      {
        models: { id: string; name: string; description?: string; contextWindow?: number }[];
        updatedAt?: number;
        isRefreshing?: boolean;
        error?: string;
      }
    >
  >({});
  // Experimental flags live in localStorage (per-device) rather than the
  // settings store, so they don't participate in `isDirty` / Save.
  const [contextMeterEnabled, setContextMeterEnabled] = useExperimentalContextMeter();

  const adapter = useAdapter();

  // Merge a partial patch into the per-agent state entry, keyed by
  // `agentId`. Each call site only spells the fields it actually changes;
  // the helper carries forward the rest. Avoids the
  // four-near-identical-spreads pattern the prior implementation had.
  //
  // Wrapped in `useCallback` with an empty dep list because the body only
  // uses `setAgentModels` (a stable setter from `useState`); the resulting
  // function reference stays stable across renders so effects/callbacks
  // depending on it don't re-fire spuriously.
  const mergeAgentModels = useCallback(
    (
      agentId: string,
      patch: Partial<{
        models: { id: string; name: string; description?: string; contextWindow?: number }[];
        updatedAt: number | undefined;
        isRefreshing: boolean;
        error: string | undefined;
      }>,
    ) =>
      setAgentModels((prev) => ({
        ...prev,
        [agentId]: {
          models: patch.models ?? prev[agentId]?.models ?? [],
          updatedAt: "updatedAt" in patch ? patch.updatedAt : prev[agentId]?.updatedAt,
          isRefreshing: patch.isRefreshing ?? prev[agentId]?.isRefreshing ?? false,
          error: "error" in patch ? patch.error : prev[agentId]?.error,
        },
      })),
    [],
  );

  // Memoise the join so callers downstream of `agentIdsKey` only
  // re-evaluate when the set of agent ids actually changes — not on
  // every keystroke into a per-agent Command input that re-renders
  // the component with a fresh `codingAgents` array reference.
  const agentIdsKey = useMemo(
    () => codingAgents.map((a) => a.id).join(ID_DELIMITER),
    [codingAgents],
  );
  const agentIds = useMemo(
    () => (agentIdsKey === "" ? [] : agentIdsKey.split(ID_DELIMITER)),
    [agentIdsKey],
  );
  useEffect(() => {
    // Drop entries for agents the user has just toggled off — otherwise
    // a stale `error` / `updatedAt` would reappear if they toggle the
    // same agent back on before the next refetch lands. Map state on
    // each effect tick is the cheapest way to keep the lifecycle tied
    // to the membership of `agentIds`.
    setAgentModels((prev) => {
      const allowed = new Set(agentIds);
      const next: typeof prev = {};
      let changed = false;
      for (const [id, entry] of Object.entries(prev)) {
        if (allowed.has(id)) {
          next[id] = entry;
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    if (!adapter.listModels) return;
    for (const id of agentIds) {
      adapter
        .listModels(id)
        .then((data) => {
          mergeAgentModels(id, { models: data.models, updatedAt: data.updatedAt });
        })
        .catch(() => {
          // Models unavailable — leave previous state untouched so a
          // transient network blip doesn't blank the picker.
        });
    }
  }, [agentIds, adapter, mergeAgentModels]);

  // `useCallback` for parity with `mergeAgentModels` and so the handler
  // reference stays stable across renders (it's passed to each agent's
  // Refresh button onClick). Deps: `adapter` (the refresh transport) and
  // the memoised `mergeAgentModels`.
  const handleRefreshModels = useCallback(
    async (agentId: string) => {
      if (!adapter.refreshModels) return;
      mergeAgentModels(agentId, { isRefreshing: true, error: undefined });
      try {
        const data = await adapter.refreshModels(agentId);
        // Strict find — a missing result is a server contract bug and
        // should be surfaced as an error rather than silently applying
        // someone else's model list. The previous `?? data.results[0]`
        // fallback could splice a different agent's models into this
        // agent's UI state.
        const result = data.results.find((r) => r.agentId === agentId);
        if (result) {
          mergeAgentModels(agentId, {
            models: result.models,
            updatedAt: result.updatedAt,
            isRefreshing: false,
            error: result.error,
          });
        } else {
          mergeAgentModels(agentId, {
            isRefreshing: false,
            error: `server returned no refresh result for ${agentId}`,
          });
        }
      } catch (err) {
        mergeAgentModels(agentId, {
          isRefreshing: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [adapter, mergeAgentModels],
  );

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
    if (usageRetentionDays !== (settings.usageRetentionDays?.toString() ?? "")) return true;
    if (usagePollingEnabled !== (settings.usagePollingEnabled ?? true)) return true;
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
    usageRetentionDays,
    usagePollingEnabled,
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
    setUsageRetentionDays(settings.usageRetentionDays?.toString() ?? "");
    setUsagePollingEnabled(settings.usagePollingEnabled ?? true);
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
    settings.usageRetentionDays,
    settings.usagePollingEnabled,
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
    let parsedUsageRetentionDays: number | undefined;
    if (usageRetentionDays.trim()) {
      const n = parseInt(usageRetentionDays.trim(), 10);
      if (Number.isNaN(n) || n < 1 || n > 3650) return;
      parsedUsageRetentionDays = n;
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
      usageRetentionDays: parsedUsageRetentionDays,
      usagePollingEnabled,
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
                  const modelState = agent ? agentModels[agent.id] : undefined;
                  const models = modelState?.models ?? [];
                  const isRefreshing = modelState?.isRefreshing ?? false;
                  const updatedAt = modelState?.updatedAt;
                  const refreshError = modelState?.error;
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
                        {agent && (
                          <div className="space-y-1">
                            <div className="flex items-center justify-between gap-2">
                              <Label className="text-xs text-muted-foreground">
                                Models {models.length > 0 && `(${models.length})`}
                              </Label>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-6 gap-1 px-2 text-xs"
                                disabled={!enabled || isRefreshing}
                                onClick={() => handleRefreshModels(agent.id)}
                                aria-label={`Refresh models for ${known.label}`}
                                data-testid={`settings-page__refresh-models-${agent.type}`}
                              >
                                <RefreshCcw
                                  className={cn("size-3", isRefreshing && "animate-spin")}
                                />
                                {isRefreshing ? "Refreshing…" : "Refresh"}
                              </Button>
                            </div>
                            {models.length > 0 ? (
                              <ul
                                className="rounded-md border border-border bg-muted/30 px-2 py-1 text-xs"
                                data-testid={`settings-page__model-list-${agent.type}`}
                              >
                                {models.map((m) => (
                                  // Two-line layout, mirroring the chat-pane
                                  // model dropdown (`ModelLine` in ChatView):
                                  // top row is name + optional context-window
                                  // pill, second row is the description.
                                  // Keeps Settings and the chat picker
                                  // visually consistent.
                                  <li key={m.id} className="flex flex-col items-start gap-0.5 py-1">
                                    <span className="flex w-full items-baseline justify-between gap-2">
                                      <span className="font-medium">{m.name}</span>
                                      {m.contextWindow !== undefined && (
                                        <span className="text-[10px] uppercase tabular-nums text-muted-foreground">
                                          {formatCtxWindow(m.contextWindow)} ctx
                                        </span>
                                      )}
                                    </span>
                                    {m.description && (
                                      <span className="text-[11px] text-muted-foreground">
                                        {m.description}
                                      </span>
                                    )}
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <p className="text-[11px] text-muted-foreground">
                                No models cached yet — click Refresh.
                              </p>
                            )}
                            {refreshError && (
                              <p className="text-[11px] text-destructive">
                                Refresh failed: {refreshError}
                              </p>
                            )}
                            {updatedAt !== undefined && updatedAt > 0 && (
                              <p className="text-[10px] text-muted-foreground">
                                Last refreshed {formatLastRefreshed(updatedAt)}
                              </p>
                            )}
                          </div>
                        )}
                        {agent && models.length > 0 && (
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

            {/* ── Usage report ───────────────────────────────── */}
            <SettingsSection
              title="Usage report"
              description="Configure how the Usage dialog collects and retains per-session token and cost rows."
            >
              <SettingsRow
                htmlFor="usage-polling-enabled"
                label="Poll for usage data"
                description="Periodically scan your coding agents' session files to populate the Usage dialog. Disable to skip the background scan if you don't use the Usage dialog or want to claw back CPU."
              >
                <Switch
                  id="usage-polling-enabled"
                  checked={usagePollingEnabled}
                  onCheckedChange={setUsagePollingEnabled}
                />
              </SettingsRow>
              <SettingsRow
                variant="responsive"
                htmlFor="usage-retention-days"
                label="Retention period (days)"
                description="How long to keep usage history. Older rows are pruned daily. Leave empty for the default (365 days). Max 3650."
              >
                <Input
                  id="usage-retention-days"
                  type="number"
                  placeholder="365 (default)"
                  value={usageRetentionDays}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setUsageRetentionDays(e.target.value)
                  }
                  min={1}
                  max={3650}
                  className="h-8 w-full text-sm sm:w-32"
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
