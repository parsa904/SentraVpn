use tauri::{
    plugin::{Builder, TauriPlugin},
    AppHandle, Manager, Runtime,
};

pub mod models;
pub use models::*;

#[cfg(desktop)]
mod desktop;
#[cfg(desktop)]
pub use desktop::SentraVpn;

#[cfg(mobile)]
mod mobile;
#[cfg(mobile)]
pub use mobile::SentraVpn;

#[tauri::command]
async fn connect<R: Runtime>(
    app: AppHandle<R>,
    config_json: String,
    split_tunnel_ir: bool,
) -> Result<ConnectResponse, String> {
    app.sentra_vpn().connect(config_json, split_tunnel_ir)
}

#[tauri::command]
async fn disconnect<R: Runtime>(app: AppHandle<R>) -> Result<DisconnectResponse, String> {
    app.sentra_vpn().disconnect()
}

#[tauri::command]
async fn get_status<R: Runtime>(app: AppHandle<R>) -> Result<VpnStatusResponse, String> {
    app.sentra_vpn().get_status()
}

#[tauri::command]
async fn save_session<R: Runtime>(app: AppHandle<R>, payload: String) -> Result<SessionSaveResponse, String> {
    app.sentra_vpn().save_session(payload)
}

#[tauri::command]
async fn load_session<R: Runtime>(app: AppHandle<R>) -> Result<SessionLoadResponse, String> {
    app.sentra_vpn().load_session()
}

#[tauri::command]
async fn clear_session<R: Runtime>(app: AppHandle<R>) -> Result<SessionSaveResponse, String> {
    app.sentra_vpn().clear_session()
}

#[tauri::command]
async fn set_auto_reconnect<R: Runtime>(
    app: AppHandle<R>,
    enabled: bool,
) -> Result<SimpleSuccessResponse, String> {
    app.sentra_vpn().set_auto_reconnect(enabled)
}

#[tauri::command]
async fn get_battery_optimization_status<R: Runtime>(
    app: AppHandle<R>,
) -> Result<BatteryOptimizationStatusResponse, String> {
    app.sentra_vpn().get_battery_optimization_status()
}

#[tauri::command]
async fn open_battery_optimization_settings<R: Runtime>(
    app: AppHandle<R>,
) -> Result<SimpleSuccessResponse, String> {
    app.sentra_vpn().open_battery_optimization_settings()
}

pub trait SentraVpnPluginExt<R: Runtime> {
    fn sentra_vpn(&self) -> &SentraVpn<R>;
}

impl<R: Runtime, T: Manager<R>> SentraVpnPluginExt<R> for T {
    fn sentra_vpn(&self) -> &SentraVpn<R> {
        self.state::<SentraVpn<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("sentra-vpn")
        .invoke_handler(tauri::generate_handler![
            connect,
            disconnect,
            get_status,
            save_session,
            load_session,
            clear_session,
            set_auto_reconnect,
            get_battery_optimization_status,
            open_battery_optimization_settings
        ])
        .setup(|app, _api| {
            #[cfg(mobile)]
            let sentra_vpn = mobile::init(app, _api)?;
            #[cfg(desktop)]
            let sentra_vpn = desktop::SentraVpn::<R>::new();

            app.manage(sentra_vpn);
            Ok(())
        })
        .build()
}
