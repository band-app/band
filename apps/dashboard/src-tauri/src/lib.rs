mod commands;
mod git;
mod state;

use commands::status::WatcherState;
use std::sync::{Arc, Mutex};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(WatcherState(Arc::new(Mutex::new(None))))
        .invoke_handler(tauri::generate_handler![
            commands::project::project_init,
            commands::project::project_list,
            commands::project::project_remove,
            commands::workspace::workspace_create,
            commands::workspace::workspace_list,
            commands::workspace::workspace_remove,
            commands::workspace::workspace_open,
            commands::status::status_watch_start,
            commands::status::status_watch_stop,
            commands::ide::workspace_focus,
            commands::ide::pick_folder,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
