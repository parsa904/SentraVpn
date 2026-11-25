use crate::compiler;
use crate::db::{DbPool, Repository};
use crate::error::CoreError;
use axum::{
    extract::{ConnectInfo, Path, Query, State},
    http::{header, HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
    Json, Router,
};
use std::net::SocketAddr;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use chrono::Utc;
use serde::Deserialize;
use serde_json::json;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::Mutex;

#[derive(Debug, Clone)]
struct IpAttempt {
    failed_count: u32,
    window_start: Instant,
    blocked_until: Option<Instant>,
}

#[derive(Debug, Clone, Default)]
pub struct LoginRateLimiter {
    records: Arc<Mutex<HashMap<String, IpAttempt>>>,
}

impl LoginRateLimiter {
    pub fn new() -> Self {
        Self {
            records: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Check if IP has exceeded 5 failed attempts in 10 minutes and is blocked
    pub async fn check_ip(&self, ip: &str) -> Result<(), CoreError> {
        let mut map = self.records.lock().await;
        let now = Instant::now();

        if let Some(entry) = map.get_mut(ip) {
            if let Some(blocked_until) = entry.blocked_until {
                if now < blocked_until {
                    let rem_secs = blocked_until.duration_since(now).as_secs();
                    return Err(CoreError::TooManyRequests(format!(
                        "به دلیل ۵ تلاش ناموفق مکرر، دسترسی از این IP موقتاً مسدود شده است. لطفاً {} ثانیه دیگر تلاش فرمایید.",
                        rem_secs
                    )));
                } else {
                    entry.blocked_until = None;
                    entry.failed_count = 0;
                    entry.window_start = now;
                }
            }

            if now.duration_since(entry.window_start).as_secs() > 600 {
                entry.failed_count = 0;
                entry.window_start = now;
            }
        }
        Ok(())
    }

    pub async fn record_failure(&self, ip: &str) {
        let mut map = self.records.lock().await;
        let now = Instant::now();
        let entry = map.entry(ip.to_string()).or_insert(IpAttempt {
            failed_count: 0,
            window_start: now,
            blocked_until: None,
        });

        if now.duration_since(entry.window_start).as_secs() > 600 {
            entry.failed_count = 1;
            entry.window_start = now;
        } else {
            entry.failed_count += 1;
        }

        if entry.failed_count >= 5 {
            entry.blocked_until = Some(now + std::time::Duration::from_secs(900));
            tracing::warn!("IP {} exceeded 5 failed login attempts in 10 minutes. Blocked for 15 minutes.", ip);
        }
    }

    pub async fn record_success(&self, ip: &str) {
        let mut map = self.records.lock().await;
        map.remove(ip);
    }
}

fn extract_client_ip(headers: &HeaderMap) -> String {
    extract_client_ip_with_peer(headers, None)
}

fn extract_client_ip_with_peer(headers: &HeaderMap, peer: Option<SocketAddr>) -> String {
    if let Some(xff) = headers.get("x-forwarded-for") {
        if let Ok(s) = xff.to_str() {
            if let Some(first) = s.split(',').next() {
                let trimmed = first.trim();
                if !trimmed.is_empty() {
                    return trimmed.to_string();
                }
            }
        }
    }
    if let Some(xreal) = headers.get("x-real-ip") {
        if let Ok(s) = xreal.to_str() {
            let trimmed = s.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    peer.map(|addr| addr.ip().to_string())
        .unwrap_or_else(|| "127.0.0.1".to_string())
}

#[derive(Clone)]
pub struct AppState {
    pub pool: DbPool,
    pub anomaly_detector: crate::anomaly_detector::AnomalyDetector,
    pub bot: Option<teloxide::Bot>,
    pub admin_chat_id: i64,
    pub rate_limiter: LoginRateLimiter,
    pub server_host: String,
    pub bot_username: String,
}

#[derive(Debug, Deserialize)]
pub struct CodeLoginRequest {
    pub code: String,
    pub device_identifier: Option<String>,
    pub device_name: Option<String>,
    pub os: Option<String>,
    pub client_version: Option<String>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct RegisterRequest {
    pub username: String,
    pub password: String,
    pub device_identifier: Option<String>,
    pub device_name: Option<String>,
    pub os: Option<String>,
    pub client_version: Option<String>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
    pub device_identifier: Option<String>,
    pub device_name: Option<String>,
    pub os: Option<String>,
    pub client_version: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct HeartbeatRequest {
    pub token: Option<String>,
    pub device_id: String,
    pub mode: Option<String>,
    #[serde(default)]
    pub delta_upload_bytes: u64,
    #[serde(default)]
    pub delta_download_bytes: u64,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct ConfigRequest {
    pub token: Option<String>,
    pub device_id: Option<String>,
    pub os: Option<String>,
    pub mode: Option<String>,
    pub protocol: Option<String>,
    pub location_code: Option<String>,
    pub use_warp: Option<bool>,
    pub selected_outbound_id: Option<String>,
    pub personal_uri: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SubQuery {
    pub format: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
pub struct ModesQuery {
    pub token: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
pub struct OvpnQuery {
    pub mode: Option<String>,
    pub protocol: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct RemoveDeviceRequest {
    pub device_id: String,
}

#[derive(Debug, Deserialize)]
pub struct TelemetryReportRequest {
    pub token: String,
    pub bytes_delta: i64,
    pub device_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct OpenVpnAuthRequest {
    pub username: String,
    pub password: Option<String>,
    pub mode: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct OpenVpnAccountingRequest {
    pub token: String,
    #[serde(default)]
    pub bytes_sent: u64,
    #[serde(default)]
    pub bytes_received: u64,
    pub mode: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct DonateOutboundRequest {
    pub uri: String,
    pub name: Option<String>,
    pub note: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SyncClientStateRequest {
    pub personal_configs: Option<serde_json::Value>,
    pub preferences: Option<serde_json::Value>,
}

pub fn create_router(
    pool: DbPool,
    anomaly_detector: crate::anomaly_detector::AnomalyDetector,
    bot: Option<teloxide::Bot>,
    admin_chat_id: i64,
    server_host: String,
    bot_username: String,
) -> Router {
    let state = AppState {
        pool,
        anomaly_detector,
        bot,
        admin_chat_id,
        rate_limiter: LoginRateLimiter::new(),
        server_host,
        bot_username,
    };

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::DELETE,
            Method::PATCH,
            Method::OPTIONS,
        ])
        .allow_headers(Any)
        .expose_headers(Any);

    Router::new()
        // 1. Auth endpoints
        .route("/api/v1/auth/register", post(auth_register))
        .route("/api/v1/auth/login", post(auth_login))
        .route("/api/v1/auth/code-login", post(auth_code_login))
        .route("/api/v1/auth/exchange-code", post(auth_code_login))
        .route("/api/v1/auth/link-token", post(auth_link_token))
        // 2. Client Bootstrap, Connection Modes, Cross-Device Sync State & Live Outbounds catalog
        .route("/api/v1/client/bootstrap", get(get_client_bootstrap))
        .route("/api/v1/client/sync-state", get(get_client_sync_state).put(put_client_sync_state))
        .route("/api/v1/client/modes", get(get_client_modes))
        .route("/api/v1/client/locations", get(get_client_locations))
        // 2b. Community Outbound Donation & Ecosystem Add endpoints
        .route("/api/v1/client/outbounds/donate", post(donate_client_outbound))
        .route("/api/v1/client/outbounds/add", post(add_ecosystem_outbound))
        .route("/api/v1/client/outbounds/my-donations", get(get_my_donated_outbounds))
        // 3. Client Sing-box dynamic config compiler
        .route("/api/v1/client/config", post(client_config))
        .route("/api/v1/client/connect", post(client_config))
        // 4. Device Management (Max 3 Devices)
        .route("/api/v1/client/devices", get(get_client_devices))
        .route("/api/v1/client/devices/remove", post(remove_client_device))
        .route("/api/v1/client/devices/:device_id", delete(delete_client_device_by_path))
        // 5. Periodic Heartbeat & Instant Session Revocation
        .route("/api/v1/client/heartbeat", post(client_heartbeat))
        // 6. Client Version Check & Update Notification
        .route("/api/v1/client/version", get(client_version))
        // 7. Live Telemetry & Traffic Anomaly Detection
        .route("/api/v1/client/telemetry", post(client_telemetry))
        // 8. V2Ray / Sing-box Subscription endpoints
        .route("/api/v1/sub/:token", get(get_subscription))
        .route("/sub/:token", get(get_subscription))
        // 9. OpenVPN, IKEv2 & WireGuard Gaming profile generators & internal daemon hooks
        .route("/api/v1/ovpn/:token", get(get_openvpn_profile))
        .route("/api/v1/mobileconfig/:token", get(get_mobileconfig_profile))
        .route("/api/v1/wireguard/:token", get(get_wireguard_gaming_profile))
        .route("/api/internal/openvpn/auth", post(openvpn_internal_auth))
        .route("/api/internal/openvpn/accounting", post(openvpn_internal_accounting))
        .route("/api/internal/ikev2/auth", post(ikev2_internal_auth))
        .route("/api/internal/ikev2/accounting", post(ikev2_internal_accounting))
        // 10. System Health check
        .route("/health", get(health_check))
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

/// POST /api/v1/auth/register
/// Registers a new account directly with username and password, provisions Lite subscription, and registers device
async fn auth_register(
    State(state): State<AppState>,
    ConnectInfo(peer_addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(payload): Json<RegisterRequest>,
) -> Result<Response, CoreError> {
    let client_ip = extract_client_ip_with_peer(&headers, Some(peer_addr));
    state.rate_limiter.check_ip(&client_ip).await?;

    let username = payload.username.trim().to_lowercase();
    let password = payload.password.as_str();

    if username.len() < 3 || username.len() > 32 || !username.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        state.rate_limiter.record_failure(&client_ip).await;
        return Err(CoreError::BadRequest(
            "نام کاربری باید بین ۳ تا ۳۲ کاراکتر و فقط شامل حروف انگلیسی، اعداد و زیرخط باشد.".to_string(),
        ));
    }

    if Repository::RESERVED_USERNAMES.contains(&username.as_str()) {
        state.rate_limiter.record_failure(&client_ip).await;
        return Err(CoreError::BadRequest(
            "این نام کاربری رزرو شده و قابل انتخاب نیست.".to_string(),
        ));
    }

    if password.len() < 8 {
        state.rate_limiter.record_failure(&client_ip).await;
        return Err(CoreError::BadRequest(
            "رمز عبور باید حداقل ۸ کاراکتر باشد.".to_string(),
        ));
    }

    // Check IP registration limit without consuming a slot until registration succeeds
    Repository::check_ip_registration_limit(&state.pool, &client_ip).await?;

    let (user, sub) = match Repository::register_user_with_credentials(&state.pool, &username, password, None).await {
        Ok(res) => {
            Repository::record_ip_registration(&state.pool, &client_ip).await;
            state.rate_limiter.record_success(&client_ip).await;
            res
        }
        Err(e) => {
            state.rate_limiter.record_failure(&client_ip).await;
            return Err(e);
        }
    };

    let device_id = payload.device_identifier.as_deref().unwrap_or("desktop-client-001");
    let platform = payload.os.as_deref().unwrap_or("windows");
    let device_name = payload.device_name.as_deref().unwrap_or(match platform {
        "android" => "Android Mobile",
        "ios" => "iPhone / iPad",
        "darwin" | "macos" => "Apple Mac",
        "linux" => "Linux PC",
        _ => "Windows PC",
    });

    Repository::register_or_update_device(
        &state.pool,
        user.id,
        sub.id,
        device_id,
        device_name,
        platform,
    )
    .await?;

    let remaining_bytes = (sub.traffic_limit_bytes - (sub.upload_bytes + sub.download_bytes)).max(0);

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "success": true,
            "access_token": format!("jwt_sentra_{}", sub.token),
            "token_type": "Bearer",
            "user": {
                "id": user.id,
                "user_uuid": user.user_uuid,
                "telegram_id": user.telegram_id,
                "username": user.username,
                "first_name": user.first_name,
                "role": user.role
            },
            "subscription": {
                "tier": sub.tier,
                "token": sub.token,
                "status": sub.status,
                "remaining_bytes": remaining_bytes,
                "max_concurrent_devices": sub.max_concurrent_devices,
                "expires_at": sub.expires_at.to_rfc3339()
            }
        })),
    )
        .into_response())
}

/// POST /api/v1/auth/login
/// Validates username & password credentials, verifies device slot (Max 3 Devices), and returns session JWT
async fn auth_login(
    State(state): State<AppState>,
    ConnectInfo(peer_addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(payload): Json<LoginRequest>,
) -> Result<Response, CoreError> {
    let client_ip = extract_client_ip_with_peer(&headers, Some(peer_addr));
    state.rate_limiter.check_ip(&client_ip).await?;

    let username = payload.username.trim().to_lowercase();
    let password = payload.password.as_str();

    let (user, sub) = match Repository::login_user_with_credentials(&state.pool, &username, password).await {
        Ok(res) => {
            state.rate_limiter.record_success(&client_ip).await;
            res
        }
        Err(e) => {
            state.rate_limiter.record_failure(&client_ip).await;
            return Err(e);
        }
    };

    let device_id = payload.device_identifier.as_deref().unwrap_or("desktop-client-001");
    let platform = payload.os.as_deref().unwrap_or("windows");
    let device_name = payload.device_name.as_deref().unwrap_or(match platform {
        "android" => "Android Mobile",
        "ios" => "iPhone / iPad",
        "darwin" | "macos" => "Apple Mac",
        "linux" => "Linux PC",
        _ => "Windows PC",
    });

    Repository::register_or_update_device(
        &state.pool,
        user.id,
        sub.id,
        device_id,
        device_name,
        platform,
    )
    .await?;

    let remaining_bytes = (sub.traffic_limit_bytes - (sub.upload_bytes + sub.download_bytes)).max(0);

    Ok((
        StatusCode::OK,
        Json(json!({
            "success": true,
            "access_token": format!("jwt_sentra_{}", sub.token),
            "token_type": "Bearer",
            "user": {
                "id": user.id,
                "user_uuid": user.user_uuid,
                "telegram_id": user.telegram_id,
                "username": user.username,
                "first_name": user.first_name,
                "role": user.role
            },
            "subscription": {
                "tier": sub.tier,
                "token": sub.token,
                "status": sub.status,
                "remaining_bytes": remaining_bytes,
                "max_concurrent_devices": sub.max_concurrent_devices,
                "expires_at": sub.expires_at.to_rfc3339()
            }
        })),
    )
        .into_response())
}

/// POST /api/v1/auth/link-token
/// Generates temporary 6-digit link code for linking desktop account to Telegram bot
async fn auth_link_token(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, CoreError> {
    let token = headers
        .get("X-Subscription-Token")
        .and_then(|h| h.to_str().ok())
        .map(|s| s.to_string())
        .or_else(|| {
            headers
                .get(header::AUTHORIZATION)
                .and_then(|h| h.to_str().ok())
                .and_then(|s| s.strip_prefix("Bearer "))
                .map(|s| s.strip_prefix("jwt_sentra_").unwrap_or(s).to_string())
        })
        .ok_or(CoreError::AuthFailed("توکن یا شناسه نشست نامعتبر است.".to_string()))?;

    let sub = Repository::get_subscription_by_token(&state.pool, &token).await?;
    let link_code = Repository::generate_link_code(&state.pool, sub.user_id).await?;

    Ok((
        StatusCode::OK,
        Json(json!({
            "success": true,
            "link_code": link_code,
            "expires_in_seconds": 300,
            "instructions": "این کد ۶ رقمی را ظرف ۵ دقیقه در ربات تلگرام با دستور /link وارد فرمایید."
        })),
    )
        .into_response())
}

/// POST /api/v1/auth/code-login
/// Validates 8-digit OTP code, registers user device (Max 3 Devices), and returns session JWT
async fn auth_code_login(
    State(state): State<AppState>,
    ConnectInfo(peer_addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(payload): Json<CodeLoginRequest>,
) -> Result<Response, CoreError> {
    let client_ip = extract_client_ip_with_peer(&headers, Some(peer_addr));
    state.rate_limiter.check_ip(&client_ip).await?;

    let code = payload.code.trim();
    if code.len() != 8 {
        state.rate_limiter.record_failure(&client_ip).await;
        return Err(CoreError::BadRequest("کد ورود باید دقیقاً ۸ رقم باشد.".to_string()));
    }

    let device_id = payload.device_identifier.as_deref().unwrap_or("desktop-client-001");
    let device_name = payload.device_name.as_deref().unwrap_or("Sentra Connect Device");
    let os = payload.os.as_deref().unwrap_or("windows");
    let version = payload.client_version.as_deref().unwrap_or("1.0.0");

    let (user, sub) = match Repository::validate_and_exchange_code(
        &state.pool,
        code,
        device_id,
        device_name,
        os,
        version,
        &client_ip,
    )
    .await
    {
        Ok(res) => {
            state.rate_limiter.record_success(&client_ip).await;
            res
        }
        Err(e) => {
            state.rate_limiter.record_failure(&client_ip).await;
            return Err(e);
        }
    };

    let remaining_bytes = (sub.traffic_limit_bytes - (sub.upload_bytes + sub.download_bytes)).max(0);

    Ok((
        StatusCode::OK,
        Json(json!({
            "success": true,
            "access_token": format!("jwt_sentra_{}", sub.token),
            "token_type": "Bearer",
            "user": {
                "id": user.id,
                "telegram_id": user.telegram_id,
                "username": user.username,
                "first_name": user.first_name,
                "role": user.role
            },
            "subscription": {
                "tier": sub.tier,
                "token": sub.token,
                "status": sub.status,
                "remaining_bytes": remaining_bytes,
                "max_concurrent_devices": sub.max_concurrent_devices,
                "expires_at": sub.expires_at.to_rfc3339()
            }
        })),
    )
        .into_response())
}

/// GET /api/v1/client/modes
/// Returns the 4 connection modes with user tier lock state, quota and descriptions
async fn get_client_modes(
    State(state): State<AppState>,
    Query(query): Query<ModesQuery>,
    headers: HeaderMap,
) -> Result<Response, CoreError> {
    let token = query.token
        .or_else(|| {
            headers.get("X-Subscription-Token")
                .and_then(|h| h.to_str().ok())
                .map(|s| s.to_string())
        })
        .or_else(|| {
            headers.get(header::AUTHORIZATION)
                .and_then(|h| h.to_str().ok())
                .and_then(|s| s.strip_prefix("Bearer "))
                .map(|s| s.replace("jwt_sentra_", ""))
        });

    let gaming_enabled = Repository::has_active_gaming_outbounds(&state.pool).await;
    let modes = if let Some(t) = token {
        match Repository::get_subscription_by_token(&state.pool, &t).await {
            Ok(mut sub) => {
                let _ = Repository::check_and_reset_daily_quota(&state.pool, &mut sub).await;
                Repository::build_modes_info(&sub, gaming_enabled)
            }
            Err(_) => Repository::build_default_modes_info(gaming_enabled),
        }
    } else {
        Repository::build_default_modes_info(gaming_enabled)
    };

    Ok((
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        Json(json!({
            "success": true,
            "modes": modes
        })),
    )
        .into_response())
}

/// GET /api/v1/client/locations
/// Returns active online locations with ping and node count for client Location Switcher
async fn get_client_locations(
    State(state): State<AppState>,
) -> Result<Response, CoreError> {
    let locations = Repository::get_active_locations_for_free_modes(&state.pool).await?;
    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/json; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store, no-cache, must-revalidate"),
        ],
        Json(json!({
            "success": true,
            "default": "auto",
            "locations": locations
        })),
    )
        .into_response())
}

/// POST /api/v1/client/config
/// Generates valid Sing-box v1.10+ JSON according to PROTOCOL_SPEC.md tailored to user's tier & mode
async fn client_config(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<ConfigRequest>,
) -> Result<Response, CoreError> {
    // Extract token from request JSON body or HTTP headers
    let token = if let Some(ref t) = payload.token {
        t.clone()
    } else if let Some(h) = headers.get("X-Subscription-Token") {
        h.to_str().map_err(|_| CoreError::AuthFailed("Invalid header value".to_string()))?.to_string()
    } else if let Some(auth_h) = headers.get(header::AUTHORIZATION) {
        let auth_str = auth_h.to_str().unwrap_or("");
        if let Some(token_str) = auth_str.strip_prefix("Bearer ") {
            token_str.replace("jwt_sentra_", "")
        } else {
            return Err(CoreError::SubscriptionNotFound);
        }
    } else {
        return Err(CoreError::BadRequest("Subscription token must be provided in request body or headers.".to_string()));
    };

    let mut sub = Repository::get_subscription_by_token(&state.pool, &token).await?;

    // 1. Check if user account is suspended or banned (Anomaly Protection)
    let user_opt = Repository::get_user_by_id(&state.pool, sub.user_id).await?;
    if let Some(user) = user_opt {
        if user.status == "suspended" || sub.status == "suspended" {
            return Err(CoreError::AccountSuspended(
                "حساب شما به دلیل الگوی مصرف ترافیک غیرعادی موقتاً متوقف شده است. لطفاً با پشتیبانی در ارتباط باشید.".to_string(),
            ));
        }
        if user.status == "banned" || sub.status == "disabled" {
            return Err(CoreError::UserBanned("حساب کاربری شما مسدود شده است.".to_string()));
        }
    }

    // 2. Check expiration
    if sub.expires_at < Utc::now() {
        return Err(CoreError::SubscriptionExpired(sub.expires_at.to_rfc3339()));
    }

    // 3. Check overall traffic quota (only for Lite tier)
    let used_bytes = sub.upload_bytes + sub.download_bytes;
    if sub.tier == "Sentra Lite" && sub.traffic_limit_bytes > 0 && used_bytes >= sub.traffic_limit_bytes {
        return Err(CoreError::QuotaExceeded {
            used: used_bytes,
            limit: sub.traffic_limit_bytes,
        });
    }

    // 4. Register or update device (Enforce Max 3 Devices)
    let device_id = payload.device_id.as_deref().unwrap_or("desktop-client-001");
    let platform = payload.os.as_deref().unwrap_or("windows");
    let device_name = match platform {
        "android" => "Android Mobile",
        "ios" => "iPhone / iPad",
        "darwin" | "macos" => "Apple Mac",
        "linux" => "Linux PC",
        _ => "Windows PC",
    };
    Repository::register_or_update_device(&state.pool, sub.user_id, sub.id, device_id, device_name, platform).await?;

    let requested_mode = payload.mode.as_deref().unwrap_or("web_browsing");

    // Enforce mode rules (strict server-side entitlement checks):
    // A. Gaming mode: Coming Soon until at least one active Gaming outbound exists in DB,
    //    then strictly requires Gaming / Pro / Flow+ tier.
    if requested_mode == "gaming" {
        if !Repository::has_active_gaming_outbounds(&state.pool).await {
            return Err(CoreError::ModeComingSoon {
                mode: "گیمینگ (Gaming)".to_string(),
            });
        }
        if !compiler::tier_has_gaming(&sub.tier) {
            return Err(CoreError::ModeLocked {
                mode: "گیمینگ (Gaming)".to_string(),
            });
        }
    }

    // B. Static IP quota & tier check (30 GB limit for Static IP / Pro / Flow+)
    if requested_mode == "static_ip" {
        if !compiler::tier_has_static_ip(&sub.tier) {
            return Err(CoreError::ModeLocked {
                mode: "آی‌پی ثابت (Static IP)".to_string(),
            });
        }
        if sub.static_ip_used_mb >= 30_720 {
            return Err(CoreError::StaticIpQuotaExceeded {
                used_mb: sub.static_ip_used_mb,
                limit_mb: 30_720,
            });
        }
    }

    // C. Reset daily quota if 24h passed
    Repository::check_and_reset_daily_quota(&state.pool, &mut sub).await?;

    // D. Enforce daily quotas for Free/Lite tier
    if sub.tier == "Sentra Lite" {
        if requested_mode == "web_browsing" && sub.web_browsing_used_mb >= 2048 {
            return Err(CoreError::DailyQuotaExceeded {
                mode: "وب‌گردی".to_string(),
                used_mb: sub.web_browsing_used_mb,
                limit_mb: 2048,
            });
        } else if requested_mode == "download" && sub.download_used_mb >= 3072 {
            return Err(CoreError::DailyQuotaExceeded {
                mode: "دانلود".to_string(),
                used_mb: sub.download_used_mb,
                limit_mb: 3072,
            });
        }
    }

    // 1. Static IP mode: Exclusively verify active official outbounds with is_official = 1 exist
    if requested_mode == "static_ip" {
        let official_static_nodes = Repository::get_active_official_outbounds_for_mode(&state.pool, "static_ip").await?;
        if official_static_nodes.is_empty() {
            return Err(CoreError::StaticIpPreparing(
                "سرورهای اختصاصی آی‌پی ثابت در حال حاضر در حال آماده‌سازی نهایی هستند. لطفاً پس از ثبت نود رسمی توسط مدیر، مجدداً تلاش فرمایید.".to_string(),
            ));
        }
    }

    // Multi-protocol dispatch: openvpn_udp, openvpn_tcp, stealth, ikev2
    let raw_protocol = payload.protocol.as_deref().unwrap_or("openvpn_udp");
    let requested_protocol = match raw_protocol.to_lowercase().as_str() {
        "openvpn_tcp" | "tcp" => "openvpn_tcp",
        "stealth" => "stealth",
        "ikev2" => "ikev2",
        _ => "openvpn_udp",
    };

    let server_host = if state.server_host == "0.0.0.0" || state.server_host.is_empty() {
        "127.0.0.1".to_string()
    } else {
        state.server_host.clone()
    };

    let remote_port = match requested_protocol {
        "stealth" => 11940,
        "openvpn_tcp" => match requested_mode {
            "download" => 2053,
            "static_ip" => 2083,
            _ => 443,
        },
        _ => match requested_mode {
            "download" => 1195,
            "static_ip" => 1196,
            _ => 1194,
        },
    };

    let ovpn_config = compiler::generate_ovpn_profile_ext(&sub, Some(requested_mode), requested_protocol, &server_host);

    let stunnel_data = if requested_protocol == "stealth" {
        Some(json!({
            "host": server_host,
            "port": 443,
            "sni": format!("{}.sentravpn.com", requested_mode)
        }))
    } else {
        None
    };

    let ikev2_data = if requested_protocol == "ikev2" {
        Some(json!({
            "server_host": server_host,
            "remote_id": server_host,
            "eap_username": sub.token,
            "eap_password": sub.token,
            "ca_cert": "-----BEGIN CERTIFICATE-----\nMIIDSzCCAjOgAwIBAgIUW8d0Q3k9M1A2B3C4D5E6F7A8B9C0...[SENTRA-ROOT-CA]...\n-----END CERTIFICATE-----",
            "mobileconfig": compiler::generate_mobileconfig_profile(&sub, requested_mode, &server_host)
        }))
    } else {
        None
    };

    let requested_location = payload.location_code.as_deref().unwrap_or("auto");
    let chosen_location_code = if requested_mode == "static_ip" {
        "US"
    } else {
        requested_location
    };
    let mut active_donated_outbounds = Repository::get_active_outbounds_for_mode_and_location(
        &state.pool,
        requested_mode,
        Some(chosen_location_code),
    )
    .await?;

    if active_donated_outbounds.is_empty() {
        active_donated_outbounds =
            Repository::get_all_active_ecosystem_outbounds_for_tier(&state.pool, &sub.tier)
                .await
                .unwrap_or_default();
    }

    let mut base_outbounds = Repository::get_allowed_outbounds(&state.pool, &sub.tier)
        .await
        .unwrap_or_default();

    let mut has_explicit_selection = false;

    // If user selected a specific outbound from the live catalog (node-* or core-*), place it first
    if let Some(ref sel_id) = payload.selected_outbound_id {
        if let Some(raw_num) = sel_id.strip_prefix("node-") {
            if let Ok(db_id) = raw_num.parse::<i64>() {
                if let Some(specific) = Repository::get_donated_outbound_by_id(&state.pool, db_id).await? {
                    if specific.status == "active" || specific.status == "approved" {
                        active_donated_outbounds.retain(|o| o.id != specific.id);
                        active_donated_outbounds.insert(0, specific);
                        has_explicit_selection = true;
                    }
                }
            }
        } else if let Some(raw_num) = sel_id.strip_prefix("core-") {
            if let Ok(db_id) = raw_num.parse::<i64>() {
                if let Some(specific) = Repository::get_outbound_by_id(&state.pool, db_id).await? {
                    if specific.is_active {
                        base_outbounds.retain(|o| o.id != specific.id);
                        base_outbounds.insert(0, specific);
                        has_explicit_selection = true;
                    }
                }
            }
        }
    }

    // If user requested a personal URI, validate against Anti-SSRF and compile it directly into Sing-box
    if let Some(ref personal_uri) = payload.personal_uri {
        let trimmed = personal_uri.trim();
        if !trimmed.is_empty() && trimmed.len() <= 8192 {
            if let Ok(parsed) = crate::outbound_analyzer::OutboundAnalyzer::parse_input(trimmed) {
                if crate::outbound_analyzer::OutboundAnalyzer::check_anti_ssrf(&parsed.server_address)
                    .await
                    .is_ok()
                {
                    let personal_row = crate::models::DonatedOutbound {
                        id: 0,
                        donor_user_id: Some(sub.user_id),
                        tag: if parsed.tag.is_empty() { "Personal-Node".to_string() } else { parsed.tag.clone() },
                        protocol: parsed.protocol.clone(),
                        server_address: parsed.server_address.clone(),
                        server_port: parsed.server_port as i64,
                        config_json: parsed.config_json.to_string(),
                        latency_ms: 0,
                        speed_mbps: 0.0,
                        assigned_tier: "web_browsing".to_string(),
                        health_score: 100,
                        status: "active".to_string(),
                        fail_count: 0,
                        reward_granted: 0,
                        raw_link: Some(trimmed.to_string()),
                        rejection_reason: None,
                        declared_or_detected_gb: 0,
                        bytes_served: 0,
                        first_used_at: None,
                        monthly_reward_granted: 0,
                        fingerprint_sha256: None,
                        offline_since: None,
                        clawback_executed: 0,
                        is_official: 0,
                        label: Some(parsed.tag),
                        country_code: "XX".to_string(),
                        country_name: "Personal".to_string(),
                        last_checked_at: Utc::now(),
                        created_at: Utc::now(),
                        updated_at: Utc::now(),
                        allow_web: 1,
                        allow_download: 1,
                        allow_static_ip: 0,
                        allow_gaming: 0,
                        gemini_ok: 0,
                        trading_safe: 0,
                        speed_score: 100,
                        jitter_ms: 0,
                        last_online_at: Some(Utc::now()),
                        allocation_mode: "manual".to_string(),
                        reward_days: 0,
                        user_note: None,
                        approved_at: None,
                    };
                    active_donated_outbounds.insert(0, personal_row);
                    has_explicit_selection = true;
                }
            }
        }
    }

    let live_outbounds = Repository::get_all_live_client_outbounds(&state.pool).await?;
    let singbox_config = compiler::compile_singbox_config_with_donated_and_selection(
        &sub,
        &base_outbounds,
        &active_donated_outbounds,
        Some(requested_mode),
        has_explicit_selection,
    );

    let chosen_location_name = match chosen_location_code.to_uppercase().as_str() {
        "US" => "آمریکا 🇺🇸",
        "DE" => "آلمان 🇩🇪",
        "NL" => "هلند 🇳🇱",
        "FI" => "فنلاند 🇫🇮",
        "FR" => "فرانسه 🇫🇷",
        "GB" | "UK" => "انگلستان 🇬🇧",
        "TR" => "ترکیه 🇹🇷",
        _ => "⚡️ انتخاب خودکار سریع‌ترین لوکیشن (Auto)",
    };

    // Cloudflare WARP opt-in: Strictly disabled in static_ip and gaming modes (avoids extra hop latency/jitter)
    let use_warp = if requested_mode == "static_ip" || requested_mode == "gaming" {
        false
    } else {
        payload.use_warp.unwrap_or(false)
    };
    let _ = Repository::update_device_use_warp(&state.pool, sub.id, device_id, use_warp).await;

    let warp_subnet = if use_warp {
        if requested_mode == "download" { "10.8.11.0/24" } else { "10.8.10.0/24" }
    } else {
        "10.8.0.0/24"
    };

    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/json; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store, no-cache, must-revalidate"),
        ],
        Json(json!({
            "success": true,
            "protocol": requested_protocol,
            "mode": requested_mode,
            "location_code": chosen_location_code,
            "location_name": chosen_location_name,
            "use_warp": use_warp,
            "warp_subnet": warp_subnet,
            "remote_host": server_host,
            "remote_port": remote_port,
            "auth_username": sub.token,
            "auth_password": sub.token,
            "ovpn_config": ovpn_config,
            "singbox_config": singbox_config,
            "outbounds": live_outbounds,
            "stunnel": stunnel_data,
            "ikev2": ikev2_data
        })),
    )
        .into_response())
}

/// GET /api/v1/client/devices
/// Returns list of registered devices for the authenticated user (Max 3 Devices)
async fn get_client_devices(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ModesQuery>,
) -> Result<Response, CoreError> {
    let token = query.token
        .or_else(|| {
            headers.get("X-Subscription-Token")
                .and_then(|h| h.to_str().ok())
                .map(|s| s.to_string())
        })
        .or_else(|| {
            headers.get(header::AUTHORIZATION)
                .and_then(|h| h.to_str().ok())
                .and_then(|s| s.strip_prefix("Bearer "))
                .map(|s| s.replace("jwt_sentra_", ""))
        })
        .ok_or(CoreError::SubscriptionNotFound)?;

    let sub = Repository::get_subscription_by_token(&state.pool, &token).await?;
    let devices = Repository::get_user_devices(&state.pool, sub.user_id).await?;

    Ok((
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        Json(json!({
            "success": true,
            "devices": devices,
            "count": devices.len(),
            "max_allowed": 3
        })),
    )
        .into_response())
}

/// POST /api/v1/client/devices/remove
/// Removes a registered device to free up slot for a new device
async fn remove_client_device(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ModesQuery>,
    Json(payload): Json<RemoveDeviceRequest>,
) -> Result<Response, CoreError> {
    let token = query
        .token
        .or_else(|| {
            headers
                .get("X-Subscription-Token")
                .and_then(|h| h.to_str().ok())
                .map(|s| s.to_string())
        })
        .or_else(|| {
            headers
                .get(header::AUTHORIZATION)
                .and_then(|h| h.to_str().ok())
                .and_then(|s| s.strip_prefix("Bearer "))
                .map(|s| s.replace("jwt_sentra_", ""))
        })
        .ok_or(CoreError::SubscriptionNotFound)?;

    let sub = Repository::get_subscription_by_token(&state.pool, &token).await?;
    let removed = Repository::delete_user_device(&state.pool, sub.user_id, &payload.device_id).await?;

    Ok((
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        Json(json!({
            "success": removed,
            "message": if removed { "دستگاه با موفقیت حذف گردید." } else { "دستگاه مورد نظر یافت نشد." }
        })),
    )
        .into_response())
}

/// DELETE /api/v1/client/devices/:device_id
async fn delete_client_device_by_path(
    State(state): State<AppState>,
    Path(device_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<ModesQuery>,
) -> Result<Response, CoreError> {
    let token = query
        .token
        .or_else(|| {
            headers
                .get("X-Subscription-Token")
                .and_then(|h| h.to_str().ok())
                .map(|s| s.to_string())
        })
        .or_else(|| {
            headers
                .get(header::AUTHORIZATION)
                .and_then(|h| h.to_str().ok())
                .and_then(|s| s.strip_prefix("Bearer "))
                .map(|s| s.replace("jwt_sentra_", ""))
        })
        .ok_or(CoreError::SubscriptionNotFound)?;

    let sub = Repository::get_subscription_by_token(&state.pool, &token).await?;
    let removed = Repository::delete_user_device(&state.pool, sub.user_id, &device_id).await?;

    Ok((
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        Json(json!({
            "success": removed,
            "message": if removed { "دستگاه با موفقیت حذف گردید." } else { "دستگاه مورد نظر یافت نشد." }
        })),
    )
        .into_response())
}

/// POST /api/v1/client/heartbeat
/// Handles periodic client heartbeats, enforces quotas/device validity, and checks anomalies
async fn client_heartbeat(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<HeartbeatRequest>,
) -> Result<Response, CoreError> {
    let token = payload
        .token
        .or_else(|| {
            headers
                .get("X-Subscription-Token")
                .and_then(|h| h.to_str().ok())
                .map(|s| s.to_string())
        })
        .or_else(|| {
            headers
                .get(header::AUTHORIZATION)
                .and_then(|h| h.to_str().ok())
                .and_then(|s| s.strip_prefix("Bearer "))
                .map(|s| s.replace("jwt_sentra_", ""))
        })
        .ok_or(CoreError::SubscriptionNotFound)?;

    let mode = payload.mode.as_deref().unwrap_or("web_browsing");

    let verdict = Repository::process_heartbeat(
        &state.pool,
        &token,
        &payload.device_id,
        mode,
        payload.delta_upload_bytes,
        payload.delta_download_bytes,
    )
    .await?;

    let delta_total = (payload.delta_upload_bytes + payload.delta_download_bytes) as i64;
    if delta_total > 0 {
        if let Ok(sub) = Repository::get_subscription_by_token(&state.pool, &token).await {
            // If free tier user, record traffic usage on active donated outbounds and trigger reward if capacity > 200 GB
            if sub.tier == "Sentra Lite" {
                let _ = Repository::record_donated_outbound_usage(&state.pool, mode, delta_total, state.bot.as_ref()).await;
            }

            let is_anomaly = state
                .anomaly_detector
                .record_and_check(
                    &state.pool,
                    sub.user_id,
                    delta_total,
                    state.bot.as_ref(),
                    state.admin_chat_id,
                )
                .await
                .unwrap_or(false);

            if is_anomaly {
                return Ok((
                    StatusCode::OK,
                    [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
                    Json(json!({
                        "action": "disconnect",
                        "code": "ACCOUNT_SUSPENDED",
                        "message": "حساب کاربری شما به دلیل الگوی مصرف مشکوک و غیرعادی موقتاً مسدود گردید."
                    })),
                )
                    .into_response());
            }
        }
    }

    Ok((
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        Json(json!(verdict)),
    )
        .into_response())
}

#[derive(Debug, Deserialize)]
pub struct ClientVersionQuery {
    pub platform: Option<String>,
}

/// GET /api/v1/client/version
/// Returns latest client application version, minimum supported version, and release notes from app_releases
async fn client_version(
    State(state): State<AppState>,
    Query(query): Query<ClientVersionQuery>,
) -> Result<Response, CoreError> {
    let target_platform = query.platform.as_deref().unwrap_or("windows");
    let release_opt = Repository::get_app_release_by_platform(&state.pool, target_platform).await?;

    let (latest_version, release_notes, release_date, file_name, file_size_mb) = match release_opt {
        Some(rel) => (
            rel.version,
            if rel.changelog.is_empty() {
                format!("بروزرسانی نسخه {} کلاینت هوشمند Sentra Connect", rel.platform)
            } else {
                rel.changelog
            },
            rel.updated_at.format("%Y-%m-%d").to_string(),
            rel.file_name,
            rel.file_size_mb,
        ),
        None => (
            "1.1.0".to_string(),
            "نسخه ۱.۱.۰: ضربان قلب و همگام‌سازی لحظه‌ای حجم، ایزولاسیون کامل آی‌پی در حالت آی‌پی ثابت، محافظت نشت DNS، بازیابی خودکار اتصال شبکه در اندروید.".to_string(),
            "2026-11-20".to_string(),
            if target_platform == "windows" {
                "SentraConnect-Setup.exe".to_string()
            } else {
                "SentraConnect.apk".to_string()
            },
            25.0,
        ),
    };

    let download_url = if state.bot_username.is_empty() {
        String::new()
    } else {
        format!("https://t.me/{}", state.bot_username)
    };

    Ok((
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        Json(json!({
            "latest_version": latest_version,
            "min_supported_version": "1.0.0",
            "platform": target_platform,
            "file_name": file_name,
            "file_size_mb": file_size_mb,
            "bot_username": state.bot_username,
            "download_url": download_url,
            "release_notes": release_notes,
            "release_date": release_date,
            "mandatory": false
        })),
    )
        .into_response())
}

/// POST /api/v1/client/telemetry
/// Reports traffic usage deltas and evaluates Sliding Window Rate limits (Anomaly Protection)
async fn client_telemetry(
    State(state): State<AppState>,
    Json(payload): Json<TelemetryReportRequest>,
) -> Result<Response, CoreError> {
    let sub = Repository::get_subscription_by_token(&state.pool, &payload.token).await?;

    // Check if account is suspended
    let user_opt = Repository::get_user_by_id(&state.pool, sub.user_id).await?;
    if let Some(user) = user_opt {
        if user.status == "suspended" || sub.status == "suspended" {
            return Err(CoreError::AccountSuspended(
                "حساب شما به دلیل الگوی مصرف ترافیک غیرعادی موقتاً متوقف شده است. لطفاً با پشتیبانی در ارتباط باشید.".to_string(),
            ));
        }
    }

    // Update device active timestamp if device_id provided
    if let Some(ref dev_id) = payload.device_id {
        let _ = Repository::register_or_update_device(
            &state.pool,
            sub.user_id,
            sub.id,
            dev_id,
            "Sentra Connected Device",
            "desktop",
        )
        .await;
    }

    // Persist reported traffic usage delta into subscriptions & traffic_logs so all devices + Telegram bot see live consumption
    if payload.bytes_delta > 0 {
        let _ = sqlx::query(
            "UPDATE subscriptions SET download_bytes = download_bytes + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        )
        .bind(payload.bytes_delta)
        .bind(sub.id)
        .execute(&state.pool)
        .await;

        let _ = sqlx::query(
            "INSERT INTO traffic_logs (subscription_id, bytes_sent, bytes_received) VALUES (?, 0, ?)"
        )
        .bind(sub.id)
        .bind(payload.bytes_delta)
        .execute(&state.pool)
        .await;
    }

    // Check sliding window anomaly: >5GB in 15m or >20GB in 1h
    let is_anomaly = state
        .anomaly_detector
        .record_and_check(
            &state.pool,
            sub.user_id,
            payload.bytes_delta,
            state.bot.as_ref(),
            state.admin_chat_id,
        )
        .await?;

    if is_anomaly {
        return Err(CoreError::AccountSuspended(
            "حساب شما به دلیل الگوی مصرف ترافیک غیرعادی موقتاً متوقف شده است. لطفاً با پشتیبانی در ارتباط باشید.".to_string(),
        ));
    }

    Ok((
        StatusCode::OK,
        Json(json!({
            "success": true,
            "status": "normal"
        })),
    )
        .into_response())
}

/// GET /api/v1/sub/:token and GET /sub/:token
/// Returns Base64 V2Ray URI list or Sing-box JSON depending on User-Agent
async fn get_subscription(
    State(state): State<AppState>,
    Path(token): Path<String>,
    Query(query): Query<SubQuery>,
    headers: HeaderMap,
) -> Result<Response, CoreError> {
    let sub = Repository::get_subscription_by_token(&state.pool, &token).await?;

    // Check suspension
    let user_opt = Repository::get_user_by_id(&state.pool, sub.user_id).await?;
    if let Some(user) = user_opt {
        if user.status == "suspended" || sub.status == "suspended" {
            return Err(CoreError::AccountSuspended(
                "حساب شما به دلیل الگوی مصرف ترافیک غیرعادی موقتاً متوقف شده است. لطفاً با پشتیبانی در ارتباط باشید.".to_string(),
            ));
        }
    }

    if sub.expires_at < Utc::now() {
        return Err(CoreError::SubscriptionExpired(sub.expires_at.to_rfc3339()));
    }

    let user_agent = headers
        .get(header::USER_AGENT)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("")
        .to_lowercase();

    let wants_singbox = query
        .format
        .as_deref()
        .map(|f| f.eq_ignore_ascii_case("singbox") || f.eq_ignore_ascii_case("sing-box"))
        .unwrap_or(false)
        || user_agent.contains("sing-box")
        || user_agent.contains("singbox");

    let outbounds = Repository::get_allowed_outbounds(&state.pool, &sub.tier).await?;
    let ecosystem_outbounds =
        Repository::get_all_active_ecosystem_outbounds_for_tier(&state.pool, &sub.tier)
            .await
            .unwrap_or_default();

    let sub_userinfo = format!(
        "upload={}; download={}; total={}; expire={}",
        sub.upload_bytes,
        sub.download_bytes,
        sub.traffic_limit_bytes,
        sub.expires_at.timestamp()
    );

    if wants_singbox {
        let singbox_json = compiler::compile_singbox_config_with_donated(
            &sub,
            &outbounds,
            &ecosystem_outbounds,
            None,
        );
        Ok((
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, "application/json; charset=utf-8"),
                (
                    header::HeaderName::from_static("subscription-userinfo"),
                    sub_userinfo.as_str(),
                ),
            ],
            Json(singbox_json),
        )
            .into_response())
    } else {
        // Base64 V2Ray / Clash / Sing-box URI list containing all active official + donated outbounds
        let mut lines = Vec::new();
        let mut seen_uris: std::collections::HashSet<String> = std::collections::HashSet::new();

        for dob in &ecosystem_outbounds {
            if let Some(uri) = build_share_uri_from_donated(dob) {
                if seen_uris.insert(uri.clone()) {
                    lines.push(uri);
                }
            }
        }

        let has_real_nodes = !lines.is_empty()
            || outbounds.iter().any(|ob| ob.server_address != "127.0.0.1");

        for ob in outbounds {
            if has_real_nodes && ob.server_address == "127.0.0.1" {
                continue;
            }
            let uri = match ob.protocol.as_str() {
                "socks" => format!("socks://{}:{}#{}", ob.server_address, ob.server_port, urlencoding_simple(&ob.tag)),
                "http" => format!("http://{}:{}#{}", ob.server_address, ob.server_port, urlencoding_simple(&ob.tag)),
                "vless" => format!(
                    "vless://{}@{}:{}?security=reality&type=tcp#{}",
                    ob.uuid.as_deref().unwrap_or("00000000-0000-0000-0000-000000000000"),
                    ob.server_address,
                    ob.server_port,
                    urlencoding_simple(&ob.tag)
                ),
                _ => format!("socks://{}:{}#{}", ob.server_address, ob.server_port, urlencoding_simple(&ob.tag)),
            };
            if seen_uris.insert(uri.clone()) {
                lines.push(uri);
            }
        }

        let raw_payload = lines.join("\n");
        let encoded_payload = BASE64.encode(raw_payload.as_bytes());

        Ok((
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, "text/plain; charset=utf-8"),
                (header::CONTENT_DISPOSITION, "attachment; filename=\"sentra-sub.txt\""),
                (
                    header::HeaderName::from_static("subscription-userinfo"),
                    sub_userinfo.as_str(),
                ),
            ],
            encoded_payload,
        )
            .into_response())
    }
}

fn build_share_uri_from_donated(dob: &crate::models::DonatedOutbound) -> Option<String> {
    let display_name = dob
        .label
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&dob.tag);
    let prefix = if dob.is_official == 1 { "👑 " } else { "🤝 " };
    let tagged_name = format!("{}{}", prefix, display_name);

    if let Some(ref raw) = dob.raw_link {
        let trimmed = raw.trim();
        let lower = trimmed.to_lowercase();
        let supported = [
            "vless://",
            "vmess://",
            "trojan://",
            "ss://",
            "hy2://",
            "hysteria2://",
            "tuic://",
            "wireguard://",
            "wg://",
            "socks://",
            "socks5://",
            "http://",
        ];
        if supported.iter().any(|s| lower.starts_with(s)) {
            if lower.starts_with("vmess://") {
                return Some(trimmed.to_string());
            }
            let base = trimmed.split('#').next().unwrap_or(trimmed);
            return Some(format!("{}#{}", base, urlencoding_simple(&tagged_name)));
        }
    }

    let cfg: serde_json::Value = serde_json::from_str(&dob.config_json).unwrap_or_default();
    match dob.protocol.to_lowercase().as_str() {
        "vless" => {
            let uuid = cfg.get("uuid").and_then(|v| v.as_str())?;
            Some(format!(
                "vless://{}@{}:{}?encryption=none#{}",
                uuid,
                dob.server_address,
                dob.server_port,
                urlencoding_simple(&tagged_name)
            ))
        }
        "trojan" => {
            let password = cfg.get("password").and_then(|v| v.as_str())?;
            Some(format!(
                "trojan://{}@{}:{}#{}",
                password,
                dob.server_address,
                dob.server_port,
                urlencoding_simple(&tagged_name)
            ))
        }
        "hysteria2" | "hy2" => {
            let password = cfg.get("password").and_then(|v| v.as_str())?;
            Some(format!(
                "hysteria2://{}@{}:{}#{}",
                password,
                dob.server_address,
                dob.server_port,
                urlencoding_simple(&tagged_name)
            ))
        }
        "socks" | "socks5" => Some(format!(
            "socks://{}:{}#{}",
            dob.server_address,
            dob.server_port,
            urlencoding_simple(&tagged_name)
        )),
        "http" => Some(format!(
            "http://{}:{}#{}",
            dob.server_address,
            dob.server_port,
            urlencoding_simple(&tagged_name)
        )),
        _ => None,
    }
}

/// GET /api/v1/ovpn/:token
async fn get_openvpn_profile(
    State(state): State<AppState>,
    Path(token): Path<String>,
    Query(query): Query<OvpnQuery>,
) -> Result<Response, CoreError> {
    let mut sub = Repository::get_subscription_by_token(&state.pool, &token).await?;

    // Check suspension
    let user_opt = Repository::get_user_by_id(&state.pool, sub.user_id).await?;
    if let Some(user) = user_opt {
        if user.status == "suspended" || sub.status == "suspended" {
            return Err(CoreError::AccountSuspended(
                "حساب شما به دلیل الگوی مصرف ترافیک غیرعادی موقتاً متوقف شده است. لطفاً با پشتیبانی در ارتباط باشید.".to_string(),
            ));
        }
    }

    // Check expiration
    if sub.expires_at < Utc::now() {
        return Err(CoreError::SubscriptionExpired(sub.expires_at.to_rfc3339()));
    }

    // Register/update device session for iOS OpenVPN (Max 3 Devices)
    let dev_id = format!("ios-ovpn-{}", &sub.token[..8]);
    let _ = Repository::register_or_update_device(
        &state.pool,
        sub.user_id,
        sub.id,
        &dev_id,
        "iPhone OpenVPN",
        "ios",
    )
    .await;

    let mode = query.mode.as_deref().unwrap_or("web_browsing");

    // Validate mode availability & entitlement server-side
    if mode == "gaming" {
        if !Repository::has_active_gaming_outbounds(&state.pool).await {
            return Err(CoreError::ModeComingSoon {
                mode: "گیمینگ (Gaming)".to_string(),
            });
        }
        if !compiler::tier_has_gaming(&sub.tier) {
            return Err(CoreError::ModeLocked {
                mode: "گیمینگ (Gaming)".to_string(),
            });
        }
    }
    if mode == "static_ip" {
        if !compiler::tier_has_static_ip(&sub.tier) {
            return Err(CoreError::ModeLocked {
                mode: "آی‌پی ثابت (Static IP)".to_string(),
            });
        }
        if sub.static_ip_used_mb >= 30_720 {
            return Err(CoreError::StaticIpQuotaExceeded {
                used_mb: sub.static_ip_used_mb,
                limit_mb: 30_720,
            });
        }
    }

    // Daily quota check
    Repository::check_and_reset_daily_quota(&state.pool, &mut sub).await?;
    if sub.tier == "Sentra Lite" {
        if mode == "web_browsing" && sub.web_browsing_used_mb >= 2048 {
            return Err(CoreError::DailyQuotaExceeded {
                mode: "وب‌گردی".to_string(),
                used_mb: sub.web_browsing_used_mb,
                limit_mb: 2048,
            });
        } else if mode == "download" && sub.download_used_mb >= 3072 {
            return Err(CoreError::DailyQuotaExceeded {
                mode: "دانلود".to_string(),
                used_mb: sub.download_used_mb,
                limit_mb: 3072,
            });
        }
    }

    let raw_protocol = query.protocol.as_deref().unwrap_or("openvpn_udp");
    let proto = match raw_protocol.to_lowercase().as_str() {
        "openvpn_tcp" | "tcp" => "openvpn_tcp",
        "stealth" => "stealth",
        _ => "openvpn_udp",
    };

    let server_host = if state.server_host == "0.0.0.0" || state.server_host.is_empty() {
        "127.0.0.1".to_string()
    } else {
        state.server_host.clone()
    };

    let ovpn_text = compiler::generate_ovpn_profile_ext(&sub, Some(mode), proto, &server_host);

    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/x-openvpn-profile"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=\"sentra-client.ovpn\"",
            ),
        ],
        ovpn_text,
    )
        .into_response())
}

/// GET /api/v1/mobileconfig/:token
async fn get_mobileconfig_profile(
    State(state): State<AppState>,
    Path(token): Path<String>,
    Query(query): Query<OvpnQuery>,
) -> Result<Response, CoreError> {
    let mut sub = Repository::get_subscription_by_token(&state.pool, &token).await?;

    let user_opt = Repository::get_user_by_id(&state.pool, sub.user_id).await?;
    if let Some(user) = user_opt {
        if user.status == "suspended" || sub.status == "suspended" {
            return Err(CoreError::AccountSuspended(
                "حساب شما به دلیل الگوی مصرف ترافیک غیرعادی موقتاً متوقف شده است. لطفاً با پشتیبانی در ارتباط باشید.".to_string(),
            ));
        }
    }

    if sub.expires_at < Utc::now() {
        return Err(CoreError::SubscriptionExpired(sub.expires_at.to_rfc3339()));
    }

    let dev_id = format!("ios-ikev2-{}", &sub.token[..8]);
    let _ = Repository::register_or_update_device(
        &state.pool,
        sub.user_id,
        sub.id,
        &dev_id,
        "iPhone IKEv2",
        "ios",
    )
    .await;

    let mode = query.mode.as_deref().unwrap_or("web_browsing");
    if mode == "gaming" {
        if !Repository::has_active_gaming_outbounds(&state.pool).await {
            return Err(CoreError::ModeComingSoon {
                mode: "گیمینگ (Gaming)".to_string(),
            });
        }
        if !compiler::tier_has_gaming(&sub.tier) {
            return Err(CoreError::ModeLocked {
                mode: "گیمینگ (Gaming)".to_string(),
            });
        }
    }
    if mode == "static_ip" {
        if !compiler::tier_has_static_ip(&sub.tier) {
            return Err(CoreError::ModeLocked {
                mode: "آی‌پی ثابت (Static IP)".to_string(),
            });
        }
        if sub.static_ip_used_mb >= 30_720 {
            return Err(CoreError::StaticIpQuotaExceeded {
                used_mb: sub.static_ip_used_mb,
                limit_mb: 30_720,
            });
        }
    }

    Repository::check_and_reset_daily_quota(&state.pool, &mut sub).await?;

    let server_host = if state.server_host == "0.0.0.0" || state.server_host.is_empty() {
        "127.0.0.1".to_string()
    } else {
        state.server_host.clone()
    };

    let xml = compiler::generate_mobileconfig_profile(&sub, mode, &server_host);

    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/x-apple-aspen-config"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=\"sentra-ikev2.mobileconfig\"",
            ),
        ],
        xml,
    )
        .into_response())
}

/// GET /api/v1/wireguard/:token
/// Issues an ultra-low-latency WireGuard (.conf) gaming profile for iOS WireGuard app.
/// Strictly enforces server-side Gaming tier entitlement.
async fn get_wireguard_gaming_profile(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> Result<Response, CoreError> {
    let sub = Repository::get_subscription_by_token(&state.pool, &token).await?;

    let user_opt = Repository::get_user_by_id(&state.pool, sub.user_id).await?;
    if let Some(user) = user_opt {
        if user.status == "suspended" || sub.status == "suspended" {
            return Err(CoreError::AccountSuspended(
                "حساب شما به دلیل الگوی مصرف ترافیک غیرعادی موقتاً متوقف شده است. لطفاً با پشتیبانی در ارتباط باشید.".to_string(),
            ));
        }
        if user.status == "banned" || sub.status == "disabled" {
            return Err(CoreError::UserBanned("حساب کاربری شما مسدود شده است.".to_string()));
        }
    }

    if sub.expires_at < Utc::now() {
        return Err(CoreError::SubscriptionExpired(sub.expires_at.to_rfc3339()));
    }

    if !Repository::has_active_gaming_outbounds(&state.pool).await {
        return Err(CoreError::ModeComingSoon {
            mode: "گیمینگ (WireGuard iOS)".to_string(),
        });
    }

    if !compiler::tier_has_gaming(&sub.tier) {
        return Err(CoreError::ModeLocked {
            mode: "گیمینگ (WireGuard iOS)".to_string(),
        });
    }

    let token_prefix: String = sub.token.chars().take(8).collect();
    let dev_id = format!("ios-wg-{}", token_prefix);
    let _ = Repository::register_or_update_device(
        &state.pool,
        sub.user_id,
        sub.id,
        &dev_id,
        "iPhone WireGuard Gaming",
        "ios",
    )
    .await;

    let server_host = if state.server_host == "0.0.0.0" || state.server_host.is_empty() {
        "127.0.0.1".to_string()
    } else {
        state.server_host.clone()
    };

    let (wg_conf, _client_pub, _client_addr) =
        compiler::generate_wireguard_gaming_profile(&sub, &server_host);

    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "text/plain; charset=utf-8"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=\"sentra-gaming-wg.conf\"",
            ),
            (header::CACHE_CONTROL, "no-store, no-cache, must-revalidate"),
        ],
        wg_conf,
    )
        .into_response())
}

/// POST /api/internal/openvpn/auth
/// Internal hook for OpenVPN server to authenticate users and enforce static IP 30GB limits
async fn openvpn_internal_auth(
    State(state): State<AppState>,
    Json(payload): Json<OpenVpnAuthRequest>,
) -> Result<Response, CoreError> {
    let token = payload.password.as_deref().unwrap_or(&payload.username);
    let sub = Repository::get_subscription_by_token(&state.pool, token).await?;

    let mode = payload.mode.as_deref().unwrap_or("web_browsing");
    if mode == "gaming" {
        if !Repository::has_active_gaming_outbounds(&state.pool).await {
            return Err(CoreError::ModeComingSoon {
                mode: "گیمینگ (Gaming)".to_string(),
            });
        }
        if !compiler::tier_has_gaming(&sub.tier) {
            return Err(CoreError::ModeLocked {
                mode: "گیمینگ (Gaming)".to_string(),
            });
        }
    }
    if mode == "static_ip" {
        if !compiler::tier_has_static_ip(&sub.tier) {
            return Err(CoreError::ModeLocked {
                mode: "آی‌پی ثابت (Static IP)".to_string(),
            });
        }
        if sub.static_ip_used_mb >= 30_720 {
            return Err(CoreError::StaticIpQuotaExceeded {
                used_mb: sub.static_ip_used_mb,
                limit_mb: 30_720,
            });
        }
    }

    Ok((
        StatusCode::OK,
        Json(json!({
            "status": "ok",
            "user_id": sub.user_id,
            "tier": sub.tier,
            "mode": mode
        })),
    )
        .into_response())
}

/// POST /api/internal/openvpn/accounting
/// Internal hook for OpenVPN server to account traffic and enforce static IP disconnects
async fn openvpn_internal_accounting(
    State(state): State<AppState>,
    Json(payload): Json<OpenVpnAccountingRequest>,
) -> Result<Response, CoreError> {
    let mode = payload.mode.as_deref().unwrap_or("web_browsing");
    let verdict = Repository::process_heartbeat(
        &state.pool,
        &payload.token,
        "internal-openvpn-session",
        mode,
        payload.bytes_sent,
        payload.bytes_received,
    )
    .await?;

    Ok((
        StatusCode::OK,
        Json(json!(verdict)),
    )
        .into_response())
}

/// POST /api/internal/ikev2/auth
/// Internal hook for strongSwan / IKEv2 server to authenticate users and enforce static IP 30GB limits
async fn ikev2_internal_auth(
    State(state): State<AppState>,
    Json(payload): Json<OpenVpnAuthRequest>,
) -> Result<Response, CoreError> {
    let token = payload.password.as_deref().unwrap_or(&payload.username);
    let sub = Repository::get_subscription_by_token(&state.pool, token).await?;

    let mode = payload.mode.as_deref().unwrap_or("web_browsing");
    if mode == "static_ip" {
        if sub.tier == "Sentra Lite" {
            return Err(CoreError::ModeLocked {
                mode: "آی‌پی ثابت (Static IP)".to_string(),
            });
        }
        if sub.static_ip_used_mb >= 30_720 {
            return Err(CoreError::StaticIpQuotaExceeded {
                used_mb: sub.static_ip_used_mb,
                limit_mb: 30_720,
            });
        }
    }

    Ok((
        StatusCode::OK,
        Json(json!({
            "status": "ok",
            "user_id": sub.user_id,
            "tier": sub.tier,
            "mode": mode
        })),
    )
        .into_response())
}

/// POST /api/internal/ikev2/accounting
/// Internal hook for strongSwan / IKEv2 server to account traffic and enforce quota disconnects
async fn ikev2_internal_accounting(
    State(state): State<AppState>,
    Json(payload): Json<OpenVpnAccountingRequest>,
) -> Result<Response, CoreError> {
    let mode = payload.mode.as_deref().unwrap_or("web_browsing");
    let verdict = Repository::process_heartbeat(
        &state.pool,
        &payload.token,
        "internal-ikev2-session",
        mode,
        payload.bytes_sent,
        payload.bytes_received,
    )
    .await?;

    Ok((
        StatusCode::OK,
        Json(json!(verdict)),
    )
        .into_response())
}

/// GET /health
async fn health_check(State(state): State<AppState>) -> Result<Response, CoreError> {
    let stats = Repository::get_system_health(&state.pool).await?;

    Ok((
        StatusCode::OK,
        Json(json!({
            "status": "healthy",
            "service": "sentra-core",
            "timestamp": Utc::now().to_rfc3339(),
            "layers": {
                "l1_database_wal": stats.wal_mode_active,
                "l2_rest_api_port_8080": true,
                "l3_fakeip_dns_pool": "198.18.0.0/15 (ipv4_only)",
                "l4_active_outbounds": stats.active_outbounds,
                "l5_tokio_async_runtime": "operational",
                "l6_telegram_dispatcher": "healthy"
            },
            "metrics": {
                "total_users": stats.total_users,
                "lite_users": stats.lite_users,
                "pro_users": stats.pro_users,
                "flow_users": stats.flow_users,
                "active_outbounds": stats.active_outbounds,
                "open_tickets": stats.open_tickets
            }
        })),
    )
        .into_response())
}

/// Helper to extract authenticated subscription token from query or headers
fn extract_auth_token(headers: &HeaderMap, query_token: Option<&str>) -> Option<String> {
    if let Some(t) = query_token {
        let trimmed = t.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.strip_prefix("jwt_sentra_").unwrap_or(trimmed).to_string());
        }
    }
    if let Some(h) = headers.get("X-Subscription-Token").and_then(|v| v.to_str().ok()) {
        let trimmed = h.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.strip_prefix("jwt_sentra_").unwrap_or(trimmed).to_string());
        }
    }
    if let Some(auth) = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()) {
        if let Some(raw) = auth.trim().strip_prefix("Bearer ") {
            let trimmed = raw.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.strip_prefix("jwt_sentra_").unwrap_or(trimmed).to_string());
            }
        }
    }
    None
}

/// GET /api/v1/client/bootstrap
/// Returns complete live user account state, real subscription metrics, active devices count,
/// real Telegram bot username from .env, non-gaming connection modes, and ALL active outbounds in SQLite.
async fn get_client_bootstrap(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ModesQuery>,
) -> Result<Response, CoreError> {
    let token = extract_auth_token(&headers, query.token.as_deref())
        .ok_or_else(|| CoreError::AuthFailed("توکن احراز هویت ارسال نشده است.".to_string()))?;

    let mut sub = Repository::get_subscription_by_token(&state.pool, &token).await?;
    Repository::check_and_reset_daily_quota(&state.pool, &mut sub).await?;

    let user = Repository::get_user_by_id(&state.pool, sub.user_id)
        .await?
        .ok_or_else(|| CoreError::AuthFailed("کاربر یافت نشد.".to_string()))?;

    if user.status == "banned" || sub.status == "disabled" {
        return Err(CoreError::UserBanned("حساب کاربری شما مسدود شده است.".to_string()));
    }

    if let Some(dev_id) = headers
        .get("X-Device-Id")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let _ = sqlx::query(
            "UPDATE user_devices SET last_active_at = CURRENT_TIMESTAMP WHERE user_id = ? AND device_id = ?"
        )
        .bind(user.id)
        .bind(dev_id)
        .execute(&state.pool)
        .await;
    }

    let devices = Repository::get_user_devices(&state.pool, user.id)
        .await
        .unwrap_or_default();
    let outbounds = Repository::get_all_live_client_outbounds(&state.pool).await?;
    let gaming_enabled = Repository::has_active_gaming_outbounds(&state.pool).await;
    let modes = Repository::build_modes_info(&sub, gaming_enabled);

    let client_state = read_user_client_state_json(&state.pool, user.id).await;

    let used_bytes = (sub.upload_bytes + sub.download_bytes).max(0);
    let remaining_bytes = (sub.traffic_limit_bytes - used_bytes).max(0);
    let now = Utc::now();
    let remaining_days = if sub.expires_at > now {
        let secs = (sub.expires_at - now).num_seconds();
        ((secs + 86_399) / 86_400).max(0)
    } else {
        0
    };

    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/json; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store, no-cache, must-revalidate"),
        ],
        Json(json!({
            "success": true,
            "server_time": now.to_rfc3339(),
            "bot_username": state.bot_username,
            "user": {
                "id": user.id,
                "user_uuid": user.user_uuid,
                "username": user.username,
                "first_name": user.first_name,
                "telegram_id": user.telegram_id,
                "role": user.role,
                "status": user.status
            },
            "subscription": {
                "tier": sub.tier,
                "token": sub.token,
                "status": sub.status,
                "upload_bytes": sub.upload_bytes,
                "download_bytes": sub.download_bytes,
                "used_bytes": used_bytes,
                "traffic_limit_bytes": sub.traffic_limit_bytes,
                "remaining_bytes": remaining_bytes,
                "web_browsing_used_mb": sub.web_browsing_used_mb,
                "download_used_mb": sub.download_used_mb,
                "static_ip_used_mb": sub.static_ip_used_mb,
                "active_devices_count": devices.len(),
                "max_concurrent_devices": sub.max_concurrent_devices.max(3),
                "remaining_days": remaining_days,
                "expires_at": sub.expires_at.to_rfc3339()
            },
            "devices": devices,
            "modes": modes,
            "outbounds": outbounds,
            "client_state": client_state
        })),
    )
        .into_response())
}

async fn read_user_client_state_json(pool: &DbPool, user_id: i64) -> serde_json::Value {
    let row: Option<(String, String, String)> = sqlx::query_as(
        "SELECT personal_configs_json, preferences_json, updated_at FROM user_client_state WHERE user_id = ? LIMIT 1"
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .unwrap_or(None);

    match row {
        Some((configs_str, prefs_str, updated_at)) => {
            let personal_configs = serde_json::from_str::<serde_json::Value>(&configs_str)
                .ok()
                .filter(|v| v.is_array())
                .unwrap_or_else(|| json!([]));
            let preferences = serde_json::from_str::<serde_json::Value>(&prefs_str)
                .ok()
                .filter(|v| v.is_object())
                .unwrap_or_else(|| json!({}));
            json!({
                "personal_configs": personal_configs,
                "preferences": preferences,
                "updated_at": updated_at
            })
        }
        None => json!({
            "personal_configs": [],
            "preferences": {},
            "updated_at": ""
        }),
    }
}

/// GET /api/v1/client/sync-state
async fn get_client_sync_state(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ModesQuery>,
) -> Result<Response, CoreError> {
    let token = extract_auth_token(&headers, query.token.as_deref())
        .ok_or_else(|| CoreError::AuthFailed("توکن احراز هویت ارسال نشده است.".to_string()))?;
    let sub = Repository::get_subscription_by_token(&state.pool, &token).await?;
    let client_state = read_user_client_state_json(&state.pool, sub.user_id).await;

    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/json; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store, no-cache, must-revalidate"),
        ],
        Json(json!({
            "success": true,
            "client_state": client_state
        })),
    )
        .into_response())
}

/// PUT /api/v1/client/sync-state
async fn put_client_sync_state(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ModesQuery>,
    Json(payload): Json<SyncClientStateRequest>,
) -> Result<Response, CoreError> {
    let token = extract_auth_token(&headers, query.token.as_deref())
        .ok_or_else(|| CoreError::AuthFailed("توکن احراز هویت ارسال نشده است.".to_string()))?;
    let sub = Repository::get_subscription_by_token(&state.pool, &token).await?;

    let existing = read_user_client_state_json(&state.pool, sub.user_id).await;

    let next_configs = match payload.personal_configs {
        Some(v) if v.is_array() => {
            let mut arr = v.as_array().cloned().unwrap_or_default();
            arr.truncate(100);
            serde_json::Value::Array(arr)
        }
        _ => existing.get("personal_configs").cloned().unwrap_or_else(|| json!([])),
    };

    let next_prefs = match payload.preferences {
        Some(v) if v.is_object() => {
            let mut merged = existing
                .get("preferences")
                .and_then(|o| o.as_object())
                .cloned()
                .unwrap_or_default();
            if let Some(incoming) = v.as_object() {
                for (k, val) in incoming {
                    merged.insert(k.clone(), val.clone());
                }
            }
            serde_json::Value::Object(merged)
        }
        _ => existing.get("preferences").cloned().unwrap_or_else(|| json!({})),
    };

    let configs_str = serde_json::to_string(&next_configs)
        .map_err(|e| CoreError::BadRequest(format!("ساختار کانفیگ‌های شخصی نامعتبر است: {}", e)))?;
    let prefs_str = serde_json::to_string(&next_prefs)
        .map_err(|e| CoreError::BadRequest(format!("ساختار تنظیمات نامعتبر است: {}", e)))?;

    if configs_str.len() > 262_144 || prefs_str.len() > 16_384 {
        return Err(CoreError::BadRequest("حجم داده‌های همگام‌سازی بیش از حد مجاز است.".to_string()));
    }

    let now_iso = Utc::now().to_rfc3339();
    sqlx::query(
        r#"
        INSERT INTO user_client_state (user_id, personal_configs_json, preferences_json, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
            personal_configs_json = excluded.personal_configs_json,
            preferences_json = excluded.preferences_json,
            updated_at = excluded.updated_at
        "#
    )
    .bind(sub.user_id)
    .bind(&configs_str)
    .bind(&prefs_str)
    .bind(&now_iso)
    .execute(&state.pool)
    .await?;

    Ok((
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        Json(json!({
            "success": true,
            "client_state": {
                "personal_configs": next_configs,
                "preferences": next_prefs,
                "updated_at": now_iso
            }
        })),
    )
        .into_response())
}

/// POST /api/v1/client/outbounds/donate
/// Allows an authenticated user to donate a personal proxy URI (vless/vmess/trojan/ss/hy2/tuic/wireguard)
/// for Admin Telegram approval with +7 / +15 / +30 day subscription rewards.
async fn donate_client_outbound(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ModesQuery>,
    Json(payload): Json<DonateOutboundRequest>,
) -> Result<Response, CoreError> {
    let token = extract_auth_token(&headers, query.token.as_deref())
        .ok_or_else(|| CoreError::AuthFailed("برای اهدای اوتباند ابتدا وارد حساب کاربری خود شوید.".to_string()))?;

    let sub = Repository::get_subscription_by_token(&state.pool, &token).await?;
    let user = Repository::get_user_by_id(&state.pool, sub.user_id)
        .await?
        .ok_or_else(|| CoreError::AuthFailed("کاربر یافت نشد.".to_string()))?;

    if user.outbound_reward_banned != 0 {
        return Err(CoreError::BadRequest(
            "دسترسی ارسال اوتباند اهدایی برای این حساب محدود شده است.".to_string(),
        ));
    }

    let raw_uri = payload.uri.trim();
    if raw_uri.is_empty() || raw_uri.len() > 8192 {
        return Err(CoreError::BadRequest("لینک کانفیگ نامعتبر یا خالی است.".to_string()));
    }

    let parsed = crate::outbound_analyzer::OutboundAnalyzer::parse_input(raw_uri)
        .map_err(CoreError::BadRequest)?;

    // Anti-SSRF check to block internal/private IP ranges
    let resolved_ip = crate::outbound_analyzer::OutboundAnalyzer::check_anti_ssrf(&parsed.server_address)
        .await
        .map_err(CoreError::BadRequest)?;

    // Compute unique SHA-256 fingerprint to prevent duplicate submissions
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(
        format!(
            "{}:{}:{}",
            parsed.protocol.to_lowercase(),
            parsed.server_address.to_lowercase(),
            parsed.server_port
        )
        .as_bytes(),
    );
    let fingerprint = format!("{:x}", hasher.finalize());

    if Repository::check_duplicate_fingerprint(&state.pool, &fingerprint).await? {
        return Err(CoreError::BadRequest(
            "این سرور قبلاً در شبکه سنترا ثبت شده است. لطفاً سرور دیگری ارسال نمایید.".to_string(),
        ));
    }

    // Measure protocol-aware reachability & latency (supports UDP protocols hy2/tuic/wireguard)
    let (latency_ms, _speed_mbps, is_online, err_opt) =
        crate::outbound_analyzer::OutboundAnalyzer::benchmark_proxy_for_protocol(
            &parsed.protocol,
            resolved_ip,
            parsed.server_port,
        )
        .await;
    if !is_online {
        let reason = err_opt.unwrap_or_else(|| "سرور در دسترس نیست یا پاسخگو نبود.".to_string());
        return Err(CoreError::BadRequest(format!(
            "تست اتصال اولیه به سرور ناموفق بود: {}",
            reason
        )));
    }

    let (country_code, country_name) =
        crate::outbound_analyzer::OutboundAnalyzer::detect_country(resolved_ip, &parsed.tag).await;
    let flag = crate::outbound_analyzer::OutboundAnalyzer::country_code_to_flag(&country_code);

    let final_tag = payload
        .name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&parsed.tag)
        .to_string();

    let clean_note = payload
        .note
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(400).collect::<String>());

    let config_json_str = serde_json::to_string(&parsed.config_json).unwrap_or_else(|_| "{}".to_string());

    let outbound_id = Repository::create_pending_donated_outbound(
        &state.pool,
        user.id,
        &final_tag,
        &parsed.protocol,
        &parsed.server_address,
        parsed.server_port as i64,
        &config_json_str,
        latency_ms,
        raw_uri,
        &country_code,
        &country_name,
        &fingerprint,
        clean_note.as_deref(),
    )
    .await?;

    // Immediately activate across the server Sing-box bridge (OpenVPN/IKEv2/Stealth/WARP)
    let _ = crate::bridge_sync::sync_server_bridge_config(&state.pool).await;

    // Notify Admin in Telegram with inline review buttons (+7 / +15 / +30 days reward or Reject)
    if let Some(ref bot) = state.bot {
        if state.admin_chat_id != 0 {
            use teloxide::prelude::*;
            use teloxide::types::{ChatId, ParseMode};

            let donor_label = user
                .username
                .as_deref()
                .map(|u| format!("@{} (ID: {})", u, user.id))
                .unwrap_or_else(|| format!("{} (ID: {})", user.first_name, user.id));
            let short_uri: String = raw_uri.chars().take(320).collect();
            let note_section = clean_note
                .as_deref()
                .map(|n| format!("\n📝 <b>توضیحات کاربر:</b> <i>{}</i>", n))
                .unwrap_or_default();

            let admin_msg = format!(
                "🎁 <b>اوتباند اهدایی جدید در کل اکوسیستم فعال شد</b> (#{})\n\n\
                 👤 <b>کاربر اهداکننده:</b> <code>{}</code>\n\
                 🏷 <b>نام سرور:</b> <code>{}</code>\n\
                 🔌 <b>پروتکل:</b> <b>{}</b>\n\
                 🌍 <b>موقعیت:</b> {} {} (<code>{}:{}</code>)\n\
                 ⚡ <b>پینگ تست‌شده:</b> <b>{} ms</b>{}\n\n\
                 🔗 <b>لینک ارسالی:</b>\n<code>{}</code>\n\n\
                 ✅ این نود پس از تست سلامت، بلافاصله در کل اکوسیستم فعال شد. جهت اهدای پاداش اشتراک یا رد/غیرفعال‌سازی انتخاب کنید:",
                outbound_id,
                donor_label,
                final_tag,
                parsed.protocol.to_uppercase(),
                flag,
                country_name,
                parsed.server_address,
                parsed.server_port,
                latency_ms,
                note_section,
                short_uri
            );

            let kb = crate::bot::keyboards::donated_outbound_review_keyboard(outbound_id);
            if let Err(e) = bot
                .send_message(ChatId(state.admin_chat_id), admin_msg)
                .parse_mode(ParseMode::Html)
                .reply_markup(kb)
                .await
            {
                tracing::error!("Failed to send donated outbound review to Admin Telegram: {:?}", e);
            }
        }
    }

    Ok((
        StatusCode::CREATED,
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        Json(json!({
            "success": true,
            "id": outbound_id,
            "status": "active",
            "latency_ms": latency_ms,
            "protocol": parsed.protocol,
            "country_code": country_code,
            "flag": flag,
            "message": "اوتباند اهدایی شما با موفقیت تست و بلافاصله در کل اکوسیستم سنترا فعال شد. پس از بررسی مدیر، پاداش اشتراک نیز به حساب شما افزوده می‌شود."
        })),
    )
        .into_response())
}

/// POST /api/v1/client/outbounds/add
/// Allows admins (as official) or authenticated users (as active community node) to publish an outbound across the entire ecosystem
async fn add_ecosystem_outbound(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<DonateOutboundRequest>,
) -> Result<Response, CoreError> {
    let token = extract_auth_token(&headers, None)
        .ok_or_else(|| CoreError::AuthFailed("توکن احراز هویت نامعتبر است.".to_string()))?;

    let sub = Repository::get_subscription_by_token(&state.pool, &token).await?;
    let user = Repository::get_user_by_id(&state.pool, sub.user_id)
        .await?
        .ok_or_else(|| CoreError::AuthFailed("کاربر یافت نشد.".to_string()))?;

    let is_admin = user.role == "admin"
        || (state.admin_chat_id != 0 && user.telegram_id == Some(state.admin_chat_id));

    if !is_admin {
        return donate_client_outbound(State(state), headers, Json(payload)).await;
    }

    let raw_uri = payload.uri.trim();
    if raw_uri.is_empty() || raw_uri.len() > 8192 {
        return Err(CoreError::BadRequest("لینک کانفیگ نامعتبر یا خالی است.".to_string()));
    }

    let parsed = crate::outbound_analyzer::OutboundAnalyzer::parse_input(raw_uri)
        .map_err(CoreError::BadRequest)?;

    let resolved_ip = crate::outbound_analyzer::OutboundAnalyzer::check_anti_ssrf(&parsed.server_address)
        .await
        .map_err(CoreError::BadRequest)?;

    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(
        format!(
            "{}:{}:{}",
            parsed.protocol.to_lowercase(),
            parsed.server_address.to_lowercase(),
            parsed.server_port
        )
        .as_bytes(),
    );
    let fingerprint = format!("{:x}", hasher.finalize());

    let (latency_ms, speed_mbps, is_online, _err_opt) =
        crate::outbound_analyzer::OutboundAnalyzer::benchmark_proxy_for_protocol(
            &parsed.protocol,
            resolved_ip,
            parsed.server_port,
        )
        .await;

    let (country_code, country_name) =
        crate::outbound_analyzer::OutboundAnalyzer::detect_country(resolved_ip, &parsed.tag).await;
    let flag = crate::outbound_analyzer::OutboundAnalyzer::country_code_to_flag(&country_code);

    let final_tag = payload
        .name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&parsed.tag)
        .to_string();

    let config_json_str = serde_json::to_string(&parsed.config_json).unwrap_or_else(|_| "{}".to_string());

    let inserted = Repository::insert_official_outbound(
        &state.pool,
        &final_tag,
        &final_tag,
        &parsed.protocol,
        &parsed.server_address,
        parsed.server_port as i64,
        &config_json_str,
        if is_online { latency_ms } else { 0 },
        speed_mbps,
        "both",
        Some(raw_uri),
        &fingerprint,
        "active",
        if is_online { 100 } else { 85 },
        &country_code,
        &country_name,
    )
    .await?;

    let _ = crate::bridge_sync::sync_server_bridge_config(&state.pool).await;

    Ok((
        StatusCode::CREATED,
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        Json(json!({
            "success": true,
            "id": inserted.id,
            "is_official": true,
            "status": "active",
            "latency_ms": inserted.latency_ms,
            "protocol": inserted.protocol,
            "country_code": country_code,
            "flag": flag,
            "message": "اوتباند رسمی شما با موفقیت ثبت و بلافاصله در کل اکوسیستم سنترا فعال شد."
        })),
    )
        .into_response())
}

/// GET /api/v1/client/outbounds/my-donations
/// Returns the authenticated user's submitted community outbounds and approval/reward statuses
async fn get_my_donated_outbounds(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ModesQuery>,
) -> Result<Response, CoreError> {
    let token = extract_auth_token(&headers, query.token.as_deref())
        .ok_or_else(|| CoreError::AuthFailed("توکن احراز هویت نامعتبر است.".to_string()))?;

    let sub = Repository::get_subscription_by_token(&state.pool, &token).await?;
    let donations = Repository::get_user_donated_outbounds(&state.pool, sub.user_id).await?;

    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/json; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store, no-cache, must-revalidate"),
        ],
        Json(json!({
            "success": true,
            "donations": donations
        })),
    )
        .into_response())
}

fn urlencoding_simple(input: &str) -> String {
    input.replace(' ', "%20")
}
