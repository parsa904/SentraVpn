use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectRequest {
    pub config_json: String,
    pub split_tunnel_ir: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectResponse {
    pub success: bool,
    pub status: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DisconnectResponse {
    pub success: bool,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VpnStatusResponse {
    pub is_active: bool,
    pub mode: String,
    pub download_speed_bps: u64,
    pub upload_speed_bps: u64,
    pub total_down_bytes: u64,
    pub total_up_bytes: u64,
    pub uptime_seconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionPayloadRequest {
    pub payload: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionSaveResponse {
    pub success: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionLoadResponse {
    pub found: bool,
    pub payload: String,
}
