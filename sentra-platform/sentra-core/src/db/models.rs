use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct User {
    pub id: i64,
    pub telegram_id: i64,
    pub username: Option<String>,
    pub first_name: String,
    pub last_name: Option<String>,
    pub role: String,
    pub status: String,
    pub auth_code: Option<String>,
    pub auth_code_expires_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
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
