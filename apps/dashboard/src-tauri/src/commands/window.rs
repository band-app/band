use crate::state::FocusManagementState;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// Derives a URL for a secondary window by taking the main window's origin
/// (scheme + host + port + query params like ?token=…) and replacing the path.
/// This ensures secondary windows always hit the same server as the main window,
/// even when Vite auto-picks a non-default port in dev mode.
fn secondary_window_url(app: &AppHandle, path: &str) -> Result<url::Url, String> {
    let main = app
        .get_webview_window("main")
        .ok_or("Main window not found")?;
    let mut url = main
        .url()
        .map_err(|e| format!("Failed to get main window URL: {e}"))?;
    url.set_path(path);
    Ok(url)
}

/// Apply dark background color on macOS (same as main window).
#[cfg(target_os = "macos")]
#[allow(deprecated)]
fn set_dark_background(window: &tauri::WebviewWindow) {
    use cocoa::appkit::NSColor;
    use cocoa::appkit::NSWindow;
    use cocoa::base::{id, nil};
    let ns_window = window.ns_window().unwrap() as id;
    unsafe {
        let color = NSColor::colorWithSRGBRed_green_blue_alpha_(nil, 0.0, 0.0, 0.0, 1.0);
        ns_window.setBackgroundColor_(color);
    }
}

fn build_secondary_window(
    app: &AppHandle,
    label: &str,
    title: &str,
    path: &str,
) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(label) {
        let _ = existing.set_focus();
        return Ok(());
    }

    let url = secondary_window_url(app, path)?;

    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .title(title)
        .inner_size(900.0, 700.0)
        .center();

    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);

    #[allow(unused_variables)]
    let window = builder
        .build()
        .map_err(|e| format!("Failed to create {label} window: {e}"))?;

    #[cfg(target_os = "macos")]
    set_dark_background(&window);

    Ok(())
}

#[tauri::command]
pub async fn open_tasks_window(app: AppHandle) -> Result<(), String> {
    build_secondary_window(&app, "tasks", "Tasks - Band", "/tasks")
}

#[tauri::command]
pub async fn open_cronjobs_window(app: AppHandle) -> Result<(), String> {
    build_secondary_window(&app, "cronjobs", "Cronjobs - Band", "/cronjobs")
}

#[tauri::command]
pub async fn open_settings_window(app: AppHandle) -> Result<(), String> {
    build_secondary_window(&app, "settings", "Settings - Band", "/settings")
}

#[tauri::command]
pub fn get_app_title() -> String {
    match crate::git::get_current_branch() {
        Some(branch) => format!("Band - {branch}"),
        None => "Band".to_string(),
    }
}

const SIDE_PANEL_WIDTH: f64 = 400.0;

#[tauri::command]
pub async fn set_app_mode(app: AppHandle, mode: String) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Main window not found")?;

    // Toggle focus management based on the new mode.
    // In full-editor mode, the Tauri app IS the editor, so focus polling
    // and automatic window raising must be disabled.
    let focus_state = app.state::<FocusManagementState>();
    let was_enabled = focus_state.0.load(Ordering::SeqCst);
    let should_enable = mode != "full-editor";
    focus_state.0.store(should_enable, Ordering::SeqCst);

    let monitor = window
        .current_monitor()
        .map_err(|e| format!("Failed to get monitor: {e}"))?
        .ok_or("No monitor found")?;

    let screen_size = monitor.size();
    let scale = monitor.scale_factor();
    let screen_w = f64::from(screen_size.width) / scale;
    let screen_h = f64::from(screen_size.height) / scale;

    if mode == "full-editor" {
        let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize::new(
            screen_w, screen_h,
        )));
        let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(
            0.0, 0.0,
        )));
    } else {
        // Side panel: narrow width, full height, left edge
        let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize::new(
            SIDE_PANEL_WIDTH,
            screen_h,
        )));
        let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(
            0.0, 0.0,
        )));
    }

    // Start focus polling if switching from full-editor to side-panel.
    // The old polling thread (if any) already exited when the flag was
    // set to false.
    if should_enable && !was_enabled {
        let flag = focus_state.inner().0.clone();
        crate::commands::ide::start_focus_polling(app.clone(), flag);
    }

    // Reload the main webview so it picks up the new app mode from settings
    let _ = window.eval("window.location.replace('/')");

    Ok(())
}
