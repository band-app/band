use crate::api::ApiClient;
use crate::state;
use crate::state::{ActiveWorkspaceState, FocusManagementState, ProjectCache};
use std::collections::{HashMap, VecDeque};
use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;
use tauri::{Emitter, Manager};

use std::io::Write;

use super::apps::{self, AppHandler};
use super::ax_windows::{
    self, get_bundle_id, get_frontmost_window, objc_getClass, objc_msgSend, proc_listpids,
    proc_pidinfo, sel_registerName, PROC_ALL_PIDS, PROC_PIDTBSDINFO, PROC_PIDVNODEPATHINFO,
};
use super::window_manager::WindowManager;

fn log_debug(msg: &str) {
    let log_file = state::band_home().join("debug.log");
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_file)
    {
        let elapsed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default();
        let secs = elapsed.as_secs();
        let millis = elapsed.subsec_millis();
        let _ = writeln!(f, "[{secs}.{millis:03}] {msg}");
    }
}

// --- libproc: process enumeration and CWD lookup ---

fn get_all_pids() -> Vec<i32> {
    unsafe {
        let buf_size = proc_listpids(PROC_ALL_PIDS, 0, std::ptr::null_mut(), 0);
        if buf_size <= 0 {
            return Vec::new();
        }

        let count = buf_size as usize / std::mem::size_of::<i32>();
        let mut pids = vec![0i32; count];
        let actual = proc_listpids(
            PROC_ALL_PIDS,
            0,
            pids.as_mut_ptr().cast::<c_void>(),
            buf_size,
        );

        if actual <= 0 {
            return Vec::new();
        }

        let actual_count = actual as usize / std::mem::size_of::<i32>();
        pids.truncate(actual_count);
        pids.retain(|&p| p > 0);
        pids
    }
}

#[allow(clippy::similar_names)]
fn get_ppid(pid: i32) -> Option<i32> {
    unsafe {
        let mut buf = [0u8; 256]; // proc_bsdinfo is ~136 bytes
        let ret = proc_pidinfo(
            pid,
            PROC_PIDTBSDINFO,
            0,
            buf.as_mut_ptr().cast::<c_void>(),
            buf.len() as i32,
        );
        if ret <= 20 {
            return None;
        }
        // pbi_ppid at offset 16, u32 (native endian)
        let ppid = u32::from_ne_bytes([buf[16], buf[17], buf[18], buf[19]]) as i32;
        if ppid > 0 {
            Some(ppid)
        } else {
            None
        }
    }
}

fn get_process_cwd(pid: i32) -> Option<PathBuf> {
    unsafe {
        let mut buf = [0u8; 2352]; // proc_vnodepathinfo size
        let ret = proc_pidinfo(
            pid,
            PROC_PIDVNODEPATHINFO,
            0,
            buf.as_mut_ptr().cast::<c_void>(),
            buf.len() as i32,
        );
        if ret <= 152 {
            return None;
        }
        // pvi_cdir.vip_path at offset 152, null-terminated C string (up to 1024 bytes)
        let path_bytes = &buf[152..];
        let len = path_bytes.iter().position(|&b| b == 0).unwrap_or(1024);
        let path_str = std::str::from_utf8(&path_bytes[..len]).ok()?;
        if path_str.is_empty() || path_str == "/" {
            None
        } else {
            Some(PathBuf::from(path_str))
        }
    }
}

fn get_descendant_cwds(parent_pid: i32) -> Vec<PathBuf> {
    let all_pids = get_all_pids();

    // Build parent -> children map
    let mut children_map: HashMap<i32, Vec<i32>> = HashMap::new();
    for &pid in &all_pids {
        if let Some(ppid) = get_ppid(pid) {
            children_map.entry(ppid).or_default().push(pid);
        }
    }

    // BFS to collect all descendants and their CWDs
    let mut queue = VecDeque::new();
    queue.push_back(parent_pid);
    let mut cwds = Vec::new();

    while let Some(pid) = queue.pop_front() {
        if let Some(cwd) = get_process_cwd(pid) {
            cwds.push(cwd);
        }
        if let Some(children) = children_map.get(&pid) {
            for &child in children {
                queue.push_back(child);
            }
        }
    }

    cwds.sort();
    cwds.dedup();
    cwds
}

// --- Workspace matching ---

/// Build a workspace ID from project name and branch, replacing `/` with `-`
/// to match the canonical format used by the web server's `toWorkspaceId()`.
fn to_workspace_id(project: &str, branch: &str) -> String {
    format!("{}-{}", project, branch.replace('/', "-"))
}

fn match_cwds_to_workspace(cwds: &[PathBuf], app_state: &state::AppState) -> Option<String> {
    let mut matches = Vec::new();

    for proj in &app_state.projects {
        for wt in &proj.worktrees {
            let wt_path = PathBuf::from(&wt.path);
            for cwd in cwds {
                if cwd == &wt_path || cwd.starts_with(&wt_path) {
                    let ws_id = to_workspace_id(&proj.name, &wt.branch);
                    if !matches.contains(&ws_id) {
                        matches.push(ws_id);
                    }
                    break;
                }
            }
        }
    }

    if matches.len() == 1 {
        matches.into_iter().next()
    } else {
        None
    }
}

/// Set the active workspace in in-memory state.
fn set_active_workspace(active_state: &std::sync::Mutex<Option<String>>, workspace_id: &str) {
    if let Ok(mut guard) = active_state.lock() {
        *guard = Some(workspace_id.to_string());
    }
}

/// Check if the dashboard (our own process) is the frontmost application.
fn is_dashboard_frontmost() -> bool {
    get_frontmost_window().is_some_and(|(pid, _)| pid as u32 == std::process::id())
}

/// Look up the worktree path and folder name for a given workspace ID.
fn workspace_info(
    workspace_id: &str,
    app_state: &state::AppState,
) -> Option<(String, String, String)> {
    for proj in &app_state.projects {
        for wt in &proj.worktrees {
            let ws_id = to_workspace_id(&proj.name, &wt.branch);
            if ws_id == workspace_id {
                let folder_name = Path::new(&wt.path)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .to_string();
                return Some((wt.path.clone(), folder_name, proj.path.clone()));
            }
        }
    }
    None
}

/// Detect the frontmost workspace using native macOS APIs.
fn detect_frontmost_workspace(app_state: &state::AppState) -> Option<String> {
    let (pid, cg_id, title) = ax_windows::get_frontmost_window_with_id()?;

    // Skip if frontmost app is our own process
    if pid as u32 == std::process::id() {
        return None;
    }

    // 1. Registry lookup: if the focused window's `CGWindowID` is registered,
    //    we know immediately which workspace it belongs to. This handles
    //    Cmd+` switching, iTerm (where title matching fails), and any app
    //    whose window we previously opened.
    if let Some(cg_id) = cg_id {
        if let Some((_app_type, workspace_id)) = WindowManager::global().find_by_cg_id(cg_id) {
            // Verify the workspace still exists in current state
            if find_workspace(&workspace_id, app_state).is_some() {
                return Some(workspace_id);
            }
        }
    }

    // 2. CWD-based matching (generic, works for any app)
    let cwds = get_descendant_cwds(pid);
    if let Some(ws_id) = match_cwds_to_workspace(&cwds, app_state) {
        return Some(ws_id);
    }

    // 3. Window title matching for known managed apps
    if !title.is_empty() {
        if let Some(bundle_id) = get_bundle_id(pid) {
            let known = apps::all_known_bundle_ids();
            for (app_type, known_bundle_id) in &known {
                if bundle_id == *known_bundle_id {
                    if let Some(driver) = apps::get_handler(app_type) {
                        let mut best_match: Option<(String, usize)> = None;

                        for proj in &app_state.projects {
                            for wt in &proj.worktrees {
                                let folder_name = Path::new(&wt.path)
                                    .file_name()
                                    .and_then(|n| n.to_str())
                                    .unwrap_or("");

                                if !folder_name.is_empty()
                                    && driver.matches_window_title(&title, folder_name)
                                {
                                    let ws_id = to_workspace_id(&proj.name, &wt.branch);
                                    if best_match
                                        .as_ref()
                                        .is_none_or(|(_, len)| folder_name.len() > *len)
                                    {
                                        best_match = Some((ws_id, folder_name.len()));
                                    }
                                }
                            }
                        }

                        if let Some((ws_id, _)) = best_match {
                            return Some(ws_id);
                        }
                    }
                    break;
                }
            }
        }
    }

    None
}

/// Fetch fresh project state from the web server and update the cache.
fn refresh_project_cache(cache: &ProjectCache) -> Option<state::AppState> {
    let client = ApiClient::from_settings().ok()?;
    let data = client
        .trpc_query("projects.list", &serde_json::json!({}))
        .ok()?;
    let projects_arr = data.get("projects").and_then(|p| p.as_array())?;
    let projects: Vec<state::ProjectState> = projects_arr
        .iter()
        .filter_map(|p| serde_json::from_value(p.clone()).ok())
        .collect();
    let app_state = state::AppState { projects };
    cache.set(app_state.clone());
    Some(app_state)
}

/// Look up a workspace in the app state by ID.
fn find_workspace<'a>(
    workspace_id: &str,
    app_state: &'a state::AppState,
) -> Option<(&'a state::ProjectState, &'a state::WorktreeState)> {
    for proj in &app_state.projects {
        for wt in &proj.worktrees {
            if to_workspace_id(&proj.name, &wt.branch) == workspace_id {
                return Some((proj, wt));
            }
        }
    }
    None
}

/// Clear `needs_attention` status by calling the web server API.
/// Only resets to "waiting" if the current status is actually `needs_attention`,
/// so it won't clobber "working" status while an agent is running.
fn clear_needs_attention(workspace_id: &str, api: &ApiClient) {
    let current = api.trpc_query(
        "statuses.get",
        &serde_json::json!({ "workspaceId": workspace_id }),
    );
    let is_needs_attention = current
        .ok()
        .and_then(|v| v.get("agent")?.get("status")?.as_str().map(String::from))
        .as_deref()
        == Some("needs_attention");

    if !is_needs_attention {
        return;
    }

    let _ = api.trpc_mutate(
        "statuses.update",
        &serde_json::json!({
            "workspaceId": workspace_id,
            "agent": { "status": "waiting" },
        }),
    );
}

/// Bring all dashboard windows to front without activating the app.
/// Uses `NSWindow`'s `orderFrontRegardless` to raise without stealing focus.
/// Must be called on the main thread.
unsafe fn raise_dashboard_windows() {
    type MsgSend = unsafe extern "C" fn(*const c_void, *const c_void) -> *const c_void;
    type MsgSendIdx = unsafe extern "C" fn(*const c_void, *const c_void, usize) -> *const c_void;
    type MsgSendCount = unsafe extern "C" fn(*const c_void, *const c_void) -> usize;
    type MsgSendBool = unsafe extern "C" fn(*const c_void, *const c_void) -> i8;

    let msg: MsgSend = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    let msg_idx: MsgSendIdx = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    let msg_count: MsgSendCount = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    let msg_bool: MsgSendBool = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());

    let cls = objc_getClass(c"NSApplication".as_ptr());
    if cls.is_null() {
        return;
    }

    let app = msg(cls, sel_registerName(c"sharedApplication".as_ptr()));
    if app.is_null() {
        return;
    }

    let windows = msg(app, sel_registerName(c"windows".as_ptr()));
    if windows.is_null() {
        return;
    }

    let count = msg_count(windows, sel_registerName(c"count".as_ptr()));
    let obj_at = sel_registerName(c"objectAtIndex:".as_ptr());
    let raise = sel_registerName(c"orderFrontRegardless".as_ptr());
    let is_visible = sel_registerName(c"isVisible".as_ptr());

    for i in 0..count {
        let win = msg_idx(windows, obj_at, i);
        if !win.is_null() && msg_bool(win, is_visible) != 0 {
            msg(win, raise);
        }
    }
}

/// Raise all workspace app windows.
pub fn raise_workspace_windows(workspace_id: &str, cache: &ProjectCache) {
    let Some(app_state) = cache.get() else {
        return;
    };
    let Some((worktree_path, _folder_name, proj_path)) = workspace_info(workspace_id, &app_state)
    else {
        return;
    };

    let app_configs = apps::load_apps_config(&worktree_path, &proj_path);

    if app_configs.is_empty() {
        return;
    }

    let wm = WindowManager::global();
    for app_config in &app_configs {
        wm.raise_window(app_config.app_type(), workspace_id);
    }
}

/// Start a background thread that polls the frontmost window
/// and updates active workspace state when the focused workspace changes.
/// The thread exits when `enabled` is set to `false` (e.g. when the app
/// switches to full-editor mode).
pub fn start_focus_polling(app_handle: tauri::AppHandle, enabled: Arc<AtomicBool>) {
    let active_state = {
        let s = app_handle.state::<ActiveWorkspaceState>();
        s.inner().0.clone()
    };
    let project_cache = {
        let s = app_handle.state::<ProjectCache>();
        s.inner().clone()
    };

    std::thread::spawn(move || {
        let mut last_active: Option<String> = None;
        let mut dashboard_raised = false;
        let mut apps_raised = false;
        let mut last_cache_refresh = std::time::Instant::now()
            .checked_sub(Duration::from_secs(10))
            .unwrap_or_else(std::time::Instant::now);
        let mut api: Option<ApiClient> = None;
        // After workspace_focus changes the active workspace, suppress
        // frontmost-window detection for a short period so the spawned
        // window-management threads have time to actually raise the new
        // windows.  Without this, polling can detect the *old* frontmost
        // window and immediately emit an event that reverts the selection.
        let mut suppress_detection_until: Option<std::time::Instant> = None;

        loop {
            std::thread::sleep(Duration::from_millis(500));

            // Exit the polling thread when focus management is disabled
            // (e.g. user switched to full-editor mode at runtime).
            if !enabled.load(std::sync::atomic::Ordering::SeqCst) {
                break;
            }

            // Refresh project cache from web server every 5 seconds
            if last_cache_refresh.elapsed() >= Duration::from_secs(5) {
                last_cache_refresh = std::time::Instant::now();
                refresh_project_cache(&project_cache);

                if api.is_none() {
                    api = ApiClient::from_settings().ok();
                }
            }

            let Some(cached) = project_cache.get() else {
                continue;
            };

            // Sync last_active from shared state (workspace_focus may have changed it)
            if let Ok(guard) = active_state.lock() {
                if *guard != last_active {
                    last_active.clone_from(&guard);
                    apps_raised = false;
                    suppress_detection_until =
                        Some(std::time::Instant::now() + Duration::from_secs(2));
                }
            }

            // While suppressed, skip frontmost-window detection entirely.
            if suppress_detection_until.is_some_and(|t| std::time::Instant::now() < t) {
                continue;
            }
            suppress_detection_until = None;

            if let Some(ws_id) = detect_frontmost_workspace(&cached) {
                if let Some(ref client) = api {
                    clear_needs_attention(&ws_id, client);
                }

                if last_active.as_deref() != Some(ws_id.as_str()) {
                    last_active = Some(ws_id.clone());
                    set_active_workspace(&active_state, &ws_id);
                    let _ = app_handle.emit("active-workspace", ws_id.clone());
                }
                if !dashboard_raised {
                    let _ = app_handle.run_on_main_thread(|| unsafe {
                        raise_dashboard_windows();
                    });
                    dashboard_raised = true;
                }
                apps_raised = false;
            } else if is_dashboard_frontmost() {
                if !apps_raised {
                    if let Some(ref ws_id) = last_active {
                        if let Some(ref client) = api {
                            clear_needs_attention(ws_id, client);
                        }
                        raise_workspace_windows(ws_id, &project_cache);
                    }
                    apps_raised = true;
                }
                dashboard_raised = false;
            } else {
                dashboard_raised = false;
                apps_raised = false;
            }
        }
    });
}

#[tauri::command]
pub fn workspace_focus(
    workspace_id: String,
    app_handle: tauri::AppHandle,
    active_state: tauri::State<'_, ActiveWorkspaceState>,
    project_cache: tauri::State<'_, ProjectCache>,
    focus_state: tauri::State<'_, FocusManagementState>,
) -> Result<(), String> {
    // In full-editor mode, external window management is disabled.
    // The frontend adapter already guards this, but we check here as
    // defense in depth.
    if !focus_state.0.load(std::sync::atomic::Ordering::SeqCst) {
        return Ok(());
    }

    use std::sync::Mutex;
    use std::time::Instant;

    static LAST_CALL: Mutex<Option<Instant>> = Mutex::new(None);
    let mut last = LAST_CALL.lock().unwrap();
    if let Some(t) = *last {
        if t.elapsed() < Duration::from_millis(500) {
            log_debug("workspace_focus: debounced (too soon after last call)");
            return Ok(());
        }
    }
    *last = Some(Instant::now());
    drop(last);

    // Try cache first, then refresh from API on miss
    let app_state = project_cache
        .get()
        .or_else(|| refresh_project_cache(&project_cache))
        .ok_or("Project state not available yet")?;

    let (wt_path, proj_path, ws_id) =
        if let Some((proj, wt)) = find_workspace(&workspace_id, &app_state) {
            (wt.path.clone(), proj.path.clone(), workspace_id.clone())
        } else {
            let fresh = refresh_project_cache(&project_cache)
                .ok_or(format!("Workspace '{workspace_id}' not found"))?;
            if let Some((proj, wt)) = find_workspace(&workspace_id, &fresh) {
                (wt.path.clone(), proj.path.clone(), workspace_id.clone())
            } else {
                return Err(format!("Workspace '{workspace_id}' not found"));
            }
        };

    let folder_name = Path::new(&wt_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();

    // Load apps config for this workspace
    let app_configs = apps::load_apps_config(&wt_path, &proj_path);

    if app_configs.is_empty() {
        return Err("IDE not configured: no apps defined in config".to_string());
    }

    log_debug(&format!(
        "workspace_focus: id={ws_id}, folder_name={folder_name}, apps={}",
        app_configs.len()
    ));

    // Get screen size for layout computation
    let (screen_width, screen_height) =
        ax_windows::get_screen_size().ok_or("Failed to get screen size")?;

    // Get actual dashboard window width
    let dashboard_width = app_handle
        .get_webview_window("main")
        .and_then(|w| {
            let scale = w.scale_factor().unwrap_or(1.0);
            w.outer_size()
                .ok()
                .map(|s| (f64::from(s.width) / scale) as i32)
        })
        .unwrap_or(400);

    // Compute layout for all apps
    let rects = apps::compute_layout(&app_configs, screen_width, screen_height, dashboard_width);

    // Open/focus each app in its own thread so slow apps
    // (e.g. iTerm AppleScript) don't block the UI.
    let wm = WindowManager::global();
    for (i, app_config) in app_configs.iter().enumerate() {
        if let Some(handler) = apps::get_handler(app_config.app_type()) {
            let config_json = app_config.to_json();
            let rect = rects[i].clone();
            let ws = ws_id.clone();
            let folder = folder_name.clone();
            let path = wt_path.clone();
            let app_type = app_config.app_type().to_string();
            std::thread::spawn(move || {
                let launched = match wm.open_or_focus(handler, &path, &ws, &folder, &config_json) {
                    Ok(v) => v,
                    Err(e) => {
                        log_debug(&format!("Failed to open {app_type}: {e}"));
                        return;
                    }
                };
                if let Err(e) =
                    wm.position_window(handler.app_type(), handler.display_name(), &ws, &rect)
                {
                    log_debug(&format!("Failed to position {app_type}: {e}"));
                }
                if launched {
                    if let Err(e) = handler.setup(&path, &folder, &config_json) {
                        log_debug(&format!("Failed to setup {app_type}: {e}"));
                    }
                }
            });
        }
    }

    // Track the active workspace
    set_active_workspace(&active_state.0, &ws_id);

    Ok(())
}

/// Close all windows associated with a workspace.
#[tauri::command]
pub fn workspace_close(
    workspace_id: String,
    _project_cache: tauri::State<'_, ProjectCache>,
) -> Result<(), String> {
    if workspace_id.is_empty() {
        return Ok(());
    }

    let wm = WindowManager::global();
    wm.close_all_for_workspace(&workspace_id)
}

/// Return the currently active workspace ID from in-memory state.
#[tauri::command]
pub fn get_active_workspace(
    active_state: tauri::State<'_, ActiveWorkspaceState>,
) -> Result<Option<String>, String> {
    Ok(active_state.0.lock().ok().and_then(|guard| guard.clone()))
}

/// Detect the frontmost window and map it to a workspace ID using native APIs.
#[tauri::command]
pub fn detect_active_workspace(
    active_state: tauri::State<'_, ActiveWorkspaceState>,
    project_cache: tauri::State<'_, ProjectCache>,
) -> Result<Option<String>, String> {
    let Some(cached) = project_cache.get() else {
        return Ok(None);
    };
    if let Some(ws_id) = detect_frontmost_workspace(&cached) {
        set_active_workspace(&active_state.0, &ws_id);
        return Ok(Some(ws_id));
    }
    Ok(None)
}

#[tauri::command]
pub fn pick_folder() -> Result<Option<String>, String> {
    let output = std::process::Command::new("osascript")
        .args([
            "-e",
            r#"set theFolder to choose folder with prompt "Select a git repository"
return POSIX path of theFolder"#,
        ])
        .output()
        .map_err(|e| format!("Failed to open folder picker: {e}"))?;

    if output.status.success() {
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if path.is_empty() {
            Ok(None)
        } else {
            Ok(Some(path))
        }
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub fn reveal_in_finder(path: String) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(&path)
        .output()
        .map_err(|e| format!("Failed to open Finder: {e}"))?;
    Ok(())
}

/// Checks whether a macOS application is installed by looking in common
/// locations (/Applications, /System/Applications, ~/Applications) and
/// falling back to `which` for CLI tools.
#[tauri::command]
pub fn check_app_exists(app_name: String) -> bool {
    let mut locations = vec![
        format!("/Applications/{app_name}.app"),
        format!("/System/Applications/{app_name}.app"),
    ];

    if let Ok(home) = std::env::var("HOME") {
        locations.push(format!("{home}/Applications/{app_name}.app"));
    }

    for location in &locations {
        if std::path::Path::new(location).exists() {
            return true;
        }
    }

    // Fallback: check if a CLI binary exists in PATH
    std::process::Command::new("which")
        .arg(&app_name)
        .output()
        .map_or(false, |output| output.status.success())
}

/// Opens a path with a specific macOS application.
#[tauri::command]
pub fn open_with_app(path: String, app_name: String) -> Result<(), String> {
    std::process::Command::new("open")
        .arg("-a")
        .arg(&app_name)
        .arg(&path)
        .output()
        .map_err(|e| format!("Failed to open with {app_name}: {e}"))?;
    Ok(())
}
