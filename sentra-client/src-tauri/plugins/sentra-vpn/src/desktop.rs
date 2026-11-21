use crate::models::*;
use tauri::Runtime;

pub struct SentraVpn<R: Runtime>(std::marker::PhantomData<fn() -> R>);

unsafe impl<R: Runtime> Send for SentraVpn<R> {}
unsafe impl<R: Runtime> Sync for SentraVpn<R> {}

impl<R: Runtime> SentraVpn<R> {
    pub fn new() -> Self {
        Self(std::marker::PhantomData)
    }

    pub fn connect(&self, _config_json: String, _split_tunnel_ir: bool) -> Result<ConnectResponse, String> {
        Ok(ConnectResponse {
            success: true,
            status: "Connected".to_string(),
            message: Some("Desktop mode: Handled via native Sidecar runner".to_string()),
        })
    }

    pub fn disconnect(&self) -> Result<DisconnectResponse, String> {
        Ok(DisconnectResponse {
            success: true,
            status: "Disconnected".to_string(),
        })
    }

    pub fn get_status(&self) -> Result<VpnStatusResponse, String> {
        Ok(VpnStatusResponse {
            is_active: false,
            mode: "Sentra Auto".to_string(),
            download_speed_bps: 0,
            upload_speed_bps: 0,
            total_down_bytes: 0,
            total_up_bytes: 0,
            uptime_seconds: 0,
        })
    }
}
