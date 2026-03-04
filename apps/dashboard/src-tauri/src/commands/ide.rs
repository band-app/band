use crate::state;
use std::collections::{HashMap, VecDeque};
use std::ffi::{c_void, CStr, CString};
use std::path::{Path, PathBuf};
use std::time::Duration;

const DASHBOARD_WIDTH: i32 = 400;

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
}

extern "C" {
    fn proc_listpids(type_: u32, typeinfo: u32, buffer: *mut c_void, buffersize: i32) -> i32;
    fn proc_pidinfo(
        pid: i32,
        flavor: i32,
        arg: u64,
        buffer: *mut c_void,
        buffersize: i32,
    ) -> i32;
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
    if CFStringGetCString(cf, buf.as_mut_ptr(), buf_size as i64, K_CF_STRING_ENCODING_UTF8) != 0 {
        Some(CStr::from_ptr(buf.as_ptr()).to_string_lossy().into_owned())
    } else {
        None
    }
}

// --- Accessibility API: get frontmost window PID + title ---

fn get_frontmost_window() -> Option<(i32, String)> {
    unsafe {
        let system_wide = AXUIElementCreateSystemWide();
        if system_wide.is_null() {
            return None;
        }

        let attr = cfstr("AXFocusedApplication");
        let mut focused_app: *const c_void = std::ptr::null();
        let err = AXUIElementCopyAttributeValue(system_wide, attr, &mut focused_app);
        CFRelease(attr);
        CFRelease(system_wide);

        if err != 0 || focused_app.is_null() {
            return None;
        }

        let mut pid: i32 = 0;
        if AXUIElementGetPid(focused_app, &mut pid) != 0 {
            CFRelease(focused_app);
            return None;
        }

        let attr = cfstr("AXFocusedWindow");
        let mut focused_window: *const c_void = std::ptr::null();
        let err = AXUIElementCopyAttributeValue(focused_app, attr, &mut focused_window);
        CFRelease(attr);
        CFRelease(focused_app);

        if err != 0 || focused_window.is_null() {
            return Some((pid, String::new()));
        }

        let attr = cfstr("AXTitle");
        let mut title_ref: *const c_void = std::ptr::null();
        let err = AXUIElementCopyAttributeValue(focused_window, attr, &mut title_ref);
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
            pids.as_mut_ptr() as *mut c_void,
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

fn get_ppid(pid: i32) -> Option<i32> {
    unsafe {
        let mut buf = [0u8; 256]; // proc_bsdinfo is ~136 bytes
        let ret = proc_pidinfo(
            pid,
            PROC_PIDTBSDINFO,
            0,
            buf.as_mut_ptr() as *mut c_void,
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
            buf.as_mut_ptr() as *mut c_void,
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

    // Build parent → children map
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

fn match_cwds_to_workspace(cwds: &[PathBuf]) -> Option<String> {
    let app_state = state::load_state().ok()?;
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

/// Write the active workspace marker file.
pub fn write_active_marker(workspace_id: &str) {
    let active_file = state::status_dir().join("active.json");
    let _ = std::fs::write(
        active_file,
        format!("{{\"workspaceId\":\"{}\"}}", workspace_id),
    );
}

/// Match a window title to a workspace ID.
/// Uses the folder name from the worktree path (last path component),
/// which VS Code always includes in its window title.
fn match_title_to_workspace(title: &str) -> Option<String> {
    let app_state = state::load_state().ok()?;
    let mut best_match: Option<(String, usize)> = None;

    for proj in &app_state.projects {
        for wt in &proj.worktrees {
            let folder_name = Path::new(&wt.path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");

            if !folder_name.is_empty() && title.contains(folder_name) {
                let ws_id = format!("{}-{}", proj.name, wt.branch);
                // Prefer the longest folder name match to avoid "app" matching "my-app"
                if best_match
                    .as_ref()
                    .map_or(true, |(_, len)| folder_name.len() > *len)
                {
                    best_match = Some((ws_id, folder_name.len()));
                }
            }
        }
    }

    best_match.map(|(id, _)| id)
}

/// Detect the frontmost workspace using native macOS APIs.
/// 1. Get frontmost window PID + title via Accessibility API
/// 2. Try CWD matching on descendant processes (works for any app)
/// 3. Fall back to window title matching
fn detect_frontmost_workspace() -> Option<String> {
    let (pid, title) = get_frontmost_window()?;

    // Skip if frontmost app is our own process
    if pid as u32 == std::process::id() {
        return None;
    }

    // Try CWD-based matching first (generic, works for any app)
    let cwds = get_descendant_cwds(pid);
    if let Some(ws_id) = match_cwds_to_workspace(&cwds) {
        return Some(ws_id);
    }

    // Fall back to window title matching
    if !title.is_empty() {
        return match_title_to_workspace(&title);
    }

    None
}

/// Start a background thread that polls the frontmost window
/// and updates active.json when the focused workspace changes.
pub fn start_focus_polling() {
    std::thread::spawn(|| {
        let mut last_active: Option<String> = None;
        loop {
            std::thread::sleep(Duration::from_secs(1));

            if let Some(ws_id) = detect_frontmost_workspace() {
                if last_active.as_deref() != Some(ws_id.as_str()) {
                    last_active = Some(ws_id.clone());
                    write_active_marker(&ws_id);
                }
            }
        }
    });
}

/// Use AppleScript + System Events to position the VS Code window
/// to fill the screen to the right of the dashboard.
pub fn align_vscode_window(branch: &str) {
    let branch = branch.to_string();
    std::thread::spawn(move || {
        let script = format!(
            r#"
tell application "Finder"
    set screenBounds to bounds of window of desktop
end tell
set screenWidth to item 3 of screenBounds
set screenHeight to item 4 of screenBounds

set dashWidth to {dashboard_width}
set vsW to screenWidth - dashWidth
set vsH to screenHeight

delay 0.5

tell application "System Events"
    tell (first process whose bundle identifier is "com.microsoft.VSCode")
        set foundWindow to false
        repeat with w in windows
            if title of w contains "{branch}" then
                set position of w to {{dashWidth, 0}}
                set size of w to {{vsW, vsH}}
                set foundWindow to true
                exit repeat
            end if
        end repeat
        if not foundWindow then
            if (count of windows) > 0 then
                set position of window 1 to {{dashWidth, 0}}
                set size of window 1 to {{vsW, vsH}}
            end if
        end if
    end tell
end tell
"#,
            dashboard_width = DASHBOARD_WIDTH,
            branch = branch
        );

        let _ = std::process::Command::new("osascript")
            .args(["-e", &script])
            .output();
    });
}

#[tauri::command]
pub fn workspace_focus(workspace_id: String) -> Result<(), String> {
    let app_state = state::load_state()?;

    for proj in &app_state.projects {
        for wt in &proj.worktrees {
            let ws_id = format!("{}-{}", proj.name, wt.branch);
            if ws_id == workspace_id {
                // Focus VS Code window with matching folder
                let script = format!(
                    r#"tell application "Visual Studio Code"
    activate
    set foundWindow to false
    repeat with w in windows
        if name of w contains "{}" then
            set index of w to 1
            set foundWindow to true
            exit repeat
        end if
    end repeat
    if not foundWindow then
        do shell script "code '{}'"
    end if
end tell"#,
                    wt.branch, wt.path
                );

                std::process::Command::new("osascript")
                    .args(["-e", &script])
                    .output()
                    .map_err(|e| format!("Failed to focus window: {}", e))?;

                // Track the active workspace
                write_active_marker(&ws_id);

                // Resize and position the window to the right of the dashboard
                align_vscode_window(&wt.branch);

                return Ok(());
            }
        }
    }

    Err(format!("Workspace '{}' not found", workspace_id))
}

/// Return the currently active workspace ID by reading the marker file.
#[tauri::command]
pub fn get_active_workspace() -> Result<Option<String>, String> {
    let active_file = state::status_dir().join("active.json");
    let data = match std::fs::read_to_string(&active_file) {
        Ok(d) => d,
        Err(_) => return Ok(None),
    };

    #[derive(serde::Deserialize)]
    struct ActiveMarker {
        #[serde(rename = "workspaceId")]
        workspace_id: String,
    }

    match serde_json::from_str::<ActiveMarker>(&data) {
        Ok(marker) => Ok(Some(marker.workspace_id)),
        Err(_) => Ok(None),
    }
}

/// Detect the frontmost window and map it to a workspace ID using native APIs.
#[tauri::command]
pub fn detect_active_workspace() -> Result<Option<String>, String> {
    if let Some(ws_id) = detect_frontmost_workspace() {
        write_active_marker(&ws_id);
        return Ok(Some(ws_id));
    }
    Ok(None)
}

#[tauri::command]
pub fn pick_folder() -> Result<Option<String>, String> {
    // Use native macOS dialog via AppleScript
    let output = std::process::Command::new("osascript")
        .args([
            "-e",
            r#"set theFolder to choose folder with prompt "Select a git repository"
return POSIX path of theFolder"#,
        ])
        .output()
        .map_err(|e| format!("Failed to open folder picker: {}", e))?;

    if output.status.success() {
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if path.is_empty() {
            Ok(None)
        } else {
            Ok(Some(path))
        }
    } else {
        Ok(None) // User cancelled
    }
}
