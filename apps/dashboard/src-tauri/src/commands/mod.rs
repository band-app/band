#[cfg(target_os = "macos")]
pub mod apps;
#[cfg(target_os = "macos")]
pub mod ax_windows;
#[cfg(target_os = "macos")]
pub mod ide;
#[cfg(not(target_os = "macos"))]
pub mod ide_stub;
#[cfg(target_os = "macos")]
pub mod window_manager;
#[cfg(not(target_os = "macos"))]
pub use ide_stub as ide;
pub mod webserver;
