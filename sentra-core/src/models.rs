use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct User {
    pub id: i64,
    pub user_uuid: String,
    pub telegram_id: Option<i64>,
    pub username: Option<String>,
    pub password_hash: Option<String>,
    pub first_name: String,
    pub last_name: Option<String>,
    pub photo_url: Option<String>,
    pub role: String,
    pub status: String,
    pub auth_code: Option<String>,
    pub auth_code_expires_at: Option<DateTime<Utc>>,
    pub link_code: Option<String>,
    pub link_code_expires_at: Option<DateTime<Utc>>,
    pub outbound_reward_banned: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct DonatedOutbound {
    pub id: i64,
    pub donor_user_id: Option<i64>,
    pub tag: String,
    pub protocol: String,
    pub server_address: String,
    pub server_port: i64,
    pub config_json: String,
    pub latency_ms: i64,
    pub speed_mbps: f64,
    pub assigned_tier: String,
    pub health_score: i64,
    pub status: String,
    pub fail_count: i64,
    pub reward_granted: i64,
    pub raw_link: Option<String>,
    pub rejection_reason: Option<String>,
    pub declared_or_detected_gb: i64,
    pub bytes_served: i64,
    pub first_used_at: Option<DateTime<Utc>>,
    pub monthly_reward_granted: i64,
    pub fingerprint_sha256: Option<String>,
    pub offline_since: Option<DateTime<Utc>>,
    pub clawback_executed: i64,
    pub is_official: i64,
    pub label: Option<String>,
    pub country_code: String,
    pub country_name: String,
    pub last_checked_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub allow_web: i64,
    pub allow_download: i64,
    pub allow_static_ip: i64,
    pub gemini_ok: i64,
    pub trading_safe: i64,
    pub speed_score: i64,
    pub jitter_ms: i64,
    pub last_online_at: Option<DateTime<Utc>>,
    pub allocation_mode: String,
    #[sqlx(default)]
    pub reward_days: i64,
    #[sqlx(default)]
    pub user_note: Option<String>,
    #[sqlx(default)]
    pub approved_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Donation {
    pub id: i64,
    pub user_id: i64,
    pub amount: i64,
    pub receipt_file_id: String,
    pub file_unique_id: Option<String>,
    pub image_sha256: Option<String>,
    pub status: String, // "pending", "approved", "rejected"
    pub subscription_granted: i64, // 0 or 1
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Subscription {
    pub id: i64,
    pub user_id: i64,
    pub tier: String,
    pub token: String,
    pub status: String,
    pub upload_bytes: i64,
    pub download_bytes: i64,
    pub traffic_limit_bytes: i64,
    pub speed_limit_bps: i64,
    pub max_concurrent_devices: i64,
    pub web_browsing_used_mb: i64,
    pub download_used_mb: i64,
    pub static_ip_used_mb: i64,
    pub last_quota_reset: DateTime<Utc>,
    pub starts_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Outbound {
    pub id: i64,
    pub tag: String,
    pub protocol: String,
    pub server_address: String,
    pub server_port: i64,
    pub uuid: Option<String>,
    pub password: Option<String>,
    pub network_transport: String,
    pub tls_enabled: i64,
    pub tls_sni: Option<String>,
    pub reality_public_key: Option<String>,
    pub reality_short_id: Option<String>,
    pub min_tier: String,
    pub mode_category: String,
    pub country_code: String,
    pub is_active: i64,
    pub weight: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[allow(dead_code)]
pub struct DeviceSession {
    pub id: i64,
    pub subscription_id: i64,
    pub device_identifier: String,
    pub device_name: String,
    pub os: String,
    pub client_version: String,
    pub ip_address: String,
    pub is_active: i64,
    pub last_seen_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[allow(dead_code)]
pub struct TrafficLog {
    pub id: i64,
    pub subscription_id: i64,
    pub outbound_id: Option<i64>,
    pub bytes_sent: i64,
    pub bytes_received: i64,
    pub recorded_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[allow(dead_code)]
pub struct SupportTicket {
    pub id: i64,
    pub ticket_number: String,
    pub user_id: i64,
    pub subscription_id: Option<i64>,
    pub category: String,
    pub subject: String,
    pub description: String,
    pub priority: String,
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionModeInfo {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub status: String, // "active", "locked", "coming_soon"
    pub badge: Option<String>,
    pub daily_limit_mb: i64,
    pub used_today_mb: i64,
    pub remaining_today_mb: i64,
    pub speed_desc: String,
    pub security_desc: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct UserDevice {
    pub id: i64,
    pub user_id: i64,
    pub subscription_id: i64,
    pub device_id: String,
    pub device_name: String,
    pub platform: String,
    pub last_active_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct AppRelease {
    pub platform: String,
    pub version: String,
    pub telegram_file_id: String,
    pub file_name: String,
    pub file_size_mb: f64,
    pub changelog: String,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct SubscriptionSource {
    pub id: i64,
    pub category: String,
    pub url: String,
    pub label: Option<String>,
    pub node_count: i64,
    pub healthy_count: i64,
    pub last_synced_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActiveLocationInfo {
    pub code: String,
    pub name: String,
    pub country_code: String,
    pub flag: String,
    pub ping_ms: i64,
    pub active_nodes: i64,
    pub is_auto: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct WarpAccount {
    pub id: i64,
    pub private_key: String,
    pub public_key: String,
    pub address_v4: String,
    pub address_v6: String,
    pub reserved: String, // JSON array string e.g. "[0,0,0]"
    pub account_id: Option<String>,
    pub token: Option<String>,
    pub license_key: Option<String>,
    pub account_type: String, // "free" or "plus"
    pub is_active: i64,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientOutboundInfo {
    pub id: String,
    pub db_id: i64,
    pub name: String,
    pub tag: String,
    pub protocol: String,
    pub category: String,
    pub country_code: String,
    pub country_name: String,
    pub flag: String,
    pub latency_ms: i64,
    pub health_score: i64,
    pub is_official: bool,
    pub is_online: bool,
    pub server_address: String,
    pub server_port: i64,
    pub uri: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MyDonatedOutboundItem {
    pub id: i64,
    pub name: String,
    pub protocol: String,
    pub server_address: String,
    pub server_port: i64,
    pub country_code: String,
    pub flag: String,
    pub latency_ms: i64,
    pub status: String, // "pending" | "approved" | "rejected" | "inactive"
    pub reward_days: i64,
    pub user_note: Option<String>,
    pub rejection_reason: Option<String>,
    pub created_at: String,
    pub approved_at: Option<String>,
}
