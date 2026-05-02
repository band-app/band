use std::fs::OpenOptions;
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::State;

use crate::state::{band_home, load_settings};

const DEFAULT_WEB_SERVER_PORT: u16 = 3456;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn resolve_web_dir() -> Result<std::path::PathBuf, String> {
    // 1. Dev only: CARGO_MANIFEST_DIR (compile-time).
    //    In release builds this is skipped so the DMG never accidentally
    //    picks up the source repo's dist/ folder.
    #[cfg(debug_assertions)]
    {
        let compile_time =
            option_env!("CARGO_MANIFEST_DIR").map(|d| std::path::Path::new(d).join("../../web"));
        if let Some(ref p) = compile_time {
            if p.join("dist/server/server.js").exists() {
                return Ok(p.clone());
            }
        }
    }

    // 2. Production: relative to current executable
    if let Ok(exe) = std::env::current_exe() {
        // macOS bundle: .app/Contents/MacOS/Band → .app/Contents/Resources/web
        if let Some(macos_dir) = exe.parent() {
            let resources = macos_dir.join("../Resources/web");
            if resources.join("dist/server/server.js").exists() {
                return Ok(resources);
            }
        }
    }

    Err("Web server bundle not found. Run `pnpm -F @band-app/server build` first.".to_string())
}

pub(crate) fn get_configured_port() -> u16 {
    load_settings()
        .ok()
        .and_then(|s| s.web_server_port)
        .unwrap_or(DEFAULT_WEB_SERVER_PORT)
}

/// Resolve the JS runtime path. Production: bundled `bun` sidecar next to the
/// main executable. Dev: `binaries/bun-<triple>` from the cargo manifest dir.
/// Last resort: `bun` on PATH.
fn resolve_runtime() -> std::path::PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(macos_dir) = exe.parent() {
            let bundled = macos_dir.join("bun");
            if bundled.exists() {
                return bundled;
            }
        }
    }
    #[cfg(debug_assertions)]
    {
        if let Some(manifest) = option_env!("CARGO_MANIFEST_DIR") {
            let triple = match std::env::consts::ARCH {
                "aarch64" => "aarch64-apple-darwin",
                "x86_64" => "x86_64-apple-darwin",
                _ => "",
            };
            if !triple.is_empty() {
                let dev_path =
                    std::path::Path::new(manifest).join(format!("binaries/bun-{triple}"));
                if dev_path.exists() {
                    return dev_path;
                }
            }
        }
    }
    std::path::PathBuf::from("bun")
}

/// Resolve the user's full shell PATH once (includes nvm/npm paths).
pub(crate) fn shell_path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        if let Ok(output) = Command::new(&shell)
            .args(["-li", "-c", "echo $PATH"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
        {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                return path;
            }
        }
        format!(
            "/opt/homebrew/bin:/usr/local/bin:{}",
            std::env::var("PATH").unwrap_or_default()
        )
    })
}

/// Read the token from settings.json (web server creates it).
pub(crate) fn get_token() -> Result<String, String> {
    let settings = load_settings()?;
    settings.token_secret.ok_or_else(|| {
        "tokenSecret not found in settings.json — start the web server first".to_string()
    })
}

/// Send SIGTERM to the entire process group, then fall back to SIGKILL.
fn kill_process_tree(child: &mut Child) {
    let pid = child.id() as libc::pid_t;
    // Kill the process group (negative pid)
    unsafe {
        libc::kill(-pid, libc::SIGTERM);
    }
    // Give the process time to run shutdown hooks (e.g. tunnel cleanup)
    std::thread::sleep(std::time::Duration::from_secs(3));
    // Fallback: force-kill the child itself if still alive
    let _ = child.kill();
    let _ = child.wait();
}

/// Set the spawned process to be a new session leader so we can kill the tree.
fn set_process_group(cmd: &mut Command) -> &mut Command {
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        })
    }
}

/// Open (or create) `~/.band/server.log` in append mode and return two
/// `Stdio` handles (one for stdout, one for stderr).  If the log file
/// exceeds 5 MB it is rotated to `server.log.old` first.
fn server_log_stdio() -> Result<(Stdio, Stdio), String> {
    const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

    let log_dir = band_home();
    std::fs::create_dir_all(&log_dir)
        .map_err(|e| format!("Failed to create log directory: {e}"))?;

    let log_path = log_dir.join("server.log");
    if let Ok(meta) = std::fs::metadata(&log_path) {
        if meta.len() > MAX_LOG_BYTES {
            let _ = std::fs::rename(&log_path, log_dir.join("server.log.old"));
        }
    }

    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("Failed to open server log: {e}"))?;

    let file_clone = file
        .try_clone()
        .map_err(|e| format!("Failed to clone log file handle: {e}"))?;

    Ok((Stdio::from(file), Stdio::from(file_clone)))
}

// ---------------------------------------------------------------------------
// ManagedProcess — reusable wrapper around an optional child process
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct ManagedProcess(Arc<Mutex<Option<Child>>>);

impl ManagedProcess {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(None)))
    }

    pub fn is_running(&self) -> bool {
        let mut guard = self.0.lock().unwrap();
        match *guard {
            Some(ref mut child) => {
                if let Ok(None) = child.try_wait() {
                    true
                } else {
                    *guard = None;
                    false
                }
            }
            None => false,
        }
    }

    pub fn kill(&self) {
        let mut guard = self.0.lock().unwrap();
        if let Some(ref mut child) = *guard {
            kill_process_tree(child);
        }
        *guard = None;
    }

    pub fn set(&self, child: Child) {
        let mut guard = self.0.lock().unwrap();
        *guard = Some(child);
    }
}

// ---------------------------------------------------------------------------
// State types
// ---------------------------------------------------------------------------

pub struct WebServerState(pub ManagedProcess);

// ---------------------------------------------------------------------------
// Health check helpers
// ---------------------------------------------------------------------------

/// Parse a health response body and return true if it's from our web server.
fn parse_local_health(body: &str) -> bool {
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(body) {
        parsed["app"].as_str() == Some("band-web-server")
    } else {
        false
    }
}

/// Check the local web server health endpoint.
pub(crate) async fn check_local_health(port: u16, token: &str) -> bool {
    let output = tokio::process::Command::new("curl")
        .args([
            "-s",
            "-f",
            "--max-time",
            "2",
            &format!("http://127.0.0.1:{port}/api/health?token={token}"),
        ])
        .output()
        .await;
    match output {
        Ok(o) if o.status.success() => parse_local_health(&String::from_utf8_lossy(&o.stdout)),
        _ => false,
    }
}

/// Check the local health endpoint synchronously using a blocking curl call.
fn check_local_health_sync(port: u16, token: &str) -> bool {
    let url = format!("http://127.0.0.1:{port}/api/health?token={token}");
    let output = Command::new("curl")
        .args(["-s", "-f", "--max-time", "2", &url])
        .output();
    match output {
        Ok(o) if o.status.success() => parse_local_health(&String::from_utf8_lossy(&o.stdout)),
        _ => false,
    }
}

/// Kill any process listening on the given port.
pub(crate) fn kill_port_sync(port: u16) {
    if let Ok(output) = Command::new("lsof").args([&format!("-ti:{port}")]).output() {
        if output.status.success() {
            let pids = String::from_utf8_lossy(&output.stdout);
            for pid in pids.split_whitespace() {
                if let Ok(pid_num) = pid.parse::<i32>() {
                    unsafe {
                        libc::kill(pid_num, libc::SIGTERM);
                    }
                }
            }
            // Give processes a moment to exit
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
    }
}

// ---------------------------------------------------------------------------
// Auto-start helper (called from setup(), no Tauri state available)
// ---------------------------------------------------------------------------

/// Ensure the web server is running and return `(port, token)`.
///
/// 1. Kills any existing server on the configured port.
/// 2. Spawns `node dist/start-server.mjs`.
/// 3. Polls the health endpoint until ready (max 15 s).
pub(crate) fn ensure_webserver_running() -> Result<(u16, String), String> {
    let port = get_configured_port();

    // Kill any stale server so we always run our bundled version
    kill_port_sync(port);

    let web_dir = resolve_web_dir()?;
    let start_script = web_dir.join("dist/start-server.mjs");

    let (log_out, log_err) = server_log_stdio().unwrap_or_else(|_| (Stdio::null(), Stdio::null()));

    let runtime = resolve_runtime();
    let mut cmd = Command::new(&runtime);
    cmd.arg(&start_script)
        .current_dir(&web_dir)
        .env("PATH", shell_path())
        .env("PORT", port.to_string())
        .stdout(log_out)
        .stderr(log_err);
    set_process_group(&mut cmd);

    let _child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            format!(
                "Bundled runtime not found at {} — reinstall Band",
                runtime.display()
            )
        } else {
            format!("Failed to start web server: {e}")
        }
    })?;

    // Poll health endpoint until ready (max 15 s).
    // The web server creates tokenSecret in settings.json on startup,
    // so we read it each iteration until it appears.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    while std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(200));
        if let Ok(token) = get_token() {
            if check_local_health_sync(port, &token) {
                return Ok((port, token));
            }
        }
    }

    Err("Web server did not become healthy within 15 seconds".to_string())
}

// ---------------------------------------------------------------------------
// Web server commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn webserver_start(state: State<'_, WebServerState>) -> Result<(), String> {
    if state.0.is_running() {
        return Ok(());
    }

    let port = get_configured_port();

    // Check if a server is already running (started externally)
    if let Ok(token) = get_token() {
        if check_local_health(port, &token).await {
            return Ok(());
        }
    }

    let web_dir = resolve_web_dir()?;
    let start_script = web_dir.join("dist/start-server.mjs");

    let (log_out, log_err) = server_log_stdio().unwrap_or_else(|_| (Stdio::null(), Stdio::null()));

    let runtime = resolve_runtime();
    let mut cmd = Command::new(&runtime);
    cmd.arg(&start_script)
        .current_dir(&web_dir)
        .env("PATH", shell_path())
        .env("PORT", port.to_string())
        .stdout(log_out)
        .stderr(log_err);
    set_process_group(&mut cmd);

    let child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            format!(
                "Bundled runtime not found at {} — reinstall Band",
                runtime.display()
            )
        } else {
            format!("Failed to start web server: {e}")
        }
    })?;

    state.0.set(child);
    Ok(())
}

#[tauri::command]
pub async fn webserver_stop(state: State<'_, WebServerState>) -> Result<(), String> {
    state.0.kill();

    // Kill any process listening on the port (handles externally-started servers)
    let port = get_configured_port();
    if let Ok(output) = tokio::process::Command::new("lsof")
        .args([&format!("-ti:{port}")])
        .output()
        .await
    {
        if output.status.success() {
            let pids = String::from_utf8_lossy(&output.stdout);
            for pid in pids.split_whitespace() {
                if let Ok(pid_num) = pid.parse::<i32>() {
                    unsafe {
                        libc::kill(pid_num, libc::SIGTERM);
                    }
                }
            }
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // -- ManagedProcess -------------------------------------------------------

    #[test]
    fn managed_process_starts_empty() {
        let mp = ManagedProcess::new();
        assert!(!mp.is_running());
    }

    #[test]
    fn managed_process_tracks_child() {
        let mp = ManagedProcess::new();
        let child = Command::new("sleep")
            .arg("60")
            .spawn()
            .expect("failed to spawn sleep");
        mp.set(child);
        assert!(mp.is_running());
        mp.kill();
        assert!(!mp.is_running());
    }

    #[test]
    fn managed_process_kill_when_empty() {
        let mp = ManagedProcess::new();
        // Should not panic
        mp.kill();
        assert!(!mp.is_running());
    }

    // -- parse_local_health ---------------------------------------------------

    #[test]
    fn parse_local_health_valid() {
        let body = r#"{"status":"ok","app":"band-web-server","hostname":"my-mac.local"}"#;
        assert!(parse_local_health(body));
    }

    #[test]
    fn parse_local_health_wrong_app() {
        let body = r#"{"status":"ok","app":"other-server"}"#;
        assert!(!parse_local_health(body));
    }

    #[test]
    fn parse_local_health_missing_app() {
        let body = r#"{"status":"ok"}"#;
        assert!(!parse_local_health(body));
    }

    #[test]
    fn parse_local_health_invalid_json() {
        assert!(!parse_local_health("not json"));
    }

    #[test]
    fn parse_local_health_empty_body() {
        assert!(!parse_local_health(""));
    }

    #[test]
    fn parse_local_health_html_401() {
        let body = "<!DOCTYPE html><html><body>Unauthorized</body></html>";
        assert!(!parse_local_health(body));
    }
}
