mod commands;
mod git;
mod state;

use commands::ide::LastWorkspace;
use commands::status::WatcherState;
use std::sync::{Arc, Mutex};
use tauri::Manager;

const DASHBOARD_WIDTH: u32 = 400;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let last_workspace = LastWorkspace(Arc::new(Mutex::new(None)));

    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(WatcherState(Arc::new(Mutex::new(None))))
        .manage(last_workspace)
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
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();

            // Position dashboard at left edge, full screen height
            if let Ok(monitor) = window.current_monitor() {
                if let Some(monitor) = monitor {
                    let screen_size = monitor.size();
                    let scale_factor = monitor.scale_factor();
                    let screen_height = (screen_size.height as f64 / scale_factor) as u32;

                    let _ = window.set_position(tauri::Position::Logical(
                        tauri::LogicalPosition::new(0.0, 0.0),
                    ));
                    let _ = window.set_size(tauri::Size::Logical(
                        tauri::LogicalSize::new(DASHBOARD_WIDTH as f64, screen_height as f64),
                    ));
                }
            }

            // Re-align the last workspace's VS Code window when dashboard gains focus
            let last_ws = app.state::<LastWorkspace>().0.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::Focused(true) = event {
                    if let Ok(guard) = last_ws.lock() {
                        if let Some(branch) = guard.as_ref() {
                            commands::ide::align_vscode_window(branch);
                        }
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
