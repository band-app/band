#[cfg(target_os = "macos")]
pub mod macos_shell;
#[cfg(not(target_os = "macos"))]
pub mod macos_shell_stub;
#[cfg(not(target_os = "macos"))]
pub use macos_shell_stub as macos_shell;

pub mod browser;
pub mod updater;
pub mod webserver;
pub mod window;
