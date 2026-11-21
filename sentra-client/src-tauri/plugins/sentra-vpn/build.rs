const COMMANDS: &[&str] = &["connect", "disconnect", "get_status"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
