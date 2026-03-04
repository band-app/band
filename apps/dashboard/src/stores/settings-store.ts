import { create } from "zustand";

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function invoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!isTauri()) {
    throw new Error("Not running inside Tauri");
  }
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke<T>(cmd, args);
}

export interface BandConfig {
  layout?: {
    orientation: "horizontal" | "vertical";
    groups: {
      size: number;
      browser?: { url: string; pinned?: boolean };
    }[];
  };
  terminals?: {
    name: string;
    command: string;
    split?: "horizontal" | "vertical";
    agentType?: "claude-code";
  }[];
}

export type CodingAgentType = "claude-code";

export interface CodingAgentConfig {
  type: CodingAgentType;
  command?: string;
}

export interface NotificationSettings {
  soundOnNeedsAttention?: boolean;
  sound?: string;
}

export interface Settings {
  worktreesDir: string | null;
  defaults?: BandConfig;
  codingAgent?: CodingAgentConfig;
  notifications?: NotificationSettings;
}

interface SettingsState {
  settings: Settings;
  loading: boolean;
  error: string | null;

  loadSettings: () => Promise<void>;
  updateSettings: (settings: Settings) => Promise<void>;
  clearError: () => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: { worktreesDir: null, defaults: undefined },
  loading: false,
  error: null,

  loadSettings: async () => {
    set({ loading: true, error: null });
    try {
      const settings = await invoke<Settings>("settings_get");
      set({ settings, loading: false });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  updateSettings: async (settings: Settings) => {
    set({ error: null });
    try {
      await invoke("settings_update", { settings });
      set({ settings });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  clearError: () => set({ error: null }),
}));
