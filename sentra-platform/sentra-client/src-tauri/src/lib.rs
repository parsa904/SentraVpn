mod commands;
mod config_manager;
mod sidecar;
mod state;

use commands::CommandContext;
use sidecar::SidecarManager;
use state::{AppState, ClientState};
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::info;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,sentra_connect=debug".into()),
        )
        .init();

    info!("Initializing Sentra Connect Tauri v2 Application (Desktop & Android Mobile)...");

    let app_state: AppState = Arc::new(Mutex::new(ClientState::default()));
    let sidecar_manager = Arc::new(SidecarManager::new());

    let command_context = CommandContext {
        sidecar: sidecar_manager,
    };

    tauri::Builder::default()
        .manage(app_state)
        .manage(command_context)
        .invoke_handler(tauri::generate_handler![
            commands::login_with_code,
            commands::get_client_state,
            commands::start_vpn,
            commands::stop_vpn,
            commands::get_vpn_stats,
            commands::connect_vpn,
            commands::disconnect_vpn,
            commands::toggle_sandbox_mode,
            commands::toggle_split_tunneling,
            commands::toggle_kill_switch,
            commands::set_protocol_mode,
            commands::set_location,
            commands::get_logs,
            commands::logout
        ])
        .run(tauri::generate_context!())
        .expect("error while running Sentra Connect tauri application");
}
