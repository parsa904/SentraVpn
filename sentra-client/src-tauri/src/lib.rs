pub mod auth;
pub mod commands;
pub mod error;
pub mod error_reporter;
pub mod local_proxy;
pub mod sandbox;
pub mod state;
pub mod sysproxy;
pub mod telemetry;
pub mod vpn_manager;

use auth::AuthManager;
use state::{AppState, ClientState, ConnectionStatus};
use std::sync::Arc;
use tauri::Manager;
use tokio::sync::Mutex;
use tracing::info;
use vpn_manager::VpnManager;

#[cfg(desktop)]
fn setup_desktop_tray(
    app: &tauri::App,
    vpn_manager: Arc<VpnManager>,
    app_state: AppState,
) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let open_item = MenuItem::with_id(app, "tray_open", "Open Sentra", true, None::<&str>)?;
    let toggle_item =
        MenuItem::with_id(app, "tray_toggle", "Connect / Disconnect", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "tray_quit", "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&open_item, &toggle_item, &quit_item])?;

    let mut builder = TrayIconBuilder::with_id("sentra-tray")
        .menu(&menu)
        .tooltip("Sentra Connect")
        .show_menu_on_left_click(false)
        .on_menu_event(move |app_handle, event| match event.id.as_ref() {
            "tray_open" => {
                if let Some(win) = app_handle.get_webview_window("main") {
                    let _ = win.unminimize();
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
            "tray_toggle" => {
                let vpn = Arc::clone(&vpn_manager);
                let state = Arc::clone(&app_state);
                let handle = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    let is_active = {
                        let s = state.lock().await;
                        matches!(
                            s.status,
                            ConnectionStatus::Connected | ConnectionStatus::Connecting
                        )
                    };
                    if is_active {
                        let _ = vpn.stop_vpn(handle, state).await;
                    } else {
                        let _ = vpn.start_vpn(handle, state).await;
                    }
                });
            }
            "tray_quit" => {
                info!("Tray Quit triggered: disconnecting VPN & resetting Windows system proxy...");
                let vpn = Arc::clone(&vpn_manager);
                let state = Arc::clone(&app_state);
                let handle = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = vpn.stop_vpn(handle.clone(), state).await;
                    let _ = sysproxy::disable_system_proxy();
                    handle.exit(0);
                });
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app_handle = tray.app_handle();
                if let Some(win) = app_handle.get_webview_window("main") {
                    let _ = win.unminimize();
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    let _tray = builder.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,sentra_connect=debug".into()),
        )
        .init();

    info!("Initializing Sentra Connect Tauri v2 Application...");
    error_reporter::install_panic_hook();

    // Safe startup reset: Ensure System Proxy is clean if prior run terminated abnormally
    let _ = sysproxy::disable_system_proxy();

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
        initial_state
            .logs
            .push("[INFO] [Auth] Restored active session from local storage.".to_string());
    }

    let app_state: AppState = Arc::new(Mutex::new(initial_state));
    let vpn_manager = Arc::new(VpnManager::new());

    let vpn_for_tray = Arc::clone(&vpn_manager);
    let state_for_tray = Arc::clone(&app_state);

    let vpn_for_watchdog = Arc::clone(&vpn_manager);
    let state_for_watchdog = Arc::clone(&app_state);

    let vpn_for_close = Arc::clone(&vpn_manager);
    let state_for_close = Arc::clone(&app_state);

    let vpn_for_exit = Arc::clone(&vpn_manager);
    let state_for_exit = Arc::clone(&app_state);

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_sentra_vpn::init())
        .manage(app_state)
        .manage(vpn_manager)
        .setup(move |app| {
            #[cfg(desktop)]
            {
                if let Err(err) = setup_desktop_tray(app, vpn_for_tray, state_for_tray) {
                    tracing::warn!("Failed to initialize System Tray icon: {}", err);
                }
                vpn_for_watchdog.spawn_network_and_wake_watchdog(
                    app.handle().clone(),
                    state_for_watchdog,
                );
            }
            #[cfg(not(desktop))]
            {
                let _ = (app, vpn_for_tray, state_for_tray, vpn_for_watchdog, state_for_watchdog);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::login_with_code,
            commands::register_with_credentials,
            commands::login_with_credentials,
            commands::get_telegram_link_code,
            commands::get_client_state,
            commands::connect_vpn,
            commands::disconnect_vpn,
            commands::reconnect_vpn,
            commands::toggle_sandbox_mode,
            commands::toggle_split_tunneling,
            commands::toggle_tun_mode,
            commands::toggle_kill_switch,
            commands::set_auto_reconnect,
            commands::get_battery_optimization_status,
            commands::open_battery_optimization_settings,
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
            commands::save_anti_dpi_settings,
            commands::set_connection_location,
            commands::get_available_locations,
            commands::ping_dns_servers,
            commands::save_dns_settings,
            commands::get_dns_settings,
            commands::set_use_warp,
            commands::set_routing_mode,
            commands::fetch_client_bootstrap,
            commands::ping_server_node,
            commands::donate_user_outbound,
            commands::get_my_donated_outbounds,
            commands::save_personal_configs,
            commands::load_personal_configs,
            commands::set_selected_outbound,
            commands::save_persisted_session,
            commands::load_persisted_session,
            commands::clear_persisted_session,
            commands::fetch_client_state_from_server,
            commands::sync_client_state_to_server,
            commands::report_usage_heartbeat
        ])
        .on_window_event(move |window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let vpn = Arc::clone(&vpn_for_close);
                let state = Arc::clone(&state_for_close);

                #[cfg(desktop)]
                {
                    let is_active = tauri::async_runtime::block_on(async {
                        let s = state.lock().await;
                        matches!(
                            s.status,
                            ConnectionStatus::Connected | ConnectionStatus::Connecting
                        )
                    });

                    if is_active {
                        info!("VPN is active on close request: minimizing Sentra Connect to System Tray.");
                        api.prevent_close();
                        let _ = window.hide();
                        return;
                    }
                }
                #[cfg(not(desktop))]
                {
                    let _ = api;
                }

                info!("Window close requested while disconnected. Ensuring proxy/tunnel cleanup...");
                let handle = window.app_handle().clone();
                tauri::async_runtime::block_on(async move {
                    let _ = vpn.stop_vpn(handle, state).await;
                    let _ = sysproxy::disable_system_proxy();
                });
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Sentra Connect tauri application");

    app.run(move |app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            info!("Application exiting: running final safe disconnect & Windows system proxy reset.");
            let vpn = Arc::clone(&vpn_for_exit);
            let state = Arc::clone(&state_for_exit);
            let handle = app_handle.clone();
            tauri::async_runtime::block_on(async move {
                let _ = vpn.stop_vpn(handle, state).await;
                let _ = sysproxy::disable_system_proxy();
            });
        }
    });
}
