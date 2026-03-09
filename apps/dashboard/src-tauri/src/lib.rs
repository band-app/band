mod commands;
mod git;
mod state;

use commands::webserver::{
    self as webserver, ManagedProcess, TunnelInner, TunnelState, WebServerState,
};
use std::sync::{Arc, Mutex};
use tauri::Manager;

const DASHBOARD_WIDTH: u32 = 400;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(WebServerState(ManagedProcess::new()))
        .manage(TunnelState(Arc::new(Mutex::new(TunnelInner {
            process: ManagedProcess::new(),
            url: None,
        }))))
        .invoke_handler(tauri::generate_handler![
            commands::ide::workspace_focus,
            commands::ide::get_active_workspace,
            commands::ide::detect_active_workspace,
            commands::ide::pick_folder,
            commands::ide::reveal_in_finder,
            commands::webserver::webserver_start,
            commands::webserver::webserver_stop,
            commands::webserver::service_health_check,
            commands::webserver::prereq_check,
            commands::webserver::node_install,
            commands::webserver::tunnel_install,
            commands::webserver::tunnel_start,
            commands::webserver::tunnel_stop,
            commands::webserver::webserver_get_token,
            commands::webserver::tunnel_auth_check,
        ])
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();

            // Auto-start the web server and navigate with auth token
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

            // Kill web server and tunnel on app exit
            let web_proc = app.state::<WebServerState>().inner().0.clone();
            let tunnel_arc = app.state::<TunnelState>().inner().0.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { .. } = event {
                    // Close the tunnel on the server via CLI
                    if let Ok(tguard) = tunnel_arc.lock() {
                        if let Some(ref url) = tguard.url {
                            if let Some(name) = webserver::extract_subdomain(url) {
                                if let Ok(bin) = webserver::which_binary("instatunnel") {
                                    let _ = std::process::Command::new(&bin)
                                        .args(["--kill", name])
                                        .env("PATH", webserver::shell_path())
                                        .output();
                                }
                            }
                        }
                    }
                    web_proc.kill();
                }
            });

            // Raise the active workspace's VS Code window when dashboard gains focus
            let window_ref = app.get_webview_window("main").unwrap();
            window_ref.on_window_event(move |event| {
                if let tauri::WindowEvent::Focused(true) = event {
                    // Read active workspace from marker file
                    let active_file = state::status_dir().join("active.json");
                    if let Ok(data) = std::fs::read_to_string(&active_file) {
                        #[derive(serde::Deserialize)]
                        struct ActiveMarker {
                            #[serde(rename = "workspaceId")]
                            workspace_id: String,
                        }
                        if let Ok(marker) = serde_json::from_str::<ActiveMarker>(&data) {
                            if let Ok(app_state) = state::load_state() {
                                for proj in &app_state.projects {
                                    for wt in &proj.worktrees {
                                        let id = format!("{}-{}", proj.name, wt.branch);
                                        if id == marker.workspace_id {
                                            commands::ide::raise_vscode_window(&wt.branch);
                                            return;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
