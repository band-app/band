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

    let window = WebviewWindowBuilder::new(
        &app,
        "tasks",
        WebviewUrl::External(url.parse().map_err(|e| format!("Invalid URL: {e}"))?),
    )
    .title("Tasks - Band")
    .inner_size(900.0, 700.0)
    .center()
    .title_bar_style(tauri::TitleBarStyle::Transparent)
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
