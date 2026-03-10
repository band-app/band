use std::collections::HashMap;
use std::ffi::{c_void, CStr, CString};
use std::sync::{LazyLock, Mutex};

use crate::state;

// --- Constants ---

pub const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
pub const PROC_ALL_PIDS: u32 = 1;
pub const PROC_PIDTBSDINFO: i32 = 3;
pub const PROC_PIDVNODEPATHINFO: i32 = 9;

const K_CG_WINDOW_LIST_OPTION_ON_SCREEN_ONLY: u32 = 1;
const K_CG_WINDOW_LIST_EXCLUDE_DESKTOP_ELEMENTS: u32 = 1 << 4;
const K_CG_NULL_WINDOW_ID: u32 = 0;

// --- FFI: Accessibility + CoreFoundation ---

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    pub fn AXUIElementCreateSystemWide() -> *const c_void;
    pub fn AXUIElementCreateApplication(pid: i32) -> *const c_void;
    pub fn AXUIElementCopyAttributeValue(
        element: *const c_void,
        attribute: *const c_void,
        value: *mut *const c_void,
    ) -> i32;
    pub fn AXUIElementSetAttributeValue(
        element: *const c_void,
        attribute: *const c_void,
        value: *const c_void,
    ) -> i32;
    pub fn AXUIElementPerformAction(element: *const c_void, action: *const c_void) -> i32;
    pub fn AXUIElementGetPid(element: *const c_void, pid: *mut i32) -> i32;
    pub fn AXIsProcessTrustedWithOptions(options: *const c_void) -> bool;
    fn AXValueCreate(value_type: u32, value: *const c_void) -> *const c_void;
    fn _AXUIElementGetWindow(element: *const c_void, window_id: *mut u32) -> i32;
}

// --- FFI: CoreGraphics ---

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGWindowListCopyWindowInfo(option: u32, relative_to: u32) -> *const c_void;
    fn CGMainDisplayID() -> u32;
    fn CGDisplayBounds(display: u32) -> CGRect;
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
struct CGPoint {
    x: f64,
    y: f64,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
struct CGSize {
    width: f64,
    height: f64,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
struct CGRect {
    origin: CGPoint,
    size: CGSize,
}

// AXValueType constants
const K_AX_VALUE_CG_POINT_TYPE: u32 = 1;
const K_AX_VALUE_CG_SIZE_TYPE: u32 = 2;

// --- FFI: CoreFoundation ---

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    pub fn CFRelease(cf: *const c_void);
    pub fn CFStringCreateWithCString(
        alloc: *const c_void,
        c_str: *const i8,
        encoding: u32,
    ) -> *const c_void;
    pub fn CFStringGetCString(
        the_string: *const c_void,
        buffer: *mut i8,
        buffer_size: i64,
        encoding: u32,
    ) -> u8;
    pub fn CFStringGetLength(the_string: *const c_void) -> i64;
    pub fn CFDictionaryCreate(
        allocator: *const c_void,
        keys: *const *const c_void,
        values: *const *const c_void,
        count: i64,
        key_callbacks: *const c_void,
        value_callbacks: *const c_void,
    ) -> *const c_void;
    pub static kCFBooleanTrue: *const c_void;
    pub static kCFTypeDictionaryKeyCallBacks: c_void;
    pub static kCFTypeDictionaryValueCallBacks: c_void;

    fn CFArrayGetCount(array: *const c_void) -> i64;
    fn CFArrayGetValueAtIndex(array: *const c_void, idx: i64) -> *const c_void;
    fn CFDictionaryGetValue(dict: *const c_void, key: *const c_void) -> *const c_void;
    fn CFNumberGetValue(number: *const c_void, the_type: i32, value_ptr: *mut c_void) -> bool;
    fn CFGetTypeID(cf: *const c_void) -> u64;
    fn CFStringGetTypeID() -> u64;
}

// CFNumberType
const K_CF_NUMBER_INT32_TYPE: i32 = 3;
const K_CF_NUMBER_INT64_TYPE: i32 = 4;

// --- FFI: libproc ---

extern "C" {
    pub fn proc_listpids(type_: u32, typeinfo: u32, buffer: *mut c_void, buffersize: i32) -> i32;
    pub fn proc_pidinfo(
        pid: i32,
        flavor: i32,
        arg: u64,
        buffer: *mut c_void,
        buffersize: i32,
    ) -> i32;
}

// --- FFI: Objective-C runtime ---

#[link(name = "objc", kind = "dylib")]
extern "C" {
    pub fn objc_getClass(name: *const i8) -> *const c_void;
    pub fn objc_msgSend();
    pub fn sel_registerName(name: *const i8) -> *const c_void;
}

// --- CoreFoundation string helpers ---

pub unsafe fn cfstr(s: &str) -> *const c_void {
    let c = CString::new(s).unwrap();
    CFStringCreateWithCString(std::ptr::null(), c.as_ptr(), K_CF_STRING_ENCODING_UTF8)
}

pub unsafe fn cfstring_to_string(cf: *const c_void) -> Option<String> {
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

// --- Accessibility permission check ---

pub fn check_accessibility() -> bool {
    use std::sync::atomic::{AtomicU8, Ordering};
    static STATE: AtomicU8 = AtomicU8::new(0);

    let prev = STATE.load(Ordering::Relaxed);

    let trusted = unsafe {
        if prev == 0 {
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

// --- Frontmost window (for focus tracking) ---

pub fn get_frontmost_window() -> Option<(i32, String)> {
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

/// Like `get_frontmost_window` but also returns the `CGWindowID` of the focused window.
pub fn get_frontmost_window_with_id() -> Option<(i32, Option<u32>, String)> {
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
            return Some((pid, None, String::new()));
        }

        // Get CGWindowID via private API
        let mut cg_id: u32 = 0;
        let cg_id_opt = if _AXUIElementGetWindow(focused_window, &raw mut cg_id) == 0 && cg_id != 0
        {
            Some(cg_id)
        } else {
            None
        };

        let attr = cfstr("AXTitle");
        let mut title_ref: *const c_void = std::ptr::null();
        let err = AXUIElementCopyAttributeValue(focused_window, attr, &raw mut title_ref);
        CFRelease(attr);
        CFRelease(focused_window);

        if err != 0 || title_ref.is_null() {
            return Some((pid, cg_id_opt, String::new()));
        }

        let title = cfstring_to_string(title_ref).unwrap_or_default();
        CFRelease(title_ref);

        Some((pid, cg_id_opt, title))
    }
}

/// Look up a `CGWindowID` in the registry and return the matching key.
pub fn find_workspace_by_cg_id(cg_id: u32) -> Option<(String, String)> {
    let map = WINDOW_REGISTRY.lock().unwrap();
    for (key, entry) in map.iter() {
        if entry.cg_window_id == cg_id {
            if let Some((app_type, folder_name)) = key.split_once(':') {
                return Some((app_type.to_string(), folder_name.to_string()));
            }
        }
    }
    None
}

// --- Bundle ID lookup via NSRunningApplication ---

pub fn get_bundle_id(pid: i32) -> Option<String> {
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

// --- CGWindowList: enumerate windows ---

/// Info about a window from `CGWindowListCopyWindowInfo`.
#[derive(Debug, Clone)]
pub struct WindowInfo {
    pub pid: i32,
    pub cg_window_id: u32,
    pub title: String,
}

/// List all on-screen windows for a given bundle ID.
#[allow(clippy::similar_names)]
pub fn list_windows_for_bundle(bundle_id: &str) -> Vec<WindowInfo> {
    let mut results = Vec::new();

    unsafe {
        let list = CGWindowListCopyWindowInfo(
            K_CG_WINDOW_LIST_OPTION_ON_SCREEN_ONLY | K_CG_WINDOW_LIST_EXCLUDE_DESKTOP_ELEMENTS,
            K_CG_NULL_WINDOW_ID,
        );
        if list.is_null() {
            return results;
        }

        let count = CFArrayGetCount(list);
        let key_pid = cfstr("kCGWindowOwnerPID");
        let key_wid = cfstr("kCGWindowNumber");
        let key_name = cfstr("kCGWindowName");
        let key_layer = cfstr("kCGWindowLayer");

        for i in 0..count {
            let dict = CFArrayGetValueAtIndex(list, i);
            if dict.is_null() {
                continue;
            }

            // Filter to layer 0 (normal windows)
            let layer_val = CFDictionaryGetValue(dict, key_layer);
            if !layer_val.is_null() {
                let mut layer: i32 = 0;
                CFNumberGetValue(
                    layer_val,
                    K_CF_NUMBER_INT32_TYPE,
                    (&raw mut layer).cast::<c_void>(),
                );
                if layer != 0 {
                    continue;
                }
            }

            let pid_val = CFDictionaryGetValue(dict, key_pid);
            if pid_val.is_null() {
                continue;
            }
            let mut pid: i64 = 0;
            CFNumberGetValue(
                pid_val,
                K_CF_NUMBER_INT64_TYPE,
                (&raw mut pid).cast::<c_void>(),
            );

            // Check bundle ID matches
            if let Some(bid) = get_bundle_id(pid as i32) {
                if bid != bundle_id {
                    continue;
                }
            } else {
                continue;
            }

            let wid_val = CFDictionaryGetValue(dict, key_wid);
            if wid_val.is_null() {
                continue;
            }
            let mut wid: i32 = 0;
            CFNumberGetValue(
                wid_val,
                K_CF_NUMBER_INT32_TYPE,
                (&raw mut wid).cast::<c_void>(),
            );

            let title = {
                let name_val = CFDictionaryGetValue(dict, key_name);
                if !name_val.is_null() && CFGetTypeID(name_val) == CFStringGetTypeID() {
                    cfstring_to_string(name_val).unwrap_or_default()
                } else {
                    String::new()
                }
            };

            results.push(WindowInfo {
                pid: pid as i32,
                cg_window_id: wid as u32,
                title,
            });
        }

        CFRelease(key_pid);
        CFRelease(key_wid);
        CFRelease(key_name);
        CFRelease(key_layer);
        CFRelease(list);
    }

    results
}

/// Find the first window whose title contains the given substring.
pub fn find_window_by_title(bundle_id: &str, title_contains: &str) -> Option<WindowInfo> {
    list_windows_for_bundle(bundle_id)
        .into_iter()
        .find(|w| w.title.contains(title_contains))
}

/// Get all current `CGWindowID`s for a bundle (used for snapshot-diff discovery).
pub fn snapshot_window_ids(bundle_id: &str) -> Vec<u32> {
    list_windows_for_bundle(bundle_id)
        .iter()
        .map(|w| w.cg_window_id)
        .collect()
}

/// Wait for a new window to appear that wasn't in `existing_ids`.
/// Optionally filter by title substring.
/// Returns the first new window found, or None on timeout.
pub fn await_new_window(
    bundle_id: &str,
    title_match: Option<&str>,
    existing_ids: &[u32],
    timeout_ms: u64,
) -> Option<WindowInfo> {
    let start = std::time::Instant::now();
    let timeout = std::time::Duration::from_millis(timeout_ms);

    loop {
        let windows = list_windows_for_bundle(bundle_id);
        for w in &windows {
            if existing_ids.contains(&w.cg_window_id) {
                continue;
            }
            if let Some(tm) = title_match {
                if !w.title.contains(tm) {
                    continue;
                }
            }
            return Some(w.clone());
        }

        if start.elapsed() >= timeout {
            return None;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
}

// --- AX window operations ---

/// Find the `AXUIElementRef` for a specific window by matching its `CGWindowID`.
/// Caller must `CFRelease` the returned element.
unsafe fn find_ax_window(pid: i32, cg_id: u32) -> Option<*const c_void> {
    let app = AXUIElementCreateApplication(pid);
    if app.is_null() {
        return None;
    }

    let attr = cfstr("AXWindows");
    let mut windows: *const c_void = std::ptr::null();
    let err = AXUIElementCopyAttributeValue(app, attr, &raw mut windows);
    CFRelease(attr);

    if err != 0 || windows.is_null() {
        CFRelease(app);
        return None;
    }

    let count = CFArrayGetCount(windows);
    let mut found: Option<*const c_void> = None;

    for i in 0..count {
        let ax_win = CFArrayGetValueAtIndex(windows, i);
        if ax_win.is_null() {
            continue;
        }

        let mut wid: u32 = 0;
        let err = _AXUIElementGetWindow(ax_win, &raw mut wid);
        if err == 0 && wid == cg_id {
            // We need to retain this since the array owns it.
            // CFRetain to keep it alive after we release the array.
            CFRetain(ax_win);
            found = Some(ax_win);
            break;
        }
    }

    CFRelease(windows);
    CFRelease(app);
    found
}

extern "C" {
    fn CFRetain(cf: *const c_void) -> *const c_void;
}

/// Position a window by `CGWindowID` using AX APIs.
pub fn position_window(pid: i32, cg_id: u32, x: i32, y: i32, w: i32, h: i32) -> bool {
    if !check_accessibility() {
        return false;
    }

    unsafe {
        let Some(ax_win) = find_ax_window(pid, cg_id) else {
            return false;
        };

        let point = CGPoint {
            x: x as f64,
            y: y as f64,
        };
        let size = CGSize {
            width: w as f64,
            height: h as f64,
        };

        let pos_attr = cfstr("AXPosition");
        let size_attr = cfstr("AXSize");

        let pos_val = AXValueCreate(
            K_AX_VALUE_CG_POINT_TYPE,
            (&raw const point).cast::<c_void>(),
        );
        let size_val = AXValueCreate(K_AX_VALUE_CG_SIZE_TYPE, (&raw const size).cast::<c_void>());

        let mut ok = true;
        if pos_val.is_null() {
            ok = false;
        } else {
            if AXUIElementSetAttributeValue(ax_win, pos_attr, pos_val) != 0 {
                ok = false;
            }
            CFRelease(pos_val);
        }

        if size_val.is_null() {
            ok = false;
        } else {
            if AXUIElementSetAttributeValue(ax_win, size_attr, size_val) != 0 {
                ok = false;
            }
            CFRelease(size_val);
        }

        CFRelease(pos_attr);
        CFRelease(size_attr);
        CFRelease(ax_win);
        ok
    }
}

/// Raise a single window without activating the app (`AXRaise` only).
pub fn raise_window(pid: i32, cg_id: u32) -> bool {
    if !check_accessibility() {
        return false;
    }

    unsafe {
        let Some(ax_win) = find_ax_window(pid, cg_id) else {
            return false;
        };

        let action = cfstr("AXRaise");
        let err = AXUIElementPerformAction(ax_win, action);
        CFRelease(action);
        CFRelease(ax_win);
        err == 0
    }
}

/// Activate the application (bring it to foreground).
/// Uses NSRunningApplication.activateWithOptions.
pub fn activate_app(pid: i32) {
    unsafe {
        type MsgSendPid = unsafe extern "C" fn(*const c_void, *const c_void, i32) -> *const c_void;
        type MsgSendActivate = unsafe extern "C" fn(*const c_void, *const c_void, u64) -> bool;

        let msg_pid: MsgSendPid = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        let msg_activate: MsgSendActivate =
            std::mem::transmute(objc_msgSend as unsafe extern "C" fn());

        let cls = objc_getClass(c"NSRunningApplication".as_ptr());
        if cls.is_null() {
            return;
        }

        let sel = sel_registerName(c"runningApplicationWithProcessIdentifier:".as_ptr());
        let app = msg_pid(cls, sel, pid);
        if app.is_null() {
            return;
        }

        // NSApplicationActivateIgnoringOtherApps = 1 << 1 = 2
        let sel = sel_registerName(c"activateWithOptions:".as_ptr());
        msg_activate(app, sel, 2);
    }
}

/// Focus a window: raise it + activate the app.
pub fn focus_window(pid: i32, cg_id: u32) -> bool {
    let raised = raise_window(pid, cg_id);
    if raised {
        activate_app(pid);
    }
    raised
}

// --- Screen size ---

/// Get screen size via `CGDisplayBounds`.
pub fn get_screen_size() -> Option<(i32, i32)> {
    unsafe {
        let display = CGMainDisplayID();
        let bounds = CGDisplayBounds(display);
        let w = bounds.size.width as i32;
        let h = bounds.size.height as i32;
        if w > 0 && h > 0 {
            Some((w, h))
        } else {
            None
        }
    }
}

// --- Window Registry (in-memory + persisted to disk) ---

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct WindowEntry {
    pub pid: i32,
    pub cg_window_id: u32,
}

/// On-disk format: map of `"app_type:folder_name"` to `WindowEntry`.
type RegistryMap = HashMap<String, WindowEntry>;

static WINDOW_REGISTRY: LazyLock<Mutex<RegistryMap>> =
    LazyLock::new(|| Mutex::new(load_registry()));

fn registry_path() -> std::path::PathBuf {
    state::band_home().join("status").join("window-registry.json")
}

fn load_registry() -> RegistryMap {
    let path = registry_path();
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|data| serde_json::from_str(&data).ok())
        .unwrap_or_default()
}

fn save_registry(map: &RegistryMap) {
    let path = registry_path();
    if let Ok(data) = serde_json::to_string(map) {
        let _ = std::fs::write(path, data);
    }
}

fn registry_key(app_type: &str, folder_name: &str) -> String {
    format!("{app_type}:{folder_name}")
}

/// Register a window in the centralized registry (memory + disk).
pub fn register_window(app_type: &str, folder_name: &str, pid: i32, cg_id: u32) {
    let mut map = WINDOW_REGISTRY.lock().unwrap();
    map.insert(
        registry_key(app_type, folder_name),
        WindowEntry {
            pid,
            cg_window_id: cg_id,
        },
    );
    save_registry(&map);
}

/// Look up a registered window.
pub fn get_window(app_type: &str, folder_name: &str) -> Option<WindowEntry> {
    WINDOW_REGISTRY
        .lock()
        .unwrap()
        .get(&registry_key(app_type, folder_name))
        .cloned()
}

/// Remove a window from the registry (memory + disk).
pub fn unregister_window(app_type: &str, folder_name: &str) {
    let mut map = WINDOW_REGISTRY.lock().unwrap();
    map.remove(&registry_key(app_type, folder_name));
    save_registry(&map);
}

/// Check if a registered window is still valid (its `CGWindowID` still exists on screen).
pub fn is_window_valid(app_type: &str, folder_name: &str, bundle_id: &str) -> bool {
    let Some(entry) = get_window(app_type, folder_name) else {
        return false;
    };

    let windows = list_windows_for_bundle(bundle_id);
    windows.iter().any(|w| w.cg_window_id == entry.cg_window_id)
}
