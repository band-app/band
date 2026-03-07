use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

const SYMLINK_PATH: &str = "/usr/local/bin/band";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum CliStatus {
    Installed,
    NotInstalled,
    ConflictingBinary,
    DirNotFound,
    NotWritable,
}

fn sidecar_binary_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("Failed to get current exe: {e}"))?;
    // exe is Band.app/Contents/MacOS/Band
    let macos_dir = exe
        .parent()
        .ok_or_else(|| "Failed to get MacOS dir".to_string())?;

    let triple = include_str!(concat!(env!("OUT_DIR"), "/target_triple.txt"));
    let sidecar_name = format!("band-{}", triple.trim());
    let sidecar = macos_dir.join(&sidecar_name);

    if sidecar.exists() {
        Ok(sidecar)
    } else {
        Err(format!("Sidecar binary not found at {}", sidecar.display()))
    }
}

/// Check CLI install status for a given symlink path and sidecar binary path.
pub fn check_cli(symlink_path: &Path, sidecar_path: &Path) -> CliStatus {
    let Some(parent) = symlink_path.parent() else {
        return CliStatus::DirNotFound;
    };

    if !parent.exists() {
        return CliStatus::DirNotFound;
    }

    if !is_writable(parent) {
        return CliStatus::NotWritable;
    }

    if !symlink_path.exists() && symlink_path.symlink_metadata().is_err() {
        return CliStatus::NotInstalled;
    }

    // Check if it's a symlink pointing to our sidecar
    match fs::read_link(symlink_path) {
        Ok(target) => {
            if target == sidecar_path {
                CliStatus::Installed
            } else {
                CliStatus::ConflictingBinary
            }
        }
        Err(_) => {
            // Exists but is not a symlink (regular binary)
            CliStatus::ConflictingBinary
        }
    }
}

/// Install CLI symlink at the given path pointing to the sidecar binary.
pub fn install_cli(symlink_path: &Path, sidecar_path: &Path) -> Result<(), String> {
    let parent = symlink_path
        .parent()
        .ok_or_else(|| "Invalid symlink path".to_string())?;

    // Create parent dir if it doesn't exist
    if !parent.exists() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }

    // Remove existing symlink/file if it exists
    if symlink_path.symlink_metadata().is_ok() {
        fs::remove_file(symlink_path).map_err(|e| {
            format!(
                "Failed to remove existing {}: {e}",
                symlink_path.display()
            )
        })?;
    }

    #[cfg(unix)]
    std::os::unix::fs::symlink(sidecar_path, symlink_path)
        .map_err(|e| format!("Failed to create symlink: {e}"))?;

    #[cfg(not(unix))]
    return Err("CLI install is only supported on macOS/Linux".to_string());

    Ok(())
}

#[tauri::command]
pub fn cli_check_cmd() -> Result<CliStatus, String> {
    let sidecar = sidecar_binary_path()?;
    Ok(check_cli(Path::new(SYMLINK_PATH), &sidecar))
}

#[tauri::command]
pub fn cli_install_cmd() -> Result<(), String> {
    let sidecar = sidecar_binary_path()?;
    install_cli(Path::new(SYMLINK_PATH), &sidecar)
}

#[allow(clippy::similar_names)] // uid/gid are standard POSIX names
fn is_writable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if let Ok(metadata) = fs::metadata(path) {
            let current_uid = unsafe { libc::getuid() };
            let current_gid = unsafe { libc::getgid() };
            let mode = metadata.mode();
            let owner_uid = metadata.uid();
            let owner_gid = metadata.gid();

            if current_uid == 0 {
                return true;
            }
            if current_uid == owner_uid && (mode & 0o200) != 0 {
                return true;
            }
            if current_gid == owner_gid && (mode & 0o020) != 0 {
                return true;
            }
            if (mode & 0o002) != 0 {
                return true;
            }
            false
        } else {
            false
        }
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;
    use tempfile::TempDir;

    /// Create a fake sidecar binary in a temp dir
    fn make_sidecar(dir: &Path) -> PathBuf {
        let sidecar = dir.join("band-aarch64-apple-darwin");
        fs::write(&sidecar, "fake-binary").unwrap();
        sidecar
    }

    #[test]
    fn check_returns_not_installed_when_no_file_exists() {
        let tmp = TempDir::new().unwrap();
        let symlink_path = tmp.path().join("bin").join("band");
        let sidecar = make_sidecar(tmp.path());

        // Parent dir exists but symlink does not
        fs::create_dir_all(symlink_path.parent().unwrap()).unwrap();

        let status = check_cli(&symlink_path, &sidecar);
        assert_eq!(status, CliStatus::NotInstalled);
    }

    #[test]
    fn check_returns_installed_when_correct_symlink_exists() {
        let tmp = TempDir::new().unwrap();
        let bin_dir = tmp.path().join("bin");
        fs::create_dir_all(&bin_dir).unwrap();

        let sidecar = make_sidecar(tmp.path());
        let symlink_path = bin_dir.join("band");
        symlink(&sidecar, &symlink_path).unwrap();

        let status = check_cli(&symlink_path, &sidecar);
        assert_eq!(status, CliStatus::Installed);
    }

    #[test]
    fn check_returns_conflicting_when_symlink_points_elsewhere() {
        let tmp = TempDir::new().unwrap();
        let bin_dir = tmp.path().join("bin");
        fs::create_dir_all(&bin_dir).unwrap();

        let sidecar = make_sidecar(tmp.path());
        let other_binary = tmp.path().join("other-band");
        fs::write(&other_binary, "other").unwrap();

        let symlink_path = bin_dir.join("band");
        symlink(&other_binary, &symlink_path).unwrap();

        let status = check_cli(&symlink_path, &sidecar);
        assert_eq!(status, CliStatus::ConflictingBinary);
    }

    #[test]
    fn check_returns_conflicting_when_regular_file_exists() {
        let tmp = TempDir::new().unwrap();
        let bin_dir = tmp.path().join("bin");
        fs::create_dir_all(&bin_dir).unwrap();

        let sidecar = make_sidecar(tmp.path());
        let symlink_path = bin_dir.join("band");
        fs::write(&symlink_path, "some-other-binary").unwrap();

        let status = check_cli(&symlink_path, &sidecar);
        assert_eq!(status, CliStatus::ConflictingBinary);
    }

    #[test]
    fn check_returns_dir_not_found_when_parent_missing() {
        let tmp = TempDir::new().unwrap();
        let symlink_path = tmp.path().join("nonexistent").join("bin").join("band");
        let sidecar = make_sidecar(tmp.path());

        let status = check_cli(&symlink_path, &sidecar);
        assert_eq!(status, CliStatus::DirNotFound);
    }

    #[test]
    fn check_handles_broken_symlink() {
        let tmp = TempDir::new().unwrap();
        let bin_dir = tmp.path().join("bin");
        fs::create_dir_all(&bin_dir).unwrap();

        let sidecar = make_sidecar(tmp.path());
        let ghost = tmp.path().join("ghost-binary");
        let symlink_path = bin_dir.join("band");
        // Create symlink to a file that doesn't exist
        symlink(&ghost, &symlink_path).unwrap();

        // Broken symlink: symlink_metadata() succeeds but exists() returns false
        // read_link succeeds and returns the ghost path, which != sidecar
        let status = check_cli(&symlink_path, &sidecar);
        assert_eq!(status, CliStatus::ConflictingBinary);
    }

    #[test]
    fn install_creates_symlink() {
        let tmp = TempDir::new().unwrap();
        let bin_dir = tmp.path().join("bin");
        fs::create_dir_all(&bin_dir).unwrap();

        let sidecar = make_sidecar(tmp.path());
        let symlink_path = bin_dir.join("band");

        install_cli(&symlink_path, &sidecar).unwrap();

        assert!(symlink_path.symlink_metadata().unwrap().file_type().is_symlink());
        assert_eq!(fs::read_link(&symlink_path).unwrap(), sidecar);
    }

    #[test]
    fn install_creates_parent_dir_if_missing() {
        let tmp = TempDir::new().unwrap();
        let symlink_path = tmp.path().join("new-dir").join("band");
        let sidecar = make_sidecar(tmp.path());

        install_cli(&symlink_path, &sidecar).unwrap();

        assert!(symlink_path.symlink_metadata().unwrap().file_type().is_symlink());
        assert_eq!(fs::read_link(&symlink_path).unwrap(), sidecar);
    }

    #[test]
    fn install_replaces_existing_symlink() {
        let tmp = TempDir::new().unwrap();
        let bin_dir = tmp.path().join("bin");
        fs::create_dir_all(&bin_dir).unwrap();

        let old_target = tmp.path().join("old-band");
        fs::write(&old_target, "old").unwrap();
        let symlink_path = bin_dir.join("band");
        symlink(&old_target, &symlink_path).unwrap();

        let sidecar = make_sidecar(tmp.path());
        install_cli(&symlink_path, &sidecar).unwrap();

        assert_eq!(fs::read_link(&symlink_path).unwrap(), sidecar);
    }

    #[test]
    fn install_replaces_regular_file() {
        let tmp = TempDir::new().unwrap();
        let bin_dir = tmp.path().join("bin");
        fs::create_dir_all(&bin_dir).unwrap();

        let symlink_path = bin_dir.join("band");
        fs::write(&symlink_path, "existing-binary").unwrap();

        let sidecar = make_sidecar(tmp.path());
        install_cli(&symlink_path, &sidecar).unwrap();

        assert!(symlink_path.symlink_metadata().unwrap().file_type().is_symlink());
        assert_eq!(fs::read_link(&symlink_path).unwrap(), sidecar);
    }

    #[test]
    fn install_then_check_reports_installed() {
        let tmp = TempDir::new().unwrap();
        let bin_dir = tmp.path().join("bin");
        fs::create_dir_all(&bin_dir).unwrap();

        let sidecar = make_sidecar(tmp.path());
        let symlink_path = bin_dir.join("band");

        // Before install
        assert_eq!(check_cli(&symlink_path, &sidecar), CliStatus::NotInstalled);

        // Install
        install_cli(&symlink_path, &sidecar).unwrap();

        // After install
        assert_eq!(check_cli(&symlink_path, &sidecar), CliStatus::Installed);
    }

    #[test]
    fn install_over_conflict_then_check_reports_installed() {
        let tmp = TempDir::new().unwrap();
        let bin_dir = tmp.path().join("bin");
        fs::create_dir_all(&bin_dir).unwrap();

        let sidecar = make_sidecar(tmp.path());
        let symlink_path = bin_dir.join("band");

        // Create conflicting file
        fs::write(&symlink_path, "other-binary").unwrap();
        assert_eq!(
            check_cli(&symlink_path, &sidecar),
            CliStatus::ConflictingBinary
        );

        // Install over it
        install_cli(&symlink_path, &sidecar).unwrap();
        assert_eq!(check_cli(&symlink_path, &sidecar), CliStatus::Installed);
    }

    #[test]
    fn check_not_writable_dir() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = TempDir::new().unwrap();
        let bin_dir = tmp.path().join("readonly-bin");
        fs::create_dir_all(&bin_dir).unwrap();

        // Make directory read-only
        fs::set_permissions(&bin_dir, fs::Permissions::from_mode(0o555)).unwrap();

        let sidecar = make_sidecar(tmp.path());
        let symlink_path = bin_dir.join("band");

        let status = check_cli(&symlink_path, &sidecar);

        // Restore permissions so temp dir cleanup works
        fs::set_permissions(&bin_dir, fs::Permissions::from_mode(0o755)).unwrap();

        assert_eq!(status, CliStatus::NotWritable);
    }
}
