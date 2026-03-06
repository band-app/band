use std::io::{BufRead, BufReader};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter, State};

use crate::state::{load_settings, save_settings};

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

/// Resolve the user's full shell PATH once (includes nvm/npm paths).
pub(crate) fn shell_path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        if let Ok(output) = Command::new(&shell)
            .args(["-l", "-c", "echo $PATH"])
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

/// Resolve a binary using `which` — returns the path as-is (e.g. Node.js wrapper).
pub(crate) fn which_binary(name: &str) -> Result<String, String> {
    let output = Command::new("which")
        .arg(name)
        .env("PATH", shell_path())
        .output()
        .map_err(|e| format!("Failed to run which: {e}"))?;
    if !output.status.success() {
        return Err(format!("{name} not found in PATH"));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
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

/// Load or create a persistent token secret (saved in settings).
fn get_or_create_secret() -> Result<String, String> {
    let mut settings = load_settings()?;
    if let Some(ref secret) = settings.token_secret {
        return Ok(secret.clone());
    }
    let secret = generate_secret()?;
    settings.token_secret = Some(secret.clone());
    save_settings(&settings)?;
    Ok(secret)
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

/// Extract the subdomain from a tunnel URL like `https://foo.instatunnel.my`.
pub(crate) fn extract_subdomain(url: &str) -> Option<&str> {
    url.strip_prefix("https://")
        .and_then(|rest| rest.strip_suffix(".instatunnel.my"))
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
    let secret = get_or_create_secret()?;

    // Clear any cached token from a previous session
    *token_state.0.lock().unwrap() = None;

    let mut cmd = Command::new("node");
    cmd.arg(&start_script)
        .current_dir(&web_dir)
        .env("PATH", shell_path())
        .env("PORT", port.to_string())
        .env("BAND_TOKEN_SECRET", &secret)
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
// Prerequisite checks & installs
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
pub struct PrereqStatus {
    pub node: bool,
    pub instatunnel: bool,
}

#[tauri::command]
pub fn prereq_check() -> Result<PrereqStatus, String> {
    Ok(PrereqStatus {
        node: which_binary("node").is_ok(),
        instatunnel: which_binary("instatunnel").is_ok(),
    })
}

#[tauri::command]
pub async fn node_install() -> Result<(), String> {
    let path = shell_path().to_string();
    let output = tokio::process::Command::new("brew")
        .args(["install", "node"])
        .env("PATH", &path)
        .output()
        .await
        .map_err(|e| format!("Failed to run brew: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("brew install node failed: {stderr}"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tunnel commands
// ---------------------------------------------------------------------------


#[tauri::command]
pub async fn tunnel_install() -> Result<(), String> {
    let path = shell_path().to_string();
    let output = tokio::process::Command::new("npm")
        .args(["install", "-g", "instatunnel"])
        .env("PATH", &path)
        .output()
        .await
        .map_err(|e| format!("Failed to run npm: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("npm install -g instatunnel failed: {stderr}"));
    }
    Ok(())
}

#[tauri::command]
pub fn tunnel_start(
    app: AppHandle,
    state: State<'_, TunnelState>,
    token_state: State<'_, AccessTokenState>,
    skip_subdomain: Option<bool>,
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
    let settings = load_settings().unwrap_or_default();
    let subdomain = settings.tunnel_subdomain.clone();
    let bin = which_binary("instatunnel")?;

    let mut cmd = Command::new(&bin);
    cmd.arg(format!("{port}"));
    if !skip_subdomain.unwrap_or(false) {
        if let Some(ref name) = subdomain {
            if !name.is_empty() {
                cmd.args(["--subdomain", name]);
            }
        }
    }
    cmd.env("PATH", shell_path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    set_process_group(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start instatunnel: {e}"))?;

    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    guard.process.set(child);
    guard.url = None;
    drop(guard);

    let tunnel_state = state.0.clone();
    let app_handle = app.clone();
    let token_arc = token_state.0.clone();

    // Merge stdout and stderr into a single channel
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let tx2 = tx.clone();

    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            if tx2.send(line).is_err() {
                break;
            }
        }
    });

    std::thread::spawn(move || {
        let mut found = false;
        let mut output_lines: Vec<String> = Vec::new();
        for line in rx {
            if !found {
                output_lines.push(line.clone());
                if let Some(start) = line.find("https://") {
                    let rest = &line[start..];
                    // Extract URL: take chars valid in a URL, then trim trailing punctuation
                    let raw_url: String = rest
                        .chars()
                        .take_while(|c| !c.is_whitespace())
                        .collect();
                    let base_url = raw_url.trim_end_matches(|c: char| {
                        matches!(c, '"' | '\'' | ')' | '(' | ']' | '[' | '>' | ',')
                    });
                    // Must end with .instatunnel.my (with optional path/port)
                    // but exclude api.instatunnel.my
                    if base_url.contains(".instatunnel.my")
                        && !base_url.contains("://api.instatunnel.my")
                    {
                        let base_url = base_url.to_string();
                        if let Ok(mut guard) = tunnel_state.lock() {
                            guard.url = Some(base_url.clone());
                        }
                        let token_guard = token_arc.lock().ok();
                        let token =
                            token_guard.as_ref().and_then(|g| g.as_ref().cloned());
                        let url = match token {
                            Some(t) => format!("{}?token={}", base_url, t),
                            None => base_url,
                        };
                        let _ = app_handle.emit("tunnel-url", url);
                        found = true;
                    }
                }
            }
            // Keep draining so instatunnel doesn't get SIGPIPE
        }
        if found {
            // Process exited after successful connect — emit for auto-restart
            let _ = app_handle.emit("tunnel-exited", ());
        } else {
            if let Ok(mut guard) = tunnel_state.lock() {
                guard.process.kill();
                guard.url = None;
            }
            let all_output = output_lines.join("\n");
            if all_output.contains("subdomain already taken") {
                let _ = app_handle.emit("tunnel-subdomain-taken", ());
            } else {
                let msg = if all_output.is_empty() {
                    "instatunnel exited without output".to_string()
                } else {
                    // Show the first meaningful lines (skip update notices)
                    let meaningful: Vec<_> = output_lines
                        .iter()
                        .filter(|l| {
                            !l.contains("Update available")
                                && !l.contains("Run: npm")
                                && !l.contains("Release notes:")
                                && !l.starts_with("  ")
                                && !l.trim().is_empty()
                        })
                        .take(5)
                        .cloned()
                        .collect();
                    let display = if meaningful.is_empty() {
                        all_output.lines().take(10).collect::<Vec<_>>().join("\n")
                    } else {
                        meaningful.join("\n")
                    };
                    format!("instatunnel failed:\n{}", display)
                };
                let _ = app_handle.emit("tunnel-error", msg);
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn tunnel_auth_check() -> Result<bool, String> {
    let bin = which_binary("instatunnel")?;
    let path = shell_path().to_string();
    let output = tokio::process::Command::new(&bin)
        .args(["auth", "show-key"])
        .env("PATH", &path)
        .output()
        .await
        .map_err(|e| format!("Failed to check auth status: {e}"))?;
    Ok(output.status.success())
}

#[tauri::command]
pub async fn tunnel_stop(state: State<'_, TunnelState>) -> Result<(), String> {
    let subdomain = {
        let mut guard = state.0.lock().unwrap();
        let sub = guard.url.as_ref().and_then(|url| extract_subdomain(url).map(|s| s.to_string()));
        guard.url = None;
        sub
    };

    // Use CLI to close the tunnel — the process will exit on its own
    if let Some(ref name) = subdomain {
        if let Ok(bin) = which_binary("instatunnel") {
            let path = shell_path().to_string();
            let _ = tokio::process::Command::new(&bin)
                .args(["--kill", name])
                .env("PATH", &path)
                .output()
                .await;
        }
    }

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
