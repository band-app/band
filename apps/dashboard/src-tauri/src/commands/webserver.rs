use std::io::{BufRead, BufReader};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

use crate::state::load_settings;

const DEFAULT_WEB_SERVER_PORT: u16 = 3456;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn resolve_web_dir() -> Result<std::path::PathBuf, String> {
    // 1. Dev: CARGO_MANIFEST_DIR (compile-time)
    let compile_time = option_env!("CARGO_MANIFEST_DIR").map(|d| {
        std::path::Path::new(d).join("../../web")
    });
    if let Some(ref p) = compile_time {
        if p.join("dist/server/server.js").exists() {
            return Ok(p.clone());
        }
    }

    // 2. Production: relative to current executable
    if let Ok(exe) = std::env::current_exe() {
        // macOS bundle: .app/Contents/MacOS/band-dashboard → .app/Contents/Resources/web
        if let Some(macos_dir) = exe.parent() {
            let resources = macos_dir.join("../Resources/web");
            if resources.join("dist/server/server.js").exists() {
                return Ok(resources);
            }
        }
    }

    Err(
        "Web server bundle not found. Run `pnpm -F @band/web build` first."
            .to_string(),
    )
}

fn get_configured_port() -> u16 {
    load_settings()
        .ok()
        .and_then(|s| s.web_server_port)
        .unwrap_or(DEFAULT_WEB_SERVER_PORT)
}

/// Generate a 32-byte hex secret from /dev/urandom.
fn generate_secret() -> Result<String, String> {
    use std::io::Read;
    let mut f = std::fs::File::open("/dev/urandom")
        .map_err(|e| format!("Failed to open /dev/urandom: {}", e))?;
    let mut buf = [0u8; 32];
    f.read_exact(&mut buf)
        .map_err(|e| format!("Failed to read random bytes: {}", e))?;
    Ok(buf.iter().map(|b| format!("{:02x}", b)).collect())
}

/// Send SIGTERM to the entire process group, then fall back to SIGKILL.
fn kill_process_tree(child: &mut Child) {
    let pid = child.id() as libc::pid_t;
    // Kill the process group (negative pid)
    unsafe {
        libc::kill(-pid, libc::SIGTERM);
    }
    std::thread::sleep(std::time::Duration::from_millis(100));
    // Fallback: force-kill the child itself
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
            Some(ref mut child) => match child.try_wait() {
                Ok(None) => true,
                _ => {
                    *guard = None;
                    false
                }
            },
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

pub struct TunnelInner {
    pub process: ManagedProcess,
    pub url: Option<String>,
}

pub struct TunnelState(pub Arc<Mutex<TunnelInner>>);

pub struct AccessTokenState(pub Arc<Mutex<Option<String>>>);

// ---------------------------------------------------------------------------
// Web server commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn webserver_start(
    state: State<'_, WebServerState>,
    token_state: State<'_, AccessTokenState>,
) -> Result<(), String> {
    if state.0.is_running() {
        return Ok(());
    }

    let web_dir = resolve_web_dir()?;
    let start_script = web_dir.join("start-server.mjs");
    let port = get_configured_port();
    let secret = generate_secret()?;

    // Clear any cached token from a previous session
    *token_state.0.lock().unwrap() = None;

    let mut cmd = Command::new("node");
    cmd.arg(&start_script)
        .current_dir(&web_dir)
        .env("PORT", port.to_string())
        .env("BAND_TOKEN_SECRET", &secret)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    set_process_group(&mut cmd);

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start web server: {}", e))?;

    state.0.set(child);
    Ok(())
}

#[tauri::command]
pub fn webserver_stop(
    state: State<'_, WebServerState>,
    token_state: State<'_, AccessTokenState>,
) -> Result<(), String> {
    state.0.kill();
    *token_state.0.lock().unwrap() = None;
    Ok(())
}

#[tauri::command]
pub fn webserver_status(state: State<'_, WebServerState>) -> Result<bool, String> {
    Ok(state.0.is_running())
}

#[tauri::command]
pub async fn webserver_wait_ready() -> Result<(), String> {
    let port = get_configured_port();
    let addr = format!("127.0.0.1:{}", port);
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);

    loop {
        if tokio::net::TcpStream::connect(&addr).await.is_ok() {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(format!(
                "Web server did not become ready on port {} within 10 seconds",
                port
            ));
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

#[tauri::command]
pub async fn webserver_get_token(
    token_state: State<'_, AccessTokenState>,
) -> Result<String, String> {
    // Return cached token if available
    {
        let guard = token_state.0.lock().unwrap();
        if let Some(ref token) = *guard {
            return Ok(token.clone());
        }
    }

    let port = get_configured_port();
    let output = tokio::process::Command::new("curl")
        .args([
            "-s",
            "-f",
            &format!("http://127.0.0.1:{}/api/auth/token", port),
        ])
        .output()
        .await
        .map_err(|e| format!("Failed to fetch token: {}", e))?;

    if !output.status.success() {
        return Err("Failed to fetch auth token from web server".to_string());
    }

    let body = String::from_utf8_lossy(&output.stdout);
    let parsed: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| format!("Failed to parse token response: {}", e))?;
    let token = parsed["token"]
        .as_str()
        .ok_or_else(|| "Token not found in response".to_string())?
        .to_string();

    // Cache the token
    *token_state.0.lock().unwrap() = Some(token.clone());

    Ok(token)
}

// ---------------------------------------------------------------------------
// Tunnel commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn tunnel_check() -> Result<bool, String> {
    let output = Command::new("which")
        .arg("cloudflared")
        .output()
        .map_err(|e| format!("Failed to check cloudflared: {}", e))?;
    Ok(output.status.success())
}

#[tauri::command]
pub async fn tunnel_install() -> Result<(), String> {
    let output = tokio::process::Command::new("brew")
        .args(["install", "cloudflared"])
        .output()
        .await
        .map_err(|e| format!("Failed to run brew: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("brew install cloudflared failed: {}", stderr));
    }
    Ok(())
}

#[tauri::command]
pub fn tunnel_start(
    app: AppHandle,
    state: State<'_, TunnelState>,
    token_state: State<'_, AccessTokenState>,
) -> Result<(), String> {
    let mut guard = state.0.lock().unwrap();

    // Already running — re-emit URL (with token) if we have it
    if guard.process.is_running() {
        if let Some(ref base_url) = guard.url {
            let url = append_token(base_url, &token_state);
            let _ = app.emit("tunnel-url", url);
        }
        return Ok(());
    }

    let port = get_configured_port();
    let mut cmd = Command::new("cloudflared");
    cmd.args(["tunnel", "--url", &format!("http://127.0.0.1:{}", port)])
        .stderr(Stdio::piped())
        .stdout(Stdio::null());
    set_process_group(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start cloudflared: {}", e))?;

    let stderr = child.stderr.take().unwrap();
    guard.process.set(child);
    guard.url = None;
    drop(guard);

    let tunnel_state = state.0.clone();
    let app_handle = app.clone();
    let token_arc = token_state.0.clone();

    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        let mut found = false;
        for line in reader.lines().flatten() {
            if !found {
                if let Some(start) = line.find("https://") {
                    let rest = &line[start..];
                    if rest.contains(".trycloudflare.com") {
                        let base_url: String =
                            rest.chars().take_while(|c| !c.is_whitespace()).collect();
                        if let Ok(mut guard) = tunnel_state.lock() {
                            // Store the base URL (without token)
                            guard.url = Some(base_url.clone());
                        }
                        // Emit URL with token appended
                        let token_guard = token_arc.lock().ok();
                        let token = token_guard
                            .as_ref()
                            .and_then(|g| g.as_ref().cloned());
                        let url = match token {
                            Some(t) => format!("{}?token={}", base_url, t),
                            None => base_url,
                        };
                        let _ = app_handle.emit("tunnel-url", url);
                        found = true;
                    }
                }
            }
            // Keep draining stderr so cloudflared doesn't get SIGPIPE
        }
        if !found {
            if let Ok(mut guard) = tunnel_state.lock() {
                guard.process.kill();
                guard.url = None;
            }
            let _ = app_handle.emit("tunnel-error", "cloudflared exited without creating a tunnel");
        }
    });

    Ok(())
}

#[tauri::command]
pub fn tunnel_stop(state: State<'_, TunnelState>) -> Result<(), String> {
    let mut guard = state.0.lock().unwrap();
    guard.process.kill();
    guard.url = None;
    Ok(())
}

#[tauri::command]
pub fn tunnel_status(
    state: State<'_, TunnelState>,
    token_state: State<'_, AccessTokenState>,
) -> Result<Option<String>, String> {
    let guard = state.0.lock().unwrap();
    if guard.process.is_running() {
        Ok(guard.url.as_ref().map(|base_url| append_token(base_url, &token_state)))
    } else {
        Ok(None)
    }
}

/// Append ?token=XXX to a base URL if a cached token exists.
fn append_token(base_url: &str, token_state: &State<'_, AccessTokenState>) -> String {
    let guard = token_state.0.lock().unwrap();
    match *guard {
        Some(ref token) => format!("{}?token={}", base_url, token),
        None => base_url.to_string(),
    }
}
