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
    let compile_time =
        option_env!("CARGO_MANIFEST_DIR").map(|d| std::path::Path::new(d).join("../../web"));
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

    Err("Web server bundle not found. Run `pnpm -F @band/web build` first.".to_string())
}

fn get_configured_port() -> u16 {
    load_settings()
        .ok()
        .and_then(|s| s.web_server_port)
        .unwrap_or(DEFAULT_WEB_SERVER_PORT)
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

pub struct TunnelInner {
    pub process: ManagedProcess,
    pub url: Option<String>,
}

pub struct TunnelState(pub Arc<Mutex<TunnelInner>>);

// ---------------------------------------------------------------------------
// Web server commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn webserver_start(state: State<'_, WebServerState>) -> Result<(), String> {
    if state.0.is_running() {
        return Ok(());
    }

    let web_dir = resolve_web_dir()?;
    let start_script = web_dir.join("start-server.mjs");
    let port = get_configured_port();

    let mut cmd = Command::new("node");
    cmd.arg(&start_script)
        .current_dir(&web_dir)
        .env("PORT", port.to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    set_process_group(&mut cmd);

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start web server: {e}"))?;

    state.0.set(child);
    Ok(())
}

#[tauri::command]
pub fn webserver_stop(state: State<'_, WebServerState>) -> Result<(), String> {
    state.0.kill();
    Ok(())
}

#[tauri::command]
pub fn webserver_status(state: State<'_, WebServerState>) -> Result<bool, String> {
    Ok(state.0.is_running())
}

#[tauri::command]
pub async fn webserver_wait_ready() -> Result<(), String> {
    let port = get_configured_port();
    let addr = format!("127.0.0.1:{port}");
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);

    loop {
        if tokio::net::TcpStream::connect(&addr).await.is_ok() {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(format!(
                "Web server did not become ready on port {port} within 10 seconds"
            ));
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

// ---------------------------------------------------------------------------
// Tunnel commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn tunnel_check() -> Result<bool, String> {
    let output = Command::new("which")
        .arg("cloudflared")
        .output()
        .map_err(|e| format!("Failed to check cloudflared: {e}"))?;
    Ok(output.status.success())
}

#[tauri::command]
pub async fn tunnel_install() -> Result<(), String> {
    let output = tokio::process::Command::new("brew")
        .args(["install", "cloudflared"])
        .output()
        .await
        .map_err(|e| format!("Failed to run brew: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("brew install cloudflared failed: {stderr}"));
    }
    Ok(())
}

#[tauri::command]
pub fn tunnel_start(app: AppHandle, state: State<'_, TunnelState>) -> Result<(), String> {
    let mut guard = state.0.lock().unwrap();

    // Already running — re-emit URL if we have it
    if guard.process.is_running() {
        if let Some(ref url) = guard.url {
            let _ = app.emit("tunnel-url", url.clone());
        }
        return Ok(());
    }

    let port = get_configured_port();
    let mut cmd = Command::new("cloudflared");
    cmd.args(["tunnel", "--url", &format!("http://127.0.0.1:{port}")])
        .stderr(Stdio::piped())
        .stdout(Stdio::null());
    set_process_group(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start cloudflared: {e}"))?;

    let stderr = child.stderr.take().unwrap();
    guard.process.set(child);
    guard.url = None;
    drop(guard);

    let tunnel_state = state.0.clone();
    let app_handle = app.clone();

    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        let mut found = false;
        for line in reader.lines().map_while(Result::ok) {
            if !found {
                if let Some(start) = line.find("https://") {
                    let rest = &line[start..];
                    if rest.contains(".trycloudflare.com") {
                        let url: String = rest.chars().take_while(|c| !c.is_whitespace()).collect();
                        if let Ok(mut guard) = tunnel_state.lock() {
                            guard.url = Some(url.clone());
                        }
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
            let _ = app_handle.emit(
                "tunnel-error",
                "cloudflared exited without creating a tunnel",
            );
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
pub fn tunnel_status(state: State<'_, TunnelState>) -> Result<Option<String>, String> {
    let guard = state.0.lock().unwrap();
    if guard.process.is_running() {
        Ok(guard.url.clone())
    } else {
        Ok(None)
    }
}
