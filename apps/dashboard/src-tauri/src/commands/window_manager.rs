use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use crate::state;

use super::apps::{AppHandler, ScreenRect};
use super::ax_windows;

// --- Window Registry ---

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct WindowEntry {
    pub pid: i32,
    pub cg_window_id: u32,
}

type RegistryMap = HashMap<String, WindowEntry>;

pub struct WindowManager {
    registry: Mutex<RegistryMap>,
}

static INSTANCE: LazyLock<WindowManager> = LazyLock::new(|| WindowManager {
    registry: Mutex::new(load_from_disk()),
});

impl WindowManager {
    pub fn global() -> &'static WindowManager {
        &INSTANCE
    }

    // --- Registry operations ---

    pub fn get(&self, app_type: &str, folder_name: &str) -> Option<WindowEntry> {
        self.registry
            .lock()
            .unwrap()
            .get(&registry_key(app_type, folder_name))
            .cloned()
    }

    pub fn register(&self, app_type: &str, folder_name: &str, pid: i32, cg_id: u32) {
        let mut map = self.registry.lock().unwrap();
        map.insert(
            registry_key(app_type, folder_name),
            WindowEntry {
                pid,
                cg_window_id: cg_id,
            },
        );
        save_to_disk(&map);
    }

    pub fn unregister(&self, app_type: &str, folder_name: &str) {
        let mut map = self.registry.lock().unwrap();
        map.remove(&registry_key(app_type, folder_name));
        save_to_disk(&map);
    }

    pub fn is_valid(&self, app_type: &str, folder_name: &str, bundle_id: &str) -> bool {
        let Some(entry) = self.get(app_type, folder_name) else {
            return false;
        };
        let windows = ax_windows::list_windows_for_bundle(bundle_id);
        windows.iter().any(|w| w.cg_window_id == entry.cg_window_id)
    }

    pub fn find_by_cg_id(&self, cg_id: u32) -> Option<(String, String)> {
        let map = self.registry.lock().unwrap();
        for (key, entry) in map.iter() {
            if entry.cg_window_id == cg_id {
                if let Some((app_type, folder_name)) = key.split_once(':') {
                    return Some((app_type.to_string(), folder_name.to_string()));
                }
            }
        }
        None
    }

    // --- Lifecycle operations ---

    pub fn open_or_focus(
        &self,
        handler: &dyn AppHandler,
        worktree_path: &str,
        folder_name: &str,
        config: &serde_json::Value,
    ) -> Result<bool, String> {
        let app_type = handler.app_type();
        let bundle_id = handler.bundle_id();

        // 1. Check registry for a known window
        if let Some(entry) = self.get(app_type, folder_name) {
            if self.is_valid(app_type, folder_name, bundle_id) {
                ax_windows::focus_window(entry.pid, entry.cg_window_id);
                return Ok(false);
            }
            self.unregister(app_type, folder_name);
        }

        // 2. Try to find an existing window by title
        if let Some(hint) = handler.window_title_hint(folder_name) {
            if let Some(win) = ax_windows::find_window_by_title(bundle_id, &hint) {
                self.register(app_type, folder_name, win.pid, win.cg_window_id);
                ax_windows::focus_window(win.pid, win.cg_window_id);
                return Ok(false);
            }
        }

        // 3. Snapshot + start watching + launch + wait + register
        let existing = ax_windows::snapshot_window_ids(bundle_id);
        let watcher_hint = handler.watcher_title_hint(folder_name);
        let watcher = ax_windows::start_watching(bundle_id, &existing, watcher_hint.as_deref());

        handler.launch(worktree_path, folder_name, config)?;

        if let Some(win) = watcher.wait(5000) {
            self.register(app_type, folder_name, win.pid, win.cg_window_id);
        }

        Ok(true)
    }

    pub fn position_window(
        &self,
        app_type: &str,
        display_name: &str,
        folder_name: &str,
        rect: &ScreenRect,
    ) -> Result<(), String> {
        let entry = self
            .get(app_type, folder_name)
            .ok_or_else(|| format!("No {display_name} window registered"))?;
        if !ax_windows::position_window(
            entry.pid,
            entry.cg_window_id,
            rect.x,
            rect.y,
            rect.width,
            rect.height,
        ) {
            self.unregister(app_type, folder_name);
            return Err(format!(
                "Failed to position {display_name} window (stale reference)"
            ));
        }
        Ok(())
    }

    pub fn raise_window(&self, app_type: &str, folder_name: &str) {
        if let Some(entry) = self.get(app_type, folder_name) {
            if !ax_windows::raise_window(entry.pid, entry.cg_window_id) {
                self.unregister(app_type, folder_name);
            }
        }
    }
}

// --- Persistence helpers ---

fn registry_path() -> std::path::PathBuf {
    state::band_home()
        .join("status")
        .join("window-registry.json")
}

fn load_from_disk() -> RegistryMap {
    let path = registry_path();
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|data| serde_json::from_str(&data).ok())
        .unwrap_or_default()
}

fn save_to_disk(map: &RegistryMap) {
    let path = registry_path();
    if let Ok(data) = serde_json::to_string(map) {
        let _ = std::fs::write(path, data);
    }
}

fn registry_key(app_type: &str, folder_name: &str) -> String {
    format!("{app_type}:{folder_name}")
}
