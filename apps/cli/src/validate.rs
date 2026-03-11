/// Validate a user-provided name (project name, branch name, etc.).
///
/// Rejects empty strings, control characters, path traversals, and excessively long inputs.
pub fn validate_name(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!("{label} cannot be empty"));
    }
    if value.len() > 255 {
        return Err(format!("{label} is too long (max 255 characters)"));
    }
    if value.bytes().any(|b| b < 0x20) {
        return Err(format!("{label} cannot contain control characters"));
    }
    if value.split('/').any(|seg| seg == "..") {
        return Err(format!("{label} cannot contain path traversals (..)"));
    }
    Ok(())
}

/// Validate a user-provided filesystem path (e.g. for `projects add`).
///
/// Rejects empty strings, control characters, and excessively long inputs.
pub fn validate_path(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!("{label} cannot be empty"));
    }
    if value.len() > 4096 {
        return Err(format!("{label} is too long (max 4096 characters)"));
    }
    if value.bytes().any(|b| b < 0x20) {
        return Err(format!("{label} cannot contain control characters"));
    }
    Ok(())
}
