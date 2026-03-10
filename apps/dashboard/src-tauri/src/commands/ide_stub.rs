//! Stub implementations of the IDE commands for non-macOS platforms.
//! The real implementation lives in `ide.rs` and uses macOS-specific APIs.

use crate::state::{ActiveWorkspaceState, ProjectCache};

pub fn start_focus_polling(_app_handle: tauri::AppHandle) {}

pub fn raise_vscode_window(_branch: &str) {}

#[allow(dead_code)]
pub fn align_vscode_window(_branch: &str) {}

#[tauri::command]
pub fn workspace_focus(
    _workspace_id: String,
    _active_state: tauri::State<'_, ActiveWorkspaceState>,
    _project_cache: tauri::State<'_, ProjectCache>,
) -> Result<(), String> {
    Err("Not supported on this platform".to_string())
}

#[tauri::command]
pub fn get_active_workspace(
    _active_state: tauri::State<'_, ActiveWorkspaceState>,
) -> Result<Option<String>, String> {
    Ok(None)
}

#[tauri::command]
pub fn detect_active_workspace(
    _active_state: tauri::State<'_, ActiveWorkspaceState>,
    _project_cache: tauri::State<'_, ProjectCache>,
) -> Result<Option<String>, String> {
    Ok(None)
}

#[tauri::command]
pub fn pick_folder() -> Result<Option<String>, String> {
    Err("Not supported on this platform".to_string())
}

#[tauri::command]
pub fn reveal_in_finder(_path: String) -> Result<(), String> {
    Err("Not supported on this platform".to_string())
}
