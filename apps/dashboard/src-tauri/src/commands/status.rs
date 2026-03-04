use crate::state;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::fs;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentInfo {
    pub name: String,
    pub status: String,
    #[serde(rename = "lastActivity")]
    pub last_activity: String,
    pub summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceStatus {
    #[serde(rename = "workspaceId")]
    pub workspace_id: String,
    pub project: String,
    pub branch: String,
    #[serde(rename = "worktreePath")]
    pub worktree_path: String,
    pub ide: String,
    pub pid: Option<u32>,
    pub agent: Option<AgentInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct StatusEvent {
    pub kind: String,
    pub status: Option<WorkspaceStatus>,
    #[serde(rename = "workspaceId")]
    pub workspace_id: Option<String>,
}

pub struct StatusWatcher {
    _watcher: RecommendedWatcher,
}

pub struct WatcherState(pub Arc<Mutex<Option<StatusWatcher>>>);

#[tauri::command]
pub fn status_watch_start(app: AppHandle) -> Result<(), String> {
    let status_dir = state::status_dir();
    fs::create_dir_all(&status_dir)
        .map_err(|e| format!("Failed to create status dir: {}", e))?;

    let app_handle = app.clone();

    let mut watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
        if let Ok(event) = res {
            match event.kind {
                EventKind::Create(_) | EventKind::Modify(_) => {
                    for path in &event.paths {
                        if let Some(ext) = path.extension() {
                            if ext == "json" {
                                // Emit active workspace changes as a separate event
                                if path.file_stem().map_or(false, |s| s == "active") {
                                    if let Ok(data) = fs::read_to_string(path) {
                                        #[derive(serde::Deserialize)]
                                        struct ActiveMarker {
                                            #[serde(rename = "workspaceId")]
                                            workspace_id: String,
                                        }
                                        if let Ok(marker) =
                                            serde_json::from_str::<ActiveMarker>(&data)
                                        {
                                            let _ = app_handle.emit(
                                                "active-workspace",
                                                marker.workspace_id,
                                            );
                                        }
                                    }
                                    continue;
                                }

                                if let Ok(data) = fs::read_to_string(path) {
                                    if let Ok(status) =
                                        serde_json::from_str::<WorkspaceStatus>(&data)
                                    {
                                        let _ = app_handle.emit(
                                            "agent-status",
                                            StatusEvent {
                                                kind: "update".to_string(),
                                                status: Some(status),
                                                workspace_id: None,
                                            },
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
                EventKind::Remove(_) => {
                    for path in &event.paths {
                        if let Some(stem) = path.file_stem() {
                            let workspace_id = stem.to_string_lossy().to_string();
                            let _ = app_handle.emit(
                                "agent-status",
                                StatusEvent {
                                    kind: "remove".to_string(),
                                    status: None,
                                    workspace_id: Some(workspace_id),
                                },
                            );
                        }
                    }
                }
                _ => {}
            }
        }
    })
    .map_err(|e| format!("Failed to create watcher: {}", e))?;

    watcher
        .watch(&status_dir, RecursiveMode::NonRecursive)
        .map_err(|e| format!("Failed to watch status dir: {}", e))?;

    // Also emit current status files on start
    if let Ok(entries) = fs::read_dir(&status_dir) {
        for entry in entries.flatten() {
            if entry.path().extension().map_or(false, |e| e == "json") {
                if let Ok(data) = fs::read_to_string(entry.path()) {
                    if let Ok(status) = serde_json::from_str::<WorkspaceStatus>(&data) {
                        let _ = app.emit(
                            "agent-status",
                            StatusEvent {
                                kind: "update".to_string(),
                                status: Some(status),
                                workspace_id: None,
                            },
                        );
                    }
                }
            }
        }
    }

    // Store watcher so it doesn't get dropped
    let watcher_state = app.state::<WatcherState>();
    let mut guard = watcher_state.0.lock().unwrap();
    *guard = Some(StatusWatcher {
        _watcher: watcher,
    });

    Ok(())
}

#[tauri::command]
pub fn status_watch_stop(app: AppHandle) -> Result<(), String> {
    let watcher_state = app.state::<WatcherState>();
    let mut guard = watcher_state.0.lock().unwrap();
    *guard = None;
    Ok(())
}
