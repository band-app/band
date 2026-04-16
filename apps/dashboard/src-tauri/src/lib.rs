#[cfg(target_os = "macos")]
mod api;
mod commands;
mod git;
mod state;

use std::fs::OpenOptions;
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use commands::browser::BrowserState;
use commands::webserver::{self as webserver, ManagedProcess, WebServerState};
use state::{ActiveWorkspaceState, ProjectCache};
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::Manager;

const MAX_LOG_SIZE: u64 = 5 * 1024 * 1024; // 5 MB

fn log_to_file(msg: &str) {
    let Some(home) = dirs::home_dir() else {
        return;
    };
    let log_path = home.join(".band").join("dashboard.log");
    if let Ok(meta) = std::fs::metadata(&log_path) {
        if meta.len() > MAX_LOG_SIZE {
            let _ = std::fs::rename(&log_path, log_path.with_extension("log.old"));
        }
    }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&log_path) {
        let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        let _ = writeln!(f, "[{now}] {msg}");
    }
}

macro_rules! dash_log {
    ($($arg:tt)*) => {{
        let msg = format!($($arg)*);
        eprintln!("{}", msg);
        crate::log_to_file(&msg);
    }};
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Install panic hook that writes to dashboard.log
    std::panic::set_hook(Box::new(|info| {
        let backtrace = std::backtrace::Backtrace::force_capture();
        let msg = format!("PANIC: {info}\n{backtrace}");
        eprintln!("{msg}");
        log_to_file(&msg);
    }));

    log_to_file("dashboard starting");

    let cleaned_up = Arc::new(AtomicBool::new(false));
    let cleaned_up_setup = cleaned_up.clone();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(WebServerState(ManagedProcess::new()))
        .manage(ActiveWorkspaceState::new())
        .manage(ProjectCache::new())
        .manage(BrowserState::new())
        .invoke_handler(tauri::generate_handler![
            commands::ide::workspace_focus,
            commands::ide::workspace_close,
            commands::ide::get_active_workspace,
            commands::ide::detect_active_workspace,
            commands::ide::pick_folder,
            commands::ide::reveal_in_finder,
            commands::webserver::webserver_start,
            commands::webserver::webserver_stop,
            commands::window::open_tasks_window,
            commands::window::open_cronjobs_window,
            commands::window::open_settings_window,
            commands::window::get_app_title,
            commands::window::set_app_mode,
            commands::browser::browser_create,
            commands::browser::browser_navigate,
            commands::browser::browser_go_back,
            commands::browser::browser_go_forward,
            commands::browser::browser_eval,
            commands::browser::browser_reload,
            commands::browser::browser_set_bounds,
            commands::browser::browser_hide,
            commands::browser::browser_show,
            commands::browser::browser_destroy,
        ])
        .setup(move |app| {
            let window = app.get_webview_window("main").unwrap();

            // Build an Edit menu so macOS routes Cmd+C/V/X/A to the webview.
            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .item(&PredefinedMenuItem::undo(app, None)?)
                .item(&PredefinedMenuItem::redo(app, None)?)
                .separator()
                .item(&PredefinedMenuItem::cut(app, None)?)
                .item(&PredefinedMenuItem::copy(app, None)?)
                .item(&PredefinedMenuItem::paste(app, None)?)
                .item(&PredefinedMenuItem::select_all(app, None)?)
                .build()?;

            // Build a View menu with Cmd+R to reload the webview.
            let reload_item = MenuItemBuilder::with_id("reload", "Reload")
                .accelerator("CmdOrCtrl+R")
                .build(app)?;
            let settings_item = MenuItemBuilder::with_id("settings", "Settings...")
                .accelerator("CmdOrCtrl+Comma")
                .build(app)?;
            let view_menu = SubmenuBuilder::new(app, "View")
                .item(&reload_item)
                .separator()
                .item(&settings_item)
                .build()?;

            let menu = MenuBuilder::new(app)
                .item(&edit_menu)
                .item(&view_menu)
                .build()?;
            app.set_menu(menu)?;

            // Handle menu events on all windows.
            let app_handle = app.handle().clone();
            app.on_menu_event(move |_app, event| {
                if event.id() == "reload" {
                    // Reload whichever window is focused, or fall back to main.
                    let target = app_handle
                        .webview_windows()
                        .values()
                        .find(|w| w.is_focused().unwrap_or(false))
                        .cloned()
                        .or_else(|| app_handle.get_webview_window("main"));

                    if let Some(win) = target {
                        if let Ok(url) = win.url() {
                            let _ = win.navigate(url);
                        }
                    }
                } else if event.id() == "settings" {
                    let handle = app_handle.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = commands::window::open_settings_window(handle).await;
                    });
                }
            });

            let cleaned_up = cleaned_up_setup;

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
                        dash_log!("Failed to start web server: {e}");
                    }
                }
            }

            // Set window background to black so the area behind macOS traffic
            // light buttons matches the dark UI.
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

            // Read app mode from settings (defaults to "side-panel")
            let app_mode = state::load_settings()
                .ok()
                .and_then(|s| s.app_mode)
                .unwrap_or_else(|| "side-panel".to_string());

            // Position and size the window based on app mode
            if let Ok(Some(monitor)) = window.current_monitor() {
                let screen_size = monitor.size();
                let scale_factor = monitor.scale_factor();
                let screen_width = f64::from(screen_size.width) / scale_factor;
                let screen_height = f64::from(screen_size.height) / scale_factor;

                let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(
                    0.0, 0.0,
                )));

                if app_mode == "full-editor" {
                    // Full editor: use entire screen
                    let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize::new(
                        screen_width,
                        screen_height,
                    )));
                } else {
                    // Side panel: narrow width at left edge, full height
                    let current_width = window
                        .outer_size()
                        .map_or(400, |s| (f64::from(s.width) / scale_factor) as u32);

                    let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize::new(
                        f64::from(current_width),
                        screen_height,
                    )));
                }
            }

            // Poll the frontmost VS Code window to track active workspace.
            // Only needed in side-panel mode where we manage external IDE windows.
            if app_mode != "full-editor" {
                commands::ide::start_focus_polling(app.handle().clone());
            }

            // Kill web server and close secondary windows on app exit.
            // Uses a `cleaned_up` flag to avoid double cleanup when both
            // CloseRequested (close button) and ExitRequested (Cmd+Q) fire.
            let web_proc = app.state::<WebServerState>().inner().0.clone();
            let app_handle_for_close = app.handle().clone();
            let cleaned_up_close = cleaned_up;
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { .. } = event {
                    if cleaned_up_close
                        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                        .is_err()
                    {
                        return;
                    }

                    for (label, wv) in app_handle_for_close.webviews() {
                        if label.starts_with("browser-") {
                            let _ = wv.close();
                        }
                    }
                    if let Some(tasks_win) = app_handle_for_close.get_webview_window("tasks") {
                        let _ = tasks_win.destroy();
                    }
                    if let Some(cron_win) = app_handle_for_close.get_webview_window("cronjobs") {
                        let _ = cron_win.destroy();
                    }
                    if let Some(settings_win) = app_handle_for_close.get_webview_window("settings")
                    {
                        let _ = settings_win.destroy();
                    }
                    web_proc.kill();
                    // Only kill by port in release builds where we spawned the
                    // server ourselves. In dev mode the orchestrating script
                    // (scripts/dev-dashboard.mjs) handles cleanup — blindly
                    // killing port 3456 could hit another Band instance.
                    if cfg!(not(debug_assertions)) {
                        webserver::kill_port_sync(webserver::get_configured_port());
                    }
                }
            });

            // Raise the active workspace's app windows when dashboard gains focus.
            // Only in side-panel mode where external IDE windows are managed.
            if app_mode != "full-editor" {
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
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application");

    app.run(move |app_handle, event| {
        if let tauri::RunEvent::ExitRequested { .. } = event {
            if cleaned_up
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_err()
            {
                return;
            }

            let web_proc = &app_handle.state::<WebServerState>().0;
            for (label, wv) in app_handle.webviews() {
                if label.starts_with("browser-") {
                    let _ = wv.close();
                }
            }
            if let Some(tasks_win) = app_handle.get_webview_window("tasks") {
                let _ = tasks_win.destroy();
            }
            if let Some(cron_win) = app_handle.get_webview_window("cronjobs") {
                let _ = cron_win.destroy();
            }
            if let Some(settings_win) = app_handle.get_webview_window("settings") {
                let _ = settings_win.destroy();
            }
            web_proc.kill();
            if cfg!(not(debug_assertions)) {
                webserver::kill_port_sync(webserver::get_configured_port());
            }
        }
    });
}
