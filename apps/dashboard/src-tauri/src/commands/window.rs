use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::commands::webserver;
use crate::state::load_settings;

const DEV_PORT: u16 = 3456;

#[tauri::command]
pub async fn open_tasks_window(app: AppHandle) -> Result<(), String> {
    // If the tasks window already exists, just focus it
    if let Some(existing) = app.get_webview_window("tasks") {
        let _ = existing.set_focus();
        return Ok(());
    }

    // Build the URL
    let url = if cfg!(debug_assertions) {
        format!("http://localhost:{DEV_PORT}/tasks")
    } else {
        let port = webserver::get_configured_port();
        let settings = load_settings()?;
        let token = settings.token_secret.ok_or_else(|| {
            "tokenSecret not found in settings.json — start the web server first".to_string()
        })?;
        format!("http://localhost:{port}/tasks?token={token}")
    };

    let builder = WebviewWindowBuilder::new(
        &app,
        "tasks",
        WebviewUrl::External(url.parse().map_err(|e| format!("Invalid URL: {e}"))?),
    )
    .title("Tasks - Band")
    .inner_size(900.0, 700.0)
    .center();

    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);

    #[allow(unused_variables)]
    let window = builder
        .build()
        .map_err(|e| format!("Failed to create tasks window: {e}"))?;

    // Set dark background color on macOS (same as main window)
    #[cfg(target_os = "macos")]
    #[allow(deprecated)]
    {
        use cocoa::appkit::NSColor;
        use cocoa::appkit::NSWindow;
        use cocoa::base::{id, nil};
        let ns_window = window.ns_window().unwrap() as id;
        unsafe {
            let color = NSColor::colorWithSRGBRed_green_blue_alpha_(nil, 0.0, 0.0, 0.0, 1.0);
            ns_window.setBackgroundColor_(color);
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn open_cronjobs_window(app: AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window("cronjobs") {
        let _ = existing.set_focus();
        return Ok(());
    }

    let url = if cfg!(debug_assertions) {
        format!("http://localhost:{DEV_PORT}/cronjobs")
    } else {
        let port = webserver::get_configured_port();
        let settings = load_settings()?;
        let token = settings.token_secret.ok_or_else(|| {
            "tokenSecret not found in settings.json — start the web server first".to_string()
        })?;
        format!("http://localhost:{port}/cronjobs?token={token}")
    };

    let builder = WebviewWindowBuilder::new(
        &app,
        "cronjobs",
        WebviewUrl::External(url.parse().map_err(|e| format!("Invalid URL: {e}"))?),
    )
    .title("Cronjobs - Band")
    .inner_size(900.0, 700.0)
    .center();

    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);

    #[allow(unused_variables)]
    let window = builder
        .build()
        .map_err(|e| format!("Failed to create cronjobs window: {e}"))?;

    #[cfg(target_os = "macos")]
    #[allow(deprecated)]
    {
        use cocoa::appkit::NSColor;
        use cocoa::appkit::NSWindow;
        use cocoa::base::{id, nil};
        let ns_window = window.ns_window().unwrap() as id;
        unsafe {
            let color = NSColor::colorWithSRGBRed_green_blue_alpha_(nil, 0.0, 0.0, 0.0, 1.0);
            ns_window.setBackgroundColor_(color);
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn open_settings_window(app: AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window("settings") {
        let _ = existing.set_focus();
        return Ok(());
    }

    let url = if cfg!(debug_assertions) {
        format!("http://localhost:{DEV_PORT}/settings")
    } else {
        let port = webserver::get_configured_port();
        let settings = load_settings()?;
        let token = settings.token_secret.ok_or_else(|| {
            "tokenSecret not found in settings.json — start the web server first".to_string()
        })?;
        format!("http://localhost:{port}/settings?token={token}")
    };

    let builder = WebviewWindowBuilder::new(
        &app,
        "settings",
        WebviewUrl::External(url.parse().map_err(|e| format!("Invalid URL: {e}"))?),
    )
    .title("Settings - Band")
    .inner_size(900.0, 700.0)
    .center();

    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);

    #[allow(unused_variables)]
    let window = builder
        .build()
        .map_err(|e| format!("Failed to create settings window: {e}"))?;

    #[cfg(target_os = "macos")]
    #[allow(deprecated)]
    {
        use cocoa::appkit::NSColor;
        use cocoa::appkit::NSWindow;
        use cocoa::base::{id, nil};
        let ns_window = window.ns_window().unwrap() as id;
        unsafe {
            let color = NSColor::colorWithSRGBRed_green_blue_alpha_(nil, 0.0, 0.0, 0.0, 1.0);
            ns_window.setBackgroundColor_(color);
        }
    }

    Ok(())
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

    // Reload the main webview so it picks up the new app mode from settings
    let _ = window.eval("window.location.replace('/')");

    Ok(())
}
