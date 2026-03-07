fn main() {
    // Write the target triple so the CLI sidecar command can find the binary at runtime
    let out_dir = std::env::var("OUT_DIR").unwrap();
    let triple = std::env::var("TARGET").unwrap();
    std::fs::write(format!("{out_dir}/target_triple.txt"), &triple).unwrap();

    tauri_build::build();
}
