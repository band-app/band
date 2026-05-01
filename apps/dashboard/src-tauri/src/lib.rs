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
use commands::updater::UPDATER_ENABLED;
use commands::webserver::{self as webserver, ManagedProcess, WebServerState};
use state::{ActiveWorkspaceState, FocusManagementState, ProjectCache};
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::Manager;

const MAX_LOG_SIZE: u64 = 5 * 1024 * 1024; // 5 MB

pub(crate) fn log_to_file(msg: &str) {
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

#[macro_export]
macro_rules! dash_log {
    ($($arg:tt)*) => {{
        let msg = format!($($arg)*);
        eprintln!("{}", msg);
        $crate::log_to_file(&msg);
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

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init());

    if UPDATER_ENABLED {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    let app = builder
        .manage(WebServerState(ManagedProcess::new()))
        .manage(ActiveWorkspaceState::new())
        .manage(ProjectCache::new())
        .manage(BrowserState::new())
        .manage(FocusManagementState::new(true))
        .invoke_handler(tauri::generate_handler![
            commands::ide::workspace_focus,
            commands::ide::workspace_close,
            commands::ide::get_active_workspace,
            commands::ide::detect_active_workspace,
            commands::ide::pick_folder,
            commands::ide::reveal_in_finder,
            commands::ide::check_app_exists,
            commands::ide::open_with_app,
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
            commands::browser::browser_hide_all_for_workspace,
            commands::browser::browser_show_all_for_workspace,
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
            let zoom_in_item = MenuItemBuilder::with_id("zoom_in", "Zoom In")
                .accelerator("CmdOrCtrl+=")
                .build(app)?;
            let zoom_out_item = MenuItemBuilder::with_id("zoom_out", "Zoom Out")
                .accelerator("CmdOrCtrl+-")
                .build(app)?;
            let zoom_reset_item = MenuItemBuilder::with_id("zoom_reset", "Actual Size")
                .accelerator("CmdOrCtrl+0")
                .build(app)?;
            let settings_item = MenuItemBuilder::with_id("settings", "Settings...")
                .accelerator("CmdOrCtrl+Comma")
                .build(app)?;
            let view_menu = SubmenuBuilder::new(app, "View")
                .item(&reload_item)
                .separator()
                .item(&zoom_in_item)
                .item(&zoom_out_item)
                .item(&zoom_reset_item)
                .separator()
                .item(&settings_item)
                .build()?;

            // Build the Band application menu with About and Check for Updates.
            let mut band_menu =
                SubmenuBuilder::new(app, "Band").item(&PredefinedMenuItem::about(app, None, None)?);

            if UPDATER_ENABLED {
                let check_updates_item =
                    MenuItemBuilder::with_id("check_for_updates", "Check for Updates…")
                        .build(app)?;
                band_menu = band_menu.separator().item(&check_updates_item);
            }

            let band_menu = band_menu
                .separator()
                .item(&PredefinedMenuItem::hide(app, None)?)
                .item(&PredefinedMenuItem::hide_others(app, None)?)
                .item(&PredefinedMenuItem::show_all(app, None)?)
                .separator()
                .item(&PredefinedMenuItem::quit(app, None)?)
                .build()?;

            let menu = MenuBuilder::new(app)
                .item(&band_menu)
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
                } else if event.id() == "zoom_in"
                    || event.id() == "zoom_out"
                    || event.id() == "zoom_reset"
                {
                    let action = match event.id().0.as_str() {
                        "zoom_in" => "in",
                        "zoom_out" => "out",
                        _ => "reset",
                    };
                    // Apply zoom to the focused window (or main as fallback).
                    // The JS function is registered by ZoomSync in __root.tsx.
                    let target = app_handle
                        .webview_windows()
                        .values()
                        .find(|w| w.is_focused().unwrap_or(false))
                        .cloned()
                        .or_else(|| app_handle.get_webview_window("main"));
                    if let Some(win) = target {
                        let _ = win.eval(format!(
                            "if(window.__bandZoom)window.__bandZoom('{action}')"
                        ));
                    }
                } else if event.id() == "settings" {
                    let handle = app_handle.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = commands::window::open_settings_window(handle).await;
                    });
                } else if event.id() == "check_for_updates" {
                    let handle = app_handle.clone();
                    tauri::async_runtime::spawn(async move {
                        commands::updater::check_for_update(handle, true).await;
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

            // Ensure first-run defaults (e.g. appMode = "full-editor") are
            // written to settings.json before we read them.
            state::ensure_first_run_defaults();

            // Read app mode from settings (defaults to "full-editor")
            let app_mode = state::load_settings()
                .ok()
                .and_then(|s| s.app_mode)
                .unwrap_or_else(|| "full-editor".to_string());

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
                    // Side panel: use saved width, or default to 400
                    let saved_width = state::load_window_state()
                        .sidebar_width
                        .unwrap_or(400.0)
                        .max(240.0); // enforce minimum

                    let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize::new(
                        saved_width,
                        screen_height,
                    )));
                }
            }

            // Update the focus-management flag based on the persisted app mode.
            // Default is `true` (enabled); disable it in full-editor mode.
            let focus_state = app.state::<FocusManagementState>();
            if app_mode == "full-editor" {
                focus_state
                    .0
                    .store(false, std::sync::atomic::Ordering::SeqCst);
            }

            // Check for updates silently after a short delay so the app
            // is fully loaded before we hit the network.
            if UPDATER_ENABLED {
                let update_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                    commands::updater::check_for_update(update_handle, false).await;
                });
            }

            // Poll the frontmost VS Code window to track active workspace.
            // Only needed in side-panel mode where we manage external IDE windows.
            if app_mode != "full-editor" {
                let focus_flag = focus_state.inner().0.clone();
                commands::ide::start_focus_polling(app.handle().clone(), focus_flag);
            }

            // Kill web server and close secondary windows on app exit.
            // Uses a `cleaned_up` flag to avoid double cleanup when both
            // CloseRequested (close button) and ExitRequested (Cmd+Q) fire.
            let web_proc = app.state::<WebServerState>().inner().0.clone();
            let app_handle_for_close = app.handle().clone();
            let cleaned_up_close = cleaned_up;
            let resize_focus_flag = app.state::<FocusManagementState>().inner().0.clone();
            let resize_window = app.get_webview_window("main").unwrap();
            window.on_window_event(move |event| {
                // Persist sidebar width when the window is resized in side-panel mode.
                if let tauri::WindowEvent::Resized(_) = event {
                    if resize_focus_flag.load(Ordering::SeqCst) {
                        if let Ok(size) = resize_window.outer_size() {
                            let scale = resize_window
                                .current_monitor()
                                .ok()
                                .flatten()
                                .map_or(1.0, |m| m.scale_factor());
                            let width = f64::from(size.width) / scale;
                            let mut ws = state::load_window_state();
                            ws.sidebar_width = Some(width);
                            state::save_window_state(&ws);
                        }
                    }
                }
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

            // Raise the active workspace's app windows when the dashboard gains focus.
            // The handler is always registered but checks the focus-management flag
            // at runtime so it becomes a no-op in full-editor mode (and respects
            // runtime mode switches via `set_app_mode`).
            {
                let focus_flag = app.state::<FocusManagementState>().inner().0.clone();
                let active_ws_state: std::sync::Arc<std::sync::Mutex<Option<String>>> =
                    app.state::<ActiveWorkspaceState>().inner().0.clone();
                let raise_cache = app.state::<ProjectCache>().inner().clone();
                let window_ref = app.get_webview_window("main").unwrap();
                window_ref.on_window_event(move |event| {
                    if let tauri::WindowEvent::Focused(true) = event {
                        // Skip window raising when focus management is disabled
                        // (full-editor mode).
                        if !focus_flag.load(std::sync::atomic::Ordering::SeqCst) {
                            return;
                        }

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
