use hmac::{Hmac, Mac};
use sha2::Sha256;
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
        .map_err(|e| format!("Failed to open /dev/urandom: {e}"))?;
    let mut buf = [0u8; 32];
    f.read_exact(&mut buf)
        .map_err(|e| format!("Failed to read random bytes: {e}"))?;
    Ok(buf.iter().fold(String::with_capacity(64), |mut acc, b| {
        use std::fmt::Write;
        write!(acc, "{b:02x}").unwrap();
        acc
    }))
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

/// Compute the access token from the secret: HMAC-SHA256(secret, "band-access").
fn compute_token(secret: &str) -> String {
    type HmacSha256 = Hmac<Sha256>;
    let mut mac =
        HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key length");
    mac.update(b"band-access");
    let result = mac.finalize().into_bytes();
    result.iter().fold(String::with_capacity(64), |mut acc, b| {
        use std::fmt::Write;
        write!(acc, "{b:02x}").unwrap();
        acc
    })
}

/// Get the access token, computing it from the stored secret.
fn get_token() -> Result<String, String> {
    let secret = get_or_create_secret()?;
    Ok(compute_token(&secret))
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

/// Parse a tunnel health response body.
/// Returns (`is_our_app`, `remote_hostname_if_different_machine`).
fn parse_tunnel_health(body: &str, local_hostname: &str) -> (bool, Option<String>) {
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(body) {
        if parsed["app"].as_str() == Some("band-web-server") {
            let remote_host = parsed["hostname"].as_str().unwrap_or("").to_string();
            if remote_host == local_hostname {
                (true, None)
            } else {
                (true, Some(remote_host))
            }
        } else {
            (false, None)
        }
    } else {
        (false, None)
    }
}

/// Check the local web server health endpoint.
async fn check_local_health(port: u16, token: &str) -> bool {
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

/// Check the tunnel health endpoint. Returns (healthy, `remote_hostname`).
async fn check_tunnel_health(subdomain: &str, token: &str) -> (bool, Option<String>) {
    let url = format!("https://{subdomain}.instatunnel.my/api/health?token={token}");
    let output = tokio::process::Command::new("curl")
        .args(["-s", "-f", "--max-time", "5", &url])
        .output()
        .await;
    match output {
        Ok(o) if o.status.success() => {
            parse_tunnel_health(&String::from_utf8_lossy(&o.stdout), &gethostname())
        }
        _ => (false, None),
    }
}

fn gethostname() -> String {
    let output = std::process::Command::new("hostname").output().ok();
    match output {
        Some(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        _ => String::new(),
    }
}

#[derive(serde::Serialize)]
pub struct ServiceHealth {
    pub webserver: bool,
    pub tunnel: bool,
    pub tunnel_url: Option<String>,
    pub tunnel_remote_host: Option<String>,
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
    let secret = get_or_create_secret()?;
    let token = compute_token(&secret);

    // Check if a server is already running (started externally)
    if check_local_health(port, &token).await {
        return Ok(());
    }

    let web_dir = resolve_web_dir()?;
    let start_script = web_dir.join("start-server.mjs");

    let mut cmd = Command::new("node");
    cmd.arg(&start_script)
        .current_dir(&web_dir)
        .env("PATH", shell_path())
        .env("PORT", port.to_string())
        .env("BAND_TOKEN_SECRET", &secret)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    set_process_group(&mut cmd);

    let child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "Node.js is required but not installed. Install it from https://nodejs.org".to_string()
        } else {
            format!("Failed to start web server: {e}")
        }
    })?;

    state.0.set(child);
    Ok(())
}

#[tauri::command]
pub async fn webserver_stop(
    state: State<'_, WebServerState>,
    tunnel_state: State<'_, TunnelState>,
) -> Result<(), String> {
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

    // Also stop the tunnel
    let subdomain = {
        let mut guard = tunnel_state.0.lock().unwrap();
        let sub = guard
            .url
            .as_ref()
            .and_then(|url| extract_subdomain(url).map(std::string::ToString::to_string))
            .or_else(|| {
                load_settings()
                    .ok()
                    .and_then(|s| s.tunnel_subdomain)
                    .filter(|s| !s.is_empty())
            });
        guard.process.kill();
        guard.url = None;
        sub
    };
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
pub fn webserver_get_token() -> Result<String, String> {
    get_token()
}

#[tauri::command]
pub async fn service_health_check() -> Result<ServiceHealth, String> {
    let port = get_configured_port();
    let settings = load_settings().unwrap_or_default();

    let token = get_token().ok();

    let webserver_healthy = match &token {
        Some(t) => check_local_health(port, t).await,
        None => false,
    };

    let mut tunnel_healthy = false;
    let mut tunnel_url = None;
    let mut tunnel_remote_host = None;

    if let Some(ref subdomain) = settings.tunnel_subdomain {
        if !subdomain.is_empty() {
            if let Some(ref t) = token {
                let (healthy, remote_host) = check_tunnel_health(subdomain, t).await;
                if healthy {
                    tunnel_healthy = true;
                    tunnel_url = Some(format!("https://{subdomain}.instatunnel.my"));
                    tunnel_remote_host = remote_host;
                }
            }
        }
    }

    Ok(ServiceHealth {
        webserver: webserver_healthy,
        tunnel: tunnel_healthy,
        tunnel_url,
        tunnel_remote_host,
    })
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
pub async fn tunnel_start(
    app: AppHandle,
    state: State<'_, TunnelState>,
    skip_subdomain: Option<bool>,
) -> Result<(), String> {
    let token = get_token().ok();

    {
        let guard = state.0.lock().unwrap();

        // Already running — re-emit URL (with token) if we have it
        if guard.process.is_running() {
            if let Some(ref base_url) = guard.url {
                let url = append_token(base_url, token.as_deref());
                let _ = app.emit("tunnel-url", url);
            }
            return Ok(());
        }
    }

    let port = get_configured_port();
    let settings = load_settings().unwrap_or_default();
    let subdomain = settings.tunnel_subdomain.clone();

    // Check if the tunnel is already running (started externally)
    if !skip_subdomain.unwrap_or(false) {
        if let Some(ref name) = subdomain {
            if !name.is_empty() {
                if let Some(ref t) = token {
                    let (healthy, remote_host) = check_tunnel_health(name, t).await;
                    if healthy {
                        let base_url = format!("https://{name}.instatunnel.my");
                        if let Some(ref host) = remote_host {
                            let _ = app.emit("tunnel-remote-host", host.clone());
                        }
                        {
                            let mut guard = state.0.lock().unwrap();
                            guard.url = Some(base_url.clone());
                        }
                        let url = append_token(&base_url, token.as_deref());
                        let _ = app.emit("tunnel-url", url);
                        return Ok(());
                    }
                }
            }
        }
    }

    let bin = which_binary("instatunnel")?;
    let mut guard = state.0.lock().unwrap();

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
    let token_for_thread = token.clone();

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
                    let raw_url: String = rest.chars().take_while(|c| !c.is_whitespace()).collect();
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
                        let url = append_token(&base_url, token_for_thread.as_deref());
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
                    format!("instatunnel failed:\n{display}")
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
        let sub = guard
            .url
            .as_ref()
            .and_then(|url| extract_subdomain(url).map(std::string::ToString::to_string))
            .or_else(|| {
                load_settings()
                    .ok()
                    .and_then(|s| s.tunnel_subdomain)
                    .filter(|s| !s.is_empty())
            });
        guard.process.kill();
        guard.url = None;
        sub
    };

    // Use CLI to close the tunnel
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

/// Append ?token=XXX to a base URL if a token is available.
fn append_token(base_url: &str, token: Option<&str>) -> String {
    match token {
        Some(t) => format!("{base_url}?token={t}"),
        None => base_url.to_string(),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // -- compute_token --------------------------------------------------------

    #[test]
    fn compute_token_matches_js_hmac() {
        // The JS side computes: createHmac("sha256", secret).update("band-access").digest("hex")
        // Verified via: node -e "console.log(require('crypto').createHmac('sha256','test-secret-key-for-auth').update('band-access').digest('hex'))"
        let token = compute_token("test-secret-key-for-auth");
        assert_eq!(
            token,
            "6c2b86959205e665b407323dfe3ea35fb7fa84e450831720429dfccc99ed5bb3"
        );
    }

    #[test]
    fn compute_token_deterministic() {
        let a = compute_token("my-secret");
        let b = compute_token("my-secret");
        assert_eq!(a, b);
    }

    #[test]
    fn compute_token_different_secrets_differ() {
        let a = compute_token("secret-a");
        let b = compute_token("secret-b");
        assert_ne!(a, b);
    }

    #[test]
    fn compute_token_empty_secret() {
        let token = compute_token("");
        assert_eq!(token.len(), 64);
        assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
    }

    // -- extract_subdomain ----------------------------------------------------

    #[test]
    fn extract_subdomain_basic() {
        assert_eq!(
            extract_subdomain("https://band6.instatunnel.my"),
            Some("band6")
        );
    }

    #[test]
    fn extract_subdomain_with_dashes() {
        assert_eq!(
            extract_subdomain("https://my-cool-app.instatunnel.my"),
            Some("my-cool-app")
        );
    }

    #[test]
    fn extract_subdomain_http_rejected() {
        // Only https:// prefix is supported
        assert_eq!(extract_subdomain("http://band6.instatunnel.my"), None);
    }

    #[test]
    fn extract_subdomain_wrong_domain() {
        assert_eq!(extract_subdomain("https://band6.example.com"), None);
    }

    #[test]
    fn extract_subdomain_with_path() {
        // URL has trailing path — doesn't match because suffix isn't exact
        assert_eq!(
            extract_subdomain("https://band6.instatunnel.my/some/path"),
            None
        );
    }

    #[test]
    fn extract_subdomain_empty_string() {
        assert_eq!(extract_subdomain(""), None);
    }

    #[test]
    fn extract_subdomain_bare_domain() {
        assert_eq!(extract_subdomain("https://instatunnel.my"), None);
    }

    #[test]
    fn extract_subdomain_no_protocol() {
        assert_eq!(extract_subdomain("band6.instatunnel.my"), None);
    }

    // -- append_token ---------------------------------------------------------

    #[test]
    fn append_token_with_some() {
        assert_eq!(
            append_token("https://example.com", Some("abc123")),
            "https://example.com?token=abc123"
        );
    }

    #[test]
    fn append_token_with_none() {
        assert_eq!(
            append_token("https://example.com", None),
            "https://example.com"
        );
    }

    #[test]
    fn append_token_preserves_base_url() {
        let base = "https://band6.instatunnel.my";
        assert_eq!(append_token(base, None), base);
    }

    // -- generate_secret ------------------------------------------------------

    #[test]
    fn generate_secret_length_and_format() {
        let secret = generate_secret().unwrap();
        // 32 bytes → 64 hex chars
        assert_eq!(secret.len(), 64);
        assert!(secret.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn generate_secret_unique() {
        let a = generate_secret().unwrap();
        let b = generate_secret().unwrap();
        assert_ne!(a, b, "two generated secrets should differ");
    }

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

    // -- parse_tunnel_health --------------------------------------------------

    #[test]
    fn parse_tunnel_health_same_host() {
        let body = r#"{"status":"ok","app":"band-web-server","hostname":"my-mac.local"}"#;
        let (healthy, remote) = parse_tunnel_health(body, "my-mac.local");
        assert!(healthy);
        assert_eq!(remote, None);
    }

    #[test]
    fn parse_tunnel_health_different_host() {
        let body = r#"{"status":"ok","app":"band-web-server","hostname":"other-mac.local"}"#;
        let (healthy, remote) = parse_tunnel_health(body, "my-mac.local");
        assert!(healthy);
        assert_eq!(remote, Some("other-mac.local".to_string()));
    }

    #[test]
    fn parse_tunnel_health_wrong_app() {
        let body = r#"{"status":"ok","app":"something-else","hostname":"my-mac.local"}"#;
        let (healthy, remote) = parse_tunnel_health(body, "my-mac.local");
        assert!(!healthy);
        assert_eq!(remote, None);
    }

    #[test]
    fn parse_tunnel_health_missing_hostname() {
        let body = r#"{"status":"ok","app":"band-web-server"}"#;
        let (healthy, remote) = parse_tunnel_health(body, "my-mac.local");
        assert!(healthy);
        // missing hostname → "" which differs from local → returns Some("")
        assert_eq!(remote, Some("".to_string()));
    }

    #[test]
    fn parse_tunnel_health_invalid_json() {
        let (healthy, remote) = parse_tunnel_health("not json", "my-mac.local");
        assert!(!healthy);
        assert_eq!(remote, None);
    }

    #[test]
    fn parse_tunnel_health_empty_body() {
        let (healthy, remote) = parse_tunnel_health("", "my-mac.local");
        assert!(!healthy);
        assert_eq!(remote, None);
    }

    #[test]
    fn parse_tunnel_health_tunnel_not_connected() {
        // This is what instatunnel returns when the tunnel exists but isn't connected
        let body = r#"{"error":"Tunnel not connected"}"#;
        let (healthy, remote) = parse_tunnel_health(body, "my-mac.local");
        assert!(!healthy);
        assert_eq!(remote, None);
    }
}
