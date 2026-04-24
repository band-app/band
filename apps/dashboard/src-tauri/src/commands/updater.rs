use crate::dash_log;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

/// Whether the updater is enabled (true only when `TAURI_SIGNING_PRIVATE_KEY`
/// was present at compile time, i.e. in CI release builds).
pub const UPDATER_ENABLED: bool = option_env!("TAURI_SIGNING_PRIVATE_KEY").is_some();

/// Check for updates and prompt the user to install if one is available.
///
/// When `interactive` is true, a dialog is shown even when no update is found
/// (useful for the "Check for Updates…" menu item). When false, the check is
/// silent unless an update exists (used for the automatic startup check).
pub async fn check_for_update(app: tauri::AppHandle, interactive: bool) {
    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(e) => {
            dash_log!("updater: failed to create updater: {e}");
            if interactive {
                show_info(
                    &app,
                    "Update Error",
                    &format!("Failed to check for updates: {e}"),
                );
            }
            return;
        }
    };

    let update = match updater.check().await {
        Ok(update) => update,
        Err(e) => {
            dash_log!("updater: check failed: {e}");
            if interactive {
                show_info(
                    &app,
                    "Update Error",
                    "Failed to check for updates. Please try again later.",
                );
            }
            return;
        }
    };

    let Some(update) = update else {
        dash_log!("updater: no update available");
        if interactive {
            show_info(
                &app,
                "No Updates Available",
                "You're running the latest version of Band.",
            );
        }
        return;
    };

    let version = update.version.clone();
    dash_log!("updater: update available — v{version}");

    // Ask the user whether they want to install the update.
    let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
    app.dialog()
        .message(format!(
            "Band v{version} is available. Would you like to download and install it now?"
        ))
        .title("Update Available")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Update".into(),
            "Later".into(),
        ))
        .show(move |accepted| {
            let _ = tx.send(accepted);
        });

    if !rx.await.unwrap_or(false) {
        return;
    }

    dash_log!("updater: downloading v{version}…");

    if let Err(e) = update
        .download_and_install(
            |chunk_length, content_length| {
                dash_log!(
                    "updater: progress — {chunk_length} bytes (total: {})",
                    content_length.unwrap_or(0)
                );
            },
            || {
                dash_log!("updater: download finished, installing…");
            },
        )
        .await
    {
        dash_log!("updater: install failed: {e}");
        show_info(
            &app,
            "Update Failed",
            &format!("Failed to install the update: {e}"),
        );
        return;
    }

    dash_log!("updater: installed v{version}, restarting…");
    app.restart();
}

/// Show an informational message dialog (non-blocking, fire-and-forget).
fn show_info(app: &tauri::AppHandle, title: &str, message: &str) {
    app.dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Info)
        .show(|_| {});
}
