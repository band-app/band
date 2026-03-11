#[cfg(target_os = "macos")]
mod api;
mod commands;
mod git;
mod state;

use commands::webserver::{self as webserver, ManagedProcess, WebServerState};
use state::{ActiveWorkspaceState, ProjectCache};
use tauri::Manager;

const DASHBOARD_WIDTH: u32 = 400;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(WebServerState(ManagedProcess::new()))
        .manage(ActiveWorkspaceState::new())
        .manage(ProjectCache::new())
        .invoke_handler(tauri::generate_handler![
            commands::ide::workspace_focus,
            commands::ide::workspace_close,
            commands::ide::get_active_workspace,
            commands::ide::detect_active_workspace,
            commands::ide::pick_folder,
            commands::ide::reveal_in_finder,
            commands::webserver::webserver_start,
            commands::webserver::webserver_stop,
        ])
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();

            // Auto-start the web server in release builds.
            // In dev mode, `beforeDevCommand` already starts the Vite dev server.
            if cfg!(not(debug_assertions)) {
                match webserver::ensure_webserver_running() {
                    Ok((port, token)) => {
                        let url_str = format!("http://localhost:{port}?token={token}");
                        if let Ok(url) = url::Url::parse(&url_str) {
                            let _ = window.navigate(url);
                        }
                    }
                    Err(e) => {
                        eprintln!("Failed to start web server: {e}");
                    }
                }
            }

            // Set window title with git branch if available
            let title = match git::get_current_branch() {
                Some(branch) => format!("Band - {branch}"),
                None => "Band".to_string(),
            };
            let _ = window.set_title(&title);

            // Set window background to black so the transparent title bar appears black
            #[cfg(target_os = "macos")]
            #[allow(deprecated)] // cocoa crate deprecated in favor of objc2-app-kit
            {
                use cocoa::appkit::NSColor;
                use cocoa::appkit::NSWindow;
                use cocoa::base::{id, nil};
                let ns_window = window.ns_window().unwrap() as id;
                unsafe {
                    let color =
                        NSColor::colorWithSRGBRed_green_blue_alpha_(nil, 0.0, 0.0, 0.0, 1.0);
                    ns_window.setBackgroundColor_(color);
                }
            }

            // Position dashboard at left edge, full screen height
            if let Ok(Some(monitor)) = window.current_monitor() {
                let screen_size = monitor.size();
                let scale_factor = monitor.scale_factor();
                let screen_height = (f64::from(screen_size.height) / scale_factor) as u32;

                let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(
                    0.0, 0.0,
                )));
                let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize::new(
                    f64::from(DASHBOARD_WIDTH),
                    f64::from(screen_height),
                )));
            }

            // Poll the frontmost VS Code window to track active workspace
            // (handles projects without the Band VS Code extension)
            commands::ide::start_focus_polling(app.handle().clone());

            // Kill web server on app exit
            let web_proc = app.state::<WebServerState>().inner().0.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { .. } = event {
                    web_proc.kill();
                    // Kill any server on the port (handles the detached process
                    // spawned by ensure_webserver_running in release builds)
                    webserver::kill_port_sync(webserver::get_configured_port());
                }
            });

            // Raise the active workspace's app windows when dashboard gains focus
            let active_ws_state: std::sync::Arc<std::sync::Mutex<Option<String>>> =
                app.state::<ActiveWorkspaceState>().inner().0.clone();
            let raise_cache = app.state::<ProjectCache>().inner().clone();
            let window_ref = app.get_webview_window("main").unwrap();
            window_ref.on_window_event(move |event| {
                if let tauri::WindowEvent::Focused(true) = event {
                    let workspace_id: Option<String> =
                        active_ws_state.lock().ok().and_then(|guard| guard.clone());

                    if let Some(ws_id) = workspace_id {
                        commands::ide::raise_workspace_windows(&ws_id, &raise_cache);
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
