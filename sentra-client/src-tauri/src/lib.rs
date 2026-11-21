pub mod auth;
pub mod commands;
pub mod error;
pub mod sandbox;
pub mod state;
pub mod telemetry;
pub mod vpn_manager;

use auth::AuthManager;
use state::{AppState, ClientState};
use std::sync::Arc;
use tauri::Manager;
use tokio::sync::Mutex;
use tracing::info;
use vpn_manager::VpnManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,sentra_connect=debug".into()),
        )
        .init();

    info!("Initializing Sentra Connect Tauri v2 Desktop Application...");

    let mut initial_state = ClientState::default();

    // Check for saved persistent session
    if let Some(session) = AuthManager::load_saved_session() {
        info!("Restoring persistent session for user: {}", session.username);
        initial_state.is_authenticated = true;
        initial_state.auth_token = Some(session.auth_token);
        initial_state.subscription_token = Some(session.subscription_token);
        initial_state.tier = session.tier;
        initial_state.username = session.username;
        initial_state.remaining_bytes = session.remaining_bytes;
        initial_state.logs.push("[INFO] [Auth] Restored active session from local storage.".to_string());
    }

    let app_state: AppState = Arc::new(Mutex::new(initial_state));
    let vpn_manager = Arc::new(VpnManager::new());

    let vpn_manager_for_shutdown = Arc::clone(&vpn_manager);
    let app_state_for_shutdown = Arc::clone(&app_state);

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_sentra_vpn::init())
        .manage(app_state)
        .manage(vpn_manager)
        .invoke_handler(tauri::generate_handler![
            commands::login_with_code,
            commands::register_with_credentials,
            commands::login_with_credentials,
            commands::get_telegram_link_code,
            commands::get_client_state,
            commands::connect_vpn,
            commands::disconnect_vpn,
            commands::toggle_sandbox_mode,
            commands::toggle_split_tunneling,
            commands::toggle_tun_mode,
            commands::toggle_kill_switch,
            commands::get_connection_modes,
            commands::set_connection_mode,
            commands::set_connection_protocol,
            commands::test_api_connection,
            commands::get_logs,
            commands::clear_logs,
            commands::logout,
            commands::get_current_device_id,
            commands::get_user_devices,
            commands::remove_user_device,
            commands::replace_user_device,
            commands::check_client_version,
            commands::check_admin_privileges,
            commands::test_anti_dpi_settings,
            commands::save_anti_dpi_settings
        ])
        .on_window_event(move |window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                info!("Window close requested. Performing graceful VPN shutdown & interface cleanup...");
                let vpn = Arc::clone(&vpn_manager_for_shutdown);
                let state = Arc::clone(&app_state_for_shutdown);
                let handle = window.app_handle().clone();
                tauri::async_runtime::block_on(async move {
                    let _ = vpn.stop_vpn(handle, state).await;
                });
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Sentra Connect tauri application");

    app.run(|_app_handle, _event| {});
}
