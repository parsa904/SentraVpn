use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct User {
    pub id: i64,
    pub user_uuid: String,
    pub telegram_id: Option<i64>,
    pub email: Option<String>,
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
    pub telegram_verified: i64,
    pub verify_code: Option<String>,
    pub verify_code_expires_at: Option<DateTime<Utc>>,
    pub outbound_reward_banned: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl User {
    #[allow(dead_code)]
    pub fn is_telegram_verified(&self) -> bool {
        self.telegram_verified != 0
    }

    pub fn fallback_user(user_id: i64) -> Self {
        Self {
            id: user_id,
            user_uuid: format!("usr-fallback-{:08x}", user_id),
            telegram_id: None,
            email: None,
            username: Some(format!("user_{}", user_id)),
            password_hash: None,
            first_name: "Sentra User".to_string(),
            last_name: None,
            photo_url: None,
            role: "user".to_string(),
            status: "active".to_string(),
            auth_code: None,
            auth_code_expires_at: None,
            link_code: None,
            link_code_expires_at: None,
            telegram_verified: 1,
            verify_code: None,
            verify_code_expires_at: None,
            outbound_reward_banned: 0,
            created_at: Utc::now() - chrono::Duration::days(10),
            updated_at: Utc::now(),
        }
    }
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
    #[serde(default)]
    #[sqlx(default)]
    pub quality_score: i64,
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
    #[serde(default)]
    #[sqlx(default)]
    pub gaming_used_mb: i64,
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
    #[serde(default)]
    #[sqlx(default)]
    pub country_name: Option<String>,
    #[serde(default)]
    #[sqlx(default)]
    pub quality_score: i64,
    #[serde(default)]
    #[sqlx(default)]
    pub latency_ms: i64,
    #[serde(default)]
    #[sqlx(default)]
    pub is_healthy: i64,
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
    pub id: i64,
    pub version: String,
    pub changelog: String,
    pub windows_file_id: Option<String>,
    pub windows_github_url: Option<String>,
    pub android_file_id: Option<String>,
    pub android_github_url: Option<String>,
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
