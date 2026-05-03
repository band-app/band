//! Non-macOS stubs for the keep-list shell bridges in `macos_shell.rs`.
//! All commands return platform-not-supported errors so the IPC surface
//! is consistent across platforms.

#[tauri::command]
pub fn pick_folder() -> Result<Option<String>, String> {
    Err("Not supported on this platform".to_string())
}

#[tauri::command]
pub fn reveal_in_finder(_path: String) -> Result<(), String> {
    Err("Not supported on this platform".to_string())
}

#[tauri::command]
pub fn check_app_exists(_app_name: String) -> bool {
    false
}

#[tauri::command]
pub fn open_with_app(_path: String, _app_name: String) -> Result<(), String> {
    Err("Not supported on this platform".to_string())
}

#[tauri::command]
pub fn install_cli(_binary_path: String, _symlink_path: String) -> Result<(), String> {
    Err("Not supported on this platform".to_string())
}
