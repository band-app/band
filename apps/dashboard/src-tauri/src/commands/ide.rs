use crate::api::ApiClient;
use crate::state;
use crate::state::{ActiveWorkspaceState, ProjectCache};
use std::collections::{HashMap, VecDeque};
use std::ffi::{c_void, CStr, CString};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::Manager;

use std::io::Write;

use super::apps;

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

// --- macOS native API FFI declarations ---

const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
const PROC_ALL_PIDS: u32 = 1;
const PROC_PIDTBSDINFO: i32 = 3;
const PROC_PIDVNODEPATHINFO: i32 = 9;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXUIElementCreateSystemWide() -> *const c_void;
    fn AXUIElementCopyAttributeValue(
        element: *const c_void,
        attribute: *const c_void,
        value: *mut *const c_void,
    ) -> i32;
    fn AXUIElementGetPid(element: *const c_void, pid: *mut i32) -> i32;
    fn AXIsProcessTrustedWithOptions(options: *const c_void) -> bool;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(cf: *const c_void);
    fn CFStringCreateWithCString(
        alloc: *const c_void,
        c_str: *const i8,
        encoding: u32,
    ) -> *const c_void;
    fn CFStringGetCString(
        the_string: *const c_void,
        buffer: *mut i8,
        buffer_size: i64,
        encoding: u32,
    ) -> u8;
    fn CFStringGetLength(the_string: *const c_void) -> i64;
    fn CFDictionaryCreate(
        allocator: *const c_void,
        keys: *const *const c_void,
        values: *const *const c_void,
        count: i64,
        key_callbacks: *const c_void,
        value_callbacks: *const c_void,
    ) -> *const c_void;
    static kCFBooleanTrue: *const c_void;
    static kCFTypeDictionaryKeyCallBacks: c_void;
    static kCFTypeDictionaryValueCallBacks: c_void;
}

extern "C" {
    fn proc_listpids(type_: u32, typeinfo: u32, buffer: *mut c_void, buffersize: i32) -> i32;
    fn proc_pidinfo(pid: i32, flavor: i32, arg: u64, buffer: *mut c_void, buffersize: i32) -> i32;
}

// --- Objective-C runtime for NSWindow manipulation ---

#[link(name = "objc", kind = "dylib")]
extern "C" {
    fn objc_getClass(name: *const i8) -> *const c_void;
    fn objc_msgSend();
    fn sel_registerName(name: *const i8) -> *const c_void;
}

// --- CoreFoundation string helpers ---

unsafe fn cfstr(s: &str) -> *const c_void {
    let c = CString::new(s).unwrap();
    CFStringCreateWithCString(std::ptr::null(), c.as_ptr(), K_CF_STRING_ENCODING_UTF8)
}

unsafe fn cfstring_to_string(cf: *const c_void) -> Option<String> {
    if cf.is_null() {
        return None;
    }
    let len = CFStringGetLength(cf);
    if len <= 0 {
        return Some(String::new());
    }
    let buf_size = (len * 4 + 1) as usize;
    let mut buf = vec![0i8; buf_size];
    if CFStringGetCString(
        cf,
        buf.as_mut_ptr(),
        buf_size as i64,
        K_CF_STRING_ENCODING_UTF8,
    ) != 0
    {
        Some(CStr::from_ptr(buf.as_ptr()).to_string_lossy().into_owned())
    } else {
        None
    }
}

// --- Accessibility API: get frontmost window PID + title ---

/// Prompt for Accessibility permission on first launch, then check periodically.
fn check_accessibility() -> bool {
    use std::sync::atomic::{AtomicU8, Ordering};
    // 0 = unchecked, 1 = trusted, 2 = not trusted (prompted)
    static STATE: AtomicU8 = AtomicU8::new(0);

    let prev = STATE.load(Ordering::Relaxed);

    let trusted = unsafe {
        if prev == 0 {
            // First check: show the macOS Accessibility prompt if not trusted
            let key = cfstr("AXTrustedCheckOptionPrompt");
            let keys = [key];
            let values = [kCFBooleanTrue];
            let opts = CFDictionaryCreate(
                std::ptr::null(),
                keys.as_ptr(),
                values.as_ptr(),
                1,
                &raw const kCFTypeDictionaryKeyCallBacks,
                &raw const kCFTypeDictionaryValueCallBacks,
            );
            let result = AXIsProcessTrustedWithOptions(opts);
            CFRelease(key);
            if !opts.is_null() {
                CFRelease(opts);
            }
            result
        } else {
            // Subsequent checks: no prompt
            AXIsProcessTrustedWithOptions(std::ptr::null())
        }
    };

    let new = if trusted { 1 } else { 2 };
    if prev != new {
        STATE.store(new, Ordering::Relaxed);
        if trusted {
            eprintln!("[band] Accessibility permission: granted");
        } else {
            eprintln!("[band] Accessibility permission: NOT granted — focus tracking and window management disabled");
        }
    }
    trusted
}

fn get_frontmost_window() -> Option<(i32, String)> {
    if !check_accessibility() {
        return None;
    }

    unsafe {
        let system_wide = AXUIElementCreateSystemWide();
        if system_wide.is_null() {
            return None;
        }

        let attr = cfstr("AXFocusedApplication");
        let mut focused_app: *const c_void = std::ptr::null();
        let err = AXUIElementCopyAttributeValue(system_wide, attr, &raw mut focused_app);
        CFRelease(attr);
        CFRelease(system_wide);

        if err != 0 || focused_app.is_null() {
            return None;
        }

        let mut pid: i32 = 0;
        if AXUIElementGetPid(focused_app, &raw mut pid) != 0 {
            CFRelease(focused_app);
            return None;
        }

        let attr = cfstr("AXFocusedWindow");
        let mut focused_window: *const c_void = std::ptr::null();
        let err = AXUIElementCopyAttributeValue(focused_app, attr, &raw mut focused_window);
        CFRelease(attr);
        CFRelease(focused_app);

        if err != 0 || focused_window.is_null() {
            return Some((pid, String::new()));
        }

        let attr = cfstr("AXTitle");
        let mut title_ref: *const c_void = std::ptr::null();
        let err = AXUIElementCopyAttributeValue(focused_window, attr, &raw mut title_ref);
        CFRelease(attr);
        CFRelease(focused_window);

        if err != 0 || title_ref.is_null() {
            return Some((pid, String::new()));
        }

        let title = cfstring_to_string(title_ref).unwrap_or_default();
        CFRelease(title_ref);

        Some((pid, title))
    }
}

// --- Bundle ID lookup via NSRunningApplication ---

fn get_bundle_id(pid: i32) -> Option<String> {
    unsafe {
        type MsgSendPid = unsafe extern "C" fn(*const c_void, *const c_void, i32) -> *const c_void;
        type MsgSend = unsafe extern "C" fn(*const c_void, *const c_void) -> *const c_void;

        let msg_pid: MsgSendPid = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        let msg: MsgSend = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());

        let cls = objc_getClass(c"NSRunningApplication".as_ptr());
        if cls.is_null() {
            return None;
        }

        let sel = sel_registerName(c"runningApplicationWithProcessIdentifier:".as_ptr());
        let app = msg_pid(cls, sel, pid);
        if app.is_null() {
            return None;
        }

        let sel = sel_registerName(c"bundleIdentifier".as_ptr());
        let bundle_id = msg(app, sel);
        if bundle_id.is_null() {
            return None;
        }

        cfstring_to_string(bundle_id)
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

fn match_cwds_to_workspace(cwds: &[PathBuf], app_state: &state::AppState) -> Option<String> {
    let mut matches = Vec::new();

    for proj in &app_state.projects {
        for wt in &proj.worktrees {
            let wt_path = PathBuf::from(&wt.path);
            for cwd in cwds {
                if cwd == &wt_path || cwd.starts_with(&wt_path) {
                    let ws_id = format!("{}-{}", proj.name, wt.branch);
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
fn workspace_info(workspace_id: &str, app_state: &state::AppState) -> Option<(String, String)> {
    for proj in &app_state.projects {
        for wt in &proj.worktrees {
            let ws_id = format!("{}-{}", proj.name, wt.branch);
            if ws_id == workspace_id {
                let folder_name = Path::new(&wt.path)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .to_string();
                return Some((wt.path.clone(), folder_name));
            }
        }
    }
    None
}

/// Detect the frontmost workspace using native macOS APIs.
fn detect_frontmost_workspace(app_state: &state::AppState) -> Option<String> {
    let (pid, title) = get_frontmost_window()?;

    // Skip if frontmost app is our own process
    if pid as u32 == std::process::id() {
        return None;
    }

    // Try CWD-based matching first (generic, works for any app)
    let cwds = get_descendant_cwds(pid);
    if let Some(ws_id) = match_cwds_to_workspace(&cwds, app_state) {
        return Some(ws_id);
    }

    // Fall back to window title matching for known managed apps
    if !title.is_empty() {
        if let Some(bundle_id) = get_bundle_id(pid) {
            let known = apps::all_known_bundle_ids();
            for (app_type, known_bundle_id) in &known {
                if bundle_id == *known_bundle_id {
                    if let Some(driver) = apps::get_driver(app_type) {
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
                                    let ws_id = format!("{}-{}", proj.name, wt.branch);
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
            let ws_id = format!("{}-{}", proj.name, wt.branch);
            if ws_id == workspace_id {
                return Some((proj, wt));
            }
        }
    }
    None
}

/// Clear `needs_attention` status by calling the web server API.
fn clear_needs_attention(workspace_id: &str, api: &ApiClient) {
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

    let msg: MsgSend = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    let msg_idx: MsgSendIdx = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    let msg_count: MsgSendCount = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());

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

    for i in 0..count {
        let win = msg_idx(windows, obj_at, i);
        if !win.is_null() {
            msg(win, raise);
        }
    }
}

/// Raise all workspace app windows.
pub fn raise_workspace_windows(workspace_id: &str, cache: &ProjectCache) {
    let Some(app_state) = cache.get() else {
        return;
    };
    let Some((worktree_path, folder_name)) = workspace_info(workspace_id, &app_state) else {
        return;
    };

    let app_configs = apps::load_apps_config(&worktree_path);

    for app_config in &app_configs {
        if let Some(driver) = apps::get_driver(app_config.app_type()) {
            driver.raise_window(&folder_name);
        }
    }
}

/// Start a background thread that polls the frontmost window
/// and updates active workspace state when the focused workspace changes.
pub fn start_focus_polling(app_handle: tauri::AppHandle) {
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

        loop {
            std::thread::sleep(Duration::from_millis(500));

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

            if let Some(ws_id) = detect_frontmost_workspace(&cached) {
                if let Some(ref client) = api {
                    clear_needs_attention(&ws_id, client);
                }

                if last_active.as_deref() != Some(ws_id.as_str()) {
                    last_active = Some(ws_id.clone());
                    set_active_workspace(&active_state, &ws_id);
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
    active_state: tauri::State<'_, ActiveWorkspaceState>,
    project_cache: tauri::State<'_, ProjectCache>,
) -> Result<(), String> {
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

    let (wt_path, ws_id) = if let Some((_proj, wt)) = find_workspace(&workspace_id, &app_state) {
        (wt.path.clone(), workspace_id.clone())
    } else {
        let fresh = refresh_project_cache(&project_cache)
            .ok_or(format!("Workspace '{workspace_id}' not found"))?;
        if let Some((_proj, wt)) = find_workspace(&workspace_id, &fresh) {
            (wt.path.clone(), workspace_id.clone())
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
    let app_configs = apps::load_apps_config(&wt_path);

    if app_configs.is_empty() {
        return Err("IDE not configured: no apps defined in config".to_string());
    }

    log_debug(&format!(
        "workspace_focus: id={ws_id}, folder_name={folder_name}, apps={}",
        app_configs.len()
    ));

    // Get screen size for layout computation
    let (screen_width, screen_height) =
        apps::get_screen_size().ok_or("Failed to get screen size")?;

    // Compute layout for all apps
    let sizes: Vec<f64> = app_configs.iter().map(apps::AppConfig::size).collect();
    let rects = apps::compute_layout(&sizes, screen_width, screen_height);

    // Open/focus each app and position its window
    for (i, app_config) in app_configs.iter().enumerate() {
        if let Some(driver) = apps::get_driver(app_config.app_type()) {
            let config_json = app_config.to_json();
            driver.open_or_focus(&wt_path, &folder_name, &config_json)?;

            // Position with a small delay to allow the window to appear
            let driver = apps::get_driver(app_config.app_type()).unwrap();
            let rect = rects[i].clone();
            let folder = folder_name.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(500));
                let _ = driver.position_window(&folder, &rect);
            });
        }
    }

    // Track the active workspace
    set_active_workspace(&active_state.0, &ws_id);

    Ok(())
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
