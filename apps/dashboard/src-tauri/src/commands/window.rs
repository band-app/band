/// Returns the dynamic title shown in the Tauri title bar — `Band - <branch>`
/// when the dashboard repo has a current branch, falling back to `Band`.
#[tauri::command]
pub fn get_app_title() -> String {
    match crate::git::get_current_branch() {
        Some(branch) => format!("Band - {branch}"),
        None => "Band".to_string(),
    }
}
