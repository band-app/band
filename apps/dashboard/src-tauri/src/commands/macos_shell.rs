//! Lightweight macOS shell bridges used by full-editor mode.
//!
//! These commands are NOT side-panel specific — they're called from the
//! workspace toolbar (open in editor, reveal in Finder), the settings page
//! (folder picker, install CLI), and the dashboard adapter. They were
//! historically defined in `commands/ide.rs` next to the side-panel
//! window-focusing code; that file was deleted when side-panel mode was
//! split into its own repo (`band-app/sidepanel`), so the bits we still
//! need live here.

/// Opens a macOS folder picker via `osascript` and returns the chosen
/// POSIX path, or `Ok(None)` if the user cancelled.
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

/// Reveals a path in Finder via `open`.
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
        .is_ok_and(|output| output.status.success())
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

/// Install the CLI by creating a symlink with administrator privileges.
/// Runs `osascript` to show a macOS admin password dialog — this works
/// because the Tauri app is the foreground GUI process (unlike the web
/// server, which can't reliably show GUI dialogs).
#[tauri::command]
pub fn install_cli(binary_path: String, symlink_path: String) -> Result<(), String> {
    let cmd = format!(
        "ln -sf '{}' '{}'",
        binary_path.replace('\'', "'\\''"),
        symlink_path.replace('\'', "'\\''")
    );
    let script = format!(
        "do shell script \"{}\" with administrator privileges",
        cmd.replace('\\', "\\\\").replace('"', "\\\"")
    );
    let output = std::process::Command::new("osascript")
        .args(["-e", &script])
        .output()
        .map_err(|e| format!("Failed to run osascript: {e}"))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("User canceled") || stderr.contains("-128") {
            Err("Admin password prompt cancelled".to_string())
        } else {
            Err(format!("Failed to install CLI: {stderr}"))
        }
    }
}
