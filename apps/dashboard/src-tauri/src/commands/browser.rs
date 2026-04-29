use std::sync::Mutex;

use serde::Serialize;
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl};

/// Maximum number of browser webviews kept alive simultaneously.
/// When exceeded the least-recently-used webview is closed.
const MAX_BROWSER_WEBVIEWS: usize = 10;

/// Managed state that tracks browser webview creation order for LRU eviction.
pub struct BrowserState {
    /// Browser IDs whose webviews are currently alive, ordered from
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
    browser_id: String,
    /// `true` while the page is still loading, `false` when finished.
    loading: bool,
}

/// Payload emitted to the frontend with the page's `<title>` after load.
#[cfg(target_os = "macos")]
#[derive(Clone, Serialize)]
struct BrowserTitleChanged {
    browser_id: String,
    title: String,
}

/// Build the webview label for a given browser tab.
fn webview_label(browser_id: &str) -> String {
    format!("browser-{browser_id}")
}

/// Enforce the LRU cap by closing the oldest browser webview(s).
fn enforce_lru(app: &AppHandle, state: &BrowserState, new_browser_id: &str) {
    let mut order = state.order.lock().unwrap();

    // If this browser tab already has a webview, bump it to the end (most recent).
    if let Some(pos) = order.iter().position(|id| id == new_browser_id) {
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

    order.push(new_browser_id.to_string());
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Create (or show) a child webview for the given browser tab.
///
/// If a webview for this browser tab already exists it is shown and repositioned.
/// Otherwise a new child webview is created inside the main window.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn browser_create(
    app: AppHandle,
    state: tauri::State<'_, BrowserState>,
    browser_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    url: String,
) -> Result<(), String> {
    let label = webview_label(&browser_id);

    // If the webview already exists, just show + reposition it.
    if let Some(existing) = app.get_webview(&label) {
        let _ = existing.show();
        let _ = existing.set_position(tauri::LogicalPosition::new(x, y));
        let _ = existing.set_size(tauri::LogicalSize::new(width, height));
        // Bump to most-recent in LRU order.
        {
            let mut order = state.order.lock().unwrap();
            if let Some(pos) = order.iter().position(|id| id == &browser_id) {
                order.remove(pos);
                order.push(browser_id);
            }
        }
        return Ok(());
    }

    // Enforce LRU cap before creating a new webview.
    enforce_lru(&app, &state, &browser_id);

    let window = app.get_window("main").ok_or("Main window not found")?;
    let parsed_url: url::Url = url.parse().map_err(|e| format!("Invalid URL: {e}"))?;

    let app_handle = app.clone();
    let b_id = browser_id.clone();
    let builder = tauri::webview::WebviewBuilder::new(&label, WebviewUrl::External(parsed_url))
        .on_page_load(move |webview, payload| {
            let loading = matches!(payload.event(), PageLoadEvent::Started);
            if let Ok(current_url) = webview.url() {
                let _ = app_handle.emit(
                    "browser-url-changed",
                    BrowserUrlChanged {
                        url: current_url.to_string(),
                        browser_id: b_id.clone(),
                        loading,
                    },
                );
            }

            // After the page finishes loading, read the WKWebView's `title`
            // property (macOS) and emit it to the frontend so the tab label
            // reflects the page's <title>.
            if matches!(payload.event(), PageLoadEvent::Finished) {
                #[cfg(target_os = "macos")]
                {
                    let app_for_title = app_handle.clone();
                    let bid_for_title = b_id.clone();
                    let _ = webview.with_webview(move |wv| {
                        use cocoa::base::{id, nil};
                        use objc::{msg_send, sel, sel_impl};
                        unsafe {
                            let wk: id = wv.inner() as id;
                            let title_ns: id = msg_send![wk, title];
                            let title = if title_ns.is_null() || title_ns == nil {
                                String::new()
                            } else {
                                let bytes: *const std::os::raw::c_char =
                                    msg_send![title_ns, UTF8String];
                                if bytes.is_null() {
                                    String::new()
                                } else {
                                    std::ffi::CStr::from_ptr(bytes)
                                        .to_string_lossy()
                                        .into_owned()
                                }
                            };
                            if !title.is_empty() {
                                let _ = app_for_title.emit(
                                    "browser-title-changed",
                                    BrowserTitleChanged {
                                        browser_id: bid_for_title,
                                        title,
                                    },
                                );
                            }
                        }
                    });
                }
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

/// Navigate the browser tab's webview to a new URL.
#[tauri::command]
pub async fn browser_navigate(
    app: AppHandle,
    browser_id: String,
    url: String,
) -> Result<(), String> {
    let label = webview_label(&browser_id);
    let webview = app.get_webview(&label).ok_or("Browser webview not found")?;
    let parsed: url::Url = url.parse().map_err(|e| format!("Invalid URL: {e}"))?;
    webview.navigate(parsed).map_err(|e| format!("{e}"))
}

/// Go back in the browser history.
#[tauri::command]
pub async fn browser_go_back(app: AppHandle, browser_id: String) -> Result<(), String> {
    let label = webview_label(&browser_id);
    let webview = app.get_webview(&label).ok_or("Browser webview not found")?;
    webview.eval("history.back()").map_err(|e| format!("{e}"))
}

/// Go forward in the browser history.
#[tauri::command]
pub async fn browser_go_forward(app: AppHandle, browser_id: String) -> Result<(), String> {
    let label = webview_label(&browser_id);
    let webview = app.get_webview(&label).ok_or("Browser webview not found")?;
    webview
        .eval("history.forward()")
        .map_err(|e| format!("{e}"))
}

/// Evaluate arbitrary JavaScript in the browser webview.
#[tauri::command]
pub async fn browser_eval(app: AppHandle, browser_id: String, js: String) -> Result<(), String> {
    let label = webview_label(&browser_id);
    let webview = app.get_webview(&label).ok_or("Browser webview not found")?;
    webview.eval(&js).map_err(|e| format!("{e}"))
}

/// Reload the current page in the browser webview.
#[tauri::command]
pub async fn browser_reload(app: AppHandle, browser_id: String) -> Result<(), String> {
    let label = webview_label(&browser_id);
    let webview = app.get_webview(&label).ok_or("Browser webview not found")?;
    webview
        .eval("location.reload()")
        .map_err(|e| format!("{e}"))
}

/// Update the position and size of the browser webview (called on panel resize).
#[tauri::command]
pub async fn browser_set_bounds(
    app: AppHandle,
    browser_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let label = webview_label(&browser_id);
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
pub async fn browser_hide(app: AppHandle, browser_id: String) -> Result<(), String> {
    let label = webview_label(&browser_id);
    if let Some(webview) = app.get_webview(&label) {
        webview.hide().map_err(|e| format!("{e}"))?;
    }
    Ok(())
}

/// Show the browser webview (when the panel tab becomes active).
#[tauri::command]
pub async fn browser_show(app: AppHandle, browser_id: String) -> Result<(), String> {
    let label = webview_label(&browser_id);
    if let Some(webview) = app.get_webview(&label) {
        webview.show().map_err(|e| format!("{e}"))?;
    }
    Ok(())
}

/// Destroy the browser webview for a browser tab and remove it from LRU tracking.
#[tauri::command]
pub async fn browser_destroy(
    app: AppHandle,
    state: tauri::State<'_, BrowserState>,
    browser_id: String,
) -> Result<(), String> {
    let label = webview_label(&browser_id);
    if let Some(webview) = app.get_webview(&label) {
        webview.close().map_err(|e| format!("{e}"))?;
    }
    let mut order = state.order.lock().unwrap();
    order.retain(|id| id != &browser_id);
    Ok(())
}

// ---------------------------------------------------------------------------
// Workspace-level bulk commands (for dialog hiding etc.)
// ---------------------------------------------------------------------------

/// Hide ALL browser webviews whose IDs are tracked in the LRU.
/// Used when a dialog opens over the workspace — native webviews float above
/// the DOM and would otherwise cover the dialog.
///
/// Since browser IDs contain the workspace ID as context (stored server-side),
/// we simply hide every tracked webview. The caller should only invoke this
/// when the workspace is the active one.
#[tauri::command]
pub async fn browser_hide_all_for_workspace(
    app: AppHandle,
    state: tauri::State<'_, BrowserState>,
    #[allow(unused_variables)] workspace_id: String,
) -> Result<(), String> {
    let order = state.order.lock().unwrap();
    for browser_id in order.iter() {
        let label = webview_label(browser_id);
        if let Some(webview) = app.get_webview(&label) {
            let _ = webview.hide();
        }
    }
    Ok(())
}

/// Show ALL browser webviews whose IDs are tracked in the LRU.
/// Counterpart to `browser_hide_all_for_workspace`.
#[tauri::command]
pub async fn browser_show_all_for_workspace(
    app: AppHandle,
    state: tauri::State<'_, BrowserState>,
    #[allow(unused_variables)] workspace_id: String,
) -> Result<(), String> {
    let order = state.order.lock().unwrap();
    for browser_id in order.iter() {
        let label = webview_label(browser_id);
        if let Some(webview) = app.get_webview(&label) {
            let _ = webview.show();
        }
    }
    Ok(())
}
