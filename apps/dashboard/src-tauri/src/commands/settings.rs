use crate::state;

#[tauri::command]
pub fn settings_get() -> Result<state::Settings, String> {
    state::load_settings()
}

#[tauri::command]
pub fn settings_update(settings: state::Settings) -> Result<(), String> {
    state::save_settings(&settings)
}
