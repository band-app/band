use std::sync::Mutex;

use serde::Serialize;
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl};

/// Maximum number of browser webviews kept alive simultaneously.
/// When exceeded the least-recently-used webview is closed.
const MAX_BROWSER_WEBVIEWS: usize = 5;

/// Managed state that tracks browser webview creation order for LRU eviction.
pub struct BrowserState {
    /// Workspace IDs whose browser webviews are currently alive, ordered from
    /// oldest (front) to newest (back).
    pub order: Mutex<Vec<String>>,
}

impl BrowserState {
    pub fn new() -> Self {
        Self {
            order: Mutex::new(Vec::new()),
        }
    }
}

/// Payload emitted to the frontend when a browser webview navigates.
#[derive(Clone, Serialize)]
struct BrowserUrlChanged {
    url: String,
    workspace_id: String,
    /// `true` while the page is still loading, `false` when finished.
    loading: bool,
}

/// Build the webview label for a given workspace.
fn webview_label(workspace_id: &str) -> String {
    format!("browser-{workspace_id}")
}

/// Enforce the LRU cap by closing the oldest browser webview(s).
fn enforce_lru(app: &AppHandle, state: &BrowserState, new_workspace_id: &str) {
    let mut order = state.order.lock().unwrap();

    // If this workspace already has a webview, bump it to the end (most recent).
    if let Some(pos) = order.iter().position(|id| id == new_workspace_id) {
        order.remove(pos);
    }

    // Evict oldest until we're under the cap (leaving room for the new one).
    while order.len() >= MAX_BROWSER_WEBVIEWS {
        if let Some(oldest_id) = order.first().cloned() {
            order.remove(0);
            let label = webview_label(&oldest_id);
            if let Some(wv) = app.get_webview(&label) {
                let _ = wv.close();
            }
        }
    }

    order.push(new_workspace_id.to_string());
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Create (or show) a child webview for the given workspace's browser panel.
///
/// If a webview for this workspace already exists it is shown and repositioned.
/// Otherwise a new child webview is created inside the main window.
#[tauri::command]
pub async fn browser_create(
    app: AppHandle,
    state: tauri::State<'_, BrowserState>,
    workspace_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    url: String,
) -> Result<(), String> {
    let label = webview_label(&workspace_id);

    // If the webview already exists, just show + reposition it.
    if let Some(existing) = app.get_webview(&label) {
        let _ = existing.show();
        let _ = existing.set_position(tauri::LogicalPosition::new(x, y));
        let _ = existing.set_size(tauri::LogicalSize::new(width, height));
        // Bump to most-recent in LRU order.
        {
            let mut order = state.order.lock().unwrap();
            if let Some(pos) = order.iter().position(|id| id == &workspace_id) {
                order.remove(pos);
                order.push(workspace_id);
            }
        }
        return Ok(());
    }

    // Enforce LRU cap before creating a new webview.
    enforce_lru(&app, &state, &workspace_id);

    let window = app.get_window("main").ok_or("Main window not found")?;
    let parsed_url: url::Url = url.parse().map_err(|e| format!("Invalid URL: {e}"))?;

    let app_handle = app.clone();
    let ws_id = workspace_id.clone();
    let builder =
        tauri::webview::WebviewBuilder::new(&label, WebviewUrl::External(parsed_url))
            .on_page_load(move |webview, payload| {
                let loading = matches!(payload.event(), PageLoadEvent::Started);
                if let Ok(current_url) = webview.url() {
                    let _ = app_handle.emit(
                        "browser-url-changed",
                        BrowserUrlChanged {
                            url: current_url.to_string(),
                            workspace_id: ws_id.clone(),
                            loading,
                        },
                    );
                }
            });

    window
        .add_child(
            builder,
            tauri::LogicalPosition::new(x, y),
            tauri::LogicalSize::new(width, height),
        )
        .map_err(|e| format!("Failed to create browser webview: {e}"))?;

    Ok(())
}

/// Navigate the workspace's browser webview to a new URL.
#[tauri::command]
pub async fn browser_navigate(
    app: AppHandle,
    workspace_id: String,
    url: String,
) -> Result<(), String> {
    let label = webview_label(&workspace_id);
    let webview = app.get_webview(&label).ok_or("Browser webview not found")?;
    let parsed: url::Url = url.parse().map_err(|e| format!("Invalid URL: {e}"))?;
    webview.navigate(parsed).map_err(|e| format!("{e}"))
}

/// Go back in the browser history.
#[tauri::command]
pub async fn browser_go_back(app: AppHandle, workspace_id: String) -> Result<(), String> {
    let label = webview_label(&workspace_id);
    let webview = app.get_webview(&label).ok_or("Browser webview not found")?;
    webview
        .eval("history.back()")
        .map_err(|e| format!("{e}"))
}

/// Go forward in the browser history.
#[tauri::command]
pub async fn browser_go_forward(app: AppHandle, workspace_id: String) -> Result<(), String> {
    let label = webview_label(&workspace_id);
    let webview = app.get_webview(&label).ok_or("Browser webview not found")?;
    webview
        .eval("history.forward()")
        .map_err(|e| format!("{e}"))
}

/// Evaluate arbitrary JavaScript in the browser webview.
#[tauri::command]
pub async fn browser_eval(app: AppHandle, workspace_id: String, js: String) -> Result<(), String> {
    let label = webview_label(&workspace_id);
    let webview = app.get_webview(&label).ok_or("Browser webview not found")?;
    webview.eval(&js).map_err(|e| format!("{e}"))
}

/// Reload the current page in the browser webview.
#[tauri::command]
pub async fn browser_reload(app: AppHandle, workspace_id: String) -> Result<(), String> {
    let label = webview_label(&workspace_id);
    let webview = app.get_webview(&label).ok_or("Browser webview not found")?;
    webview
        .eval("location.reload()")
        .map_err(|e| format!("{e}"))
}

/// Update the position and size of the browser webview (called on panel resize).
#[tauri::command]
pub async fn browser_set_bounds(
    app: AppHandle,
    workspace_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let label = webview_label(&workspace_id);
    let webview = app.get_webview(&label).ok_or("Browser webview not found")?;
    webview
        .set_position(tauri::LogicalPosition::new(x, y))
        .map_err(|e| format!("{e}"))?;
    webview
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(|e| format!("{e}"))
}

/// Hide the browser webview (when the panel tab is not active or workspace switches away).
#[tauri::command]
pub async fn browser_hide(app: AppHandle, workspace_id: String) -> Result<(), String> {
    let label = webview_label(&workspace_id);
    if let Some(webview) = app.get_webview(&label) {
        webview.hide().map_err(|e| format!("{e}"))?;
    }
    Ok(())
}

/// Show the browser webview (when the panel tab becomes active).
#[tauri::command]
pub async fn browser_show(app: AppHandle, workspace_id: String) -> Result<(), String> {
    let label = webview_label(&workspace_id);
    if let Some(webview) = app.get_webview(&label) {
        webview.show().map_err(|e| format!("{e}"))?;
    }
    Ok(())
}

/// Destroy the browser webview for a workspace and remove it from LRU tracking.
#[tauri::command]
pub async fn browser_destroy(
    app: AppHandle,
    state: tauri::State<'_, BrowserState>,
    workspace_id: String,
) -> Result<(), String> {
    let label = webview_label(&workspace_id);
    if let Some(webview) = app.get_webview(&label) {
        webview.close().map_err(|e| format!("{e}"))?;
    }
    let mut order = state.order.lock().unwrap();
    order.retain(|id| id != &workspace_id);
    Ok(())
}
