use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ConnectionStatus {
    Disconnected,
    Connecting,
    Connected,
    Error(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelemetryMetrics {
    pub download_speed_bps: u64, // Bytes per second
    pub upload_speed_bps: u64,   // Bytes per second
    pub ping_ms: u32,
    pub total_download_bytes: u64,
    pub total_upload_bytes: u64,
    pub uptime_seconds: u64,
}

impl Default for TelemetryMetrics {
    fn default() -> Self {
        Self {
            download_speed_bps: 0,
            upload_speed_bps: 0,
            ping_ms: 0,
            total_download_bytes: 0,
            total_upload_bytes: 0,
            uptime_seconds: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AntiDpiSettings {
    pub preset: String, // "normal" | "severe_filtering" | "national_disruption" | "custom"
    pub tls_fragment: bool,
    pub fragment_length: String, // "10-30" or "50-100"
    pub fragment_interval: String, // "10-20ms"
    pub mux_padding: bool,
    pub dns_mode: String, // "cloudflare" | "google" | "quad9" | "fakeip"
    pub mtu: u32, // 1400, 1280, 1200
}

impl Default for AntiDpiSettings {
    fn default() -> Self {
        Self {
            preset: "normal".to_string(),
            tls_fragment: true,
            fragment_length: "10-30".to_string(),
            fragment_interval: "10-20ms".to_string(),
            mux_padding: true,
            dns_mode: "cloudflare".to_string(),
            mtu: 1400,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientState {
    pub is_authenticated: bool,
    pub auth_token: Option<String>,
    pub subscription_token: Option<String>,
    pub tier: String,
    pub username: String,
    pub remaining_bytes: i64,
    pub expires_at: Option<String>,
    pub status: ConnectionStatus,
    pub selected_mode: String,
    pub selected_protocol: String,
    pub selected_location: String,
    pub sandbox_loopback: bool,
    pub split_tunneling: bool,
    pub tun_mode: bool,
    pub kill_switch: bool,
    pub anti_dpi: AntiDpiSettings,
    pub connected_since: Option<DateTime<Utc>>,
    pub metrics: TelemetryMetrics,
    pub logs: Vec<String>,
}

impl Default for ClientState {
    fn default() -> Self {
        Self {
            is_authenticated: false,
            auth_token: None,
            subscription_token: None,
            tier: "Sentra Lite".to_string(),
            username: "مهمان".to_string(),
            remaining_bytes: 10_737_418_240, // 10 GB default
            expires_at: None,
            status: ConnectionStatus::Disconnected,
            selected_mode: "web_browsing".to_string(),
            selected_protocol: "openvpn_udp".to_string(),
            selected_location: "US 🇺🇸 سرور مسکونی آمریکا".to_string(),
            sandbox_loopback: true, // Enabled for zero-cost testing
            split_tunneling: true,
            tun_mode: false, // Default to System Proxy mode (Windows safe unprivileged execution)
            kill_switch: false,
            anti_dpi: AntiDpiSettings::default(),
            connected_since: None,
            metrics: TelemetryMetrics::default(),
            logs: vec![
                "[INFO] [Core] Sentra Connect engine initialized.".to_string(),
                "[INFO] [Mode] Defaulting to System Proxy mode (Kernel TUN requires Administrator).".to_string(),
                "[INFO] [Anti-DPI] Laboratory ready with Normal, Severe Filtering & National presets.".to_string(),
                "[INFO] [Sandbox] Local loopback sandbox ready on 127.0.0.1:10801-10804.".to_string(),
            ],
        }
    }
}

pub type AppState = Arc<Mutex<ClientState>>;
