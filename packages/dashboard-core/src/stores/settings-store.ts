import { create, type StoreApi, type UseBoundStore } from "zustand";
import type { DashboardAdapter } from "../adapter";
import type { Settings } from "../types";

export interface SettingsState {
  settings: Settings;
  loading: boolean;
  error: string | null;

  loadSettings: () => Promise<void>;
  updateSettings: (settings: Settings) => Promise<void>;
  clearError: () => void;
}

export type SettingsStore = UseBoundStore<StoreApi<SettingsState>>;

export function createSettingsStore(adapter: DashboardAdapter): SettingsStore {
  return create<SettingsState>((set) => ({
    settings: { worktreesDir: null, defaults: undefined },
    loading: false,
    error: null,

    loadSettings: async () => {
      set({ loading: true, error: null });
      try {
        const settings = await adapter.getSettings();
        set({ settings, loading: false });
      } catch (e) {
        set({ error: String(e), loading: false });
      }
    },

    updateSettings: async (settings: Settings) => {
      set({ error: null });
      try {
        await adapter.updateSettings(settings);
        set({ settings });
      } catch (e) {
        set({ error: String(e) });
      }
    },

    clearError: () => set({ error: null }),
  }));
}
