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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TelemetryMetrics {
    pub download_speed_bps: u64, // Bytes per second
    pub upload_speed_bps: u64,   // Bytes per second
    pub ping_ms: u32,
    pub total_download_bytes: u64,
    pub total_upload_bytes: u64,
    pub uptime_seconds: u64,
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
pub struct CustomDnsEntry {
    pub id: String,
    pub name: String,
    pub address: String, // IPv4 or DoH URL
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DnsPingItem {
    pub id: String,
    pub name: String,
    pub address: String,
    pub ping_ms: i64,
    pub is_iranian: bool,
    pub is_custom: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DnsConfig {
    pub selected_dns_id: String,
    pub selected_dns_address: String,
    pub custom_servers: Vec<CustomDnsEntry>,
}

impl Default for DnsConfig {
    fn default() -> Self {
        Self {
            selected_dns_id: "cloudflare".to_string(),
            selected_dns_address: "1.1.1.1".to_string(),
            custom_servers: Vec::new(),
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
    pub selected_outbound_id: Option<String>,
    pub selected_personal_uri: Option<String>,
    pub routing_mode: String, // "tunnel" | "system_proxy" | "proxy"
    pub local_socks5_port: u16,
    pub local_http_port: u16,
    pub use_warp: bool,
    pub sandbox_loopback: bool,
    pub split_tunneling: bool,
    pub tun_mode: bool,
    pub kill_switch: bool,
    pub anti_dpi: AntiDpiSettings,
    pub dns_config: DnsConfig,
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
            tier: String::new(),
            username: String::new(),
            remaining_bytes: 0,
            expires_at: None,
            status: ConnectionStatus::Disconnected,
            selected_mode: "web_browsing".to_string(),
            selected_protocol: "openvpn_udp".to_string(),
            selected_location: "auto".to_string(),
            selected_outbound_id: None,
            selected_personal_uri: None,
            routing_mode: "tunnel".to_string(),
            local_socks5_port: 10808,
            local_http_port: 10809,
            use_warp: false,
            sandbox_loopback: false,
            split_tunneling: true,
            tun_mode: false,
            kill_switch: false,
            anti_dpi: AntiDpiSettings::default(),
            dns_config: DnsConfig::default(),
            connected_since: None,
            metrics: TelemetryMetrics::default(),
            logs: vec![
                "[INFO] [Core] Sentra Connect engine initialized.".to_string(),
            ],
        }
    }
}

pub type AppState = Arc<Mutex<ClientState>>;
