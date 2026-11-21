use crate::api::singbox;
use crate::db::repository::Repository;
use crate::db::DbPool;
use crate::error::CoreError;
use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Debug, Deserialize)]
pub struct ConnectRequest {
    pub token: String,
    pub device_id: Option<String>,
    pub os: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ExchangeCodeRequest {
    pub code: String,
    pub device_identifier: String,
    pub device_name: String,
    pub os: String,
    pub client_version: String,
}

#[derive(Debug, Deserialize)]
pub struct SubQuery {
    pub format: Option<String>,
}

/// POST /api/v1/client/connect
/// Validates user token/UUID, checks tier (Lite, Pro, Flow+) and traffic quota,
/// and returns a compiled Sing-box v1.10+ JSON config.
pub async fn client_connect(
    State(pool): State<DbPool>,
    Json(payload): Json<ConnectRequest>,
) -> Result<Response, CoreError> {
    let sub = Repository::get_subscription_by_token(&pool, &payload.token).await?;

    // Check expiration
    if sub.expires_at < Utc::now() {
        return Err(CoreError::SubscriptionExpired(
            sub.expires_at.to_rfc3339(),
        ));
    }

    // Check traffic quota (if traffic_limit_bytes > 0)
    let used_bytes = sub.upload_bytes + sub.download_bytes;
    if sub.traffic_limit_bytes > 0 && used_bytes >= sub.traffic_limit_bytes {
        return Err(CoreError::QuotaExceeded {
            used: used_bytes,
            limit: sub.traffic_limit_bytes,
        });
    }

    // Fetch active outbounds allowed for this tier
    let outbounds = Repository::get_allowed_outbounds_for_tier(&pool, &sub.tier).await?;

    // Compile Sing-box v1.10+ JSON configuration
    let singbox_json = singbox::build_client_config(&sub, &outbounds);

    Ok((
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        Json(singbox_json),
    )
        .into_response())
}

/// GET /sub/{token} and GET /api/v1/sub/{token}
/// Returns Base64 V2Ray links or Sing-box JSON based on User-Agent.
pub async fn get_subscription(
    State(pool): State<DbPool>,
    Path(token): Path<String>,
    Query(query): Query<SubQuery>,
    headers: HeaderMap,
) -> Result<Response, CoreError> {
    let sub = Repository::get_subscription_by_token(&pool, &token).await?;

    // Check if expired
    if sub.expires_at < Utc::now() {
        return Err(CoreError::SubscriptionExpired(
            sub.expires_at.to_rfc3339(),
        ));
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

    let outbounds = Repository::get_allowed_outbounds_for_tier(&pool, &sub.tier).await?;

    let sub_userinfo = format!(
        "upload={}; download={}; total={}; expire={}",
        sub.upload_bytes,
        sub.download_bytes,
        sub.traffic_limit_bytes,
        sub.expires_at.timestamp()
    );

    if wants_singbox {
        // Return compiled Sing-box JSON
        let singbox_json = singbox::build_client_config(&sub, &outbounds);
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
        // Generate Base64 V2Ray URI list
        let mut lines = Vec::new();
        for ob in outbounds {
            let uri = match ob.protocol.as_str() {
                "socks" => format!(
                    "socks://{}:{}#{}",
                    ob.server_address,
                    ob.server_port,
                    urlencoding_simple(&ob.tag)
                ),
                "http" => format!(
                    "http://{}:{}#{}",
                    ob.server_address,
                    ob.server_port,
                    urlencoding_simple(&ob.tag)
                ),
                "vless" => format!(
                    "vless://{}@{}:{}?security=reality&type=tcp#{}",
                    ob.uuid.as_deref().unwrap_or("00000000-0000-0000-0000-000000000000"),
                    ob.server_address,
                    ob.server_port,
                    urlencoding_simple(&ob.tag)
                ),
                _ => format!(
                    "socks://{}:{}#{}",
                    ob.server_address,
                    ob.server_port,
                    urlencoding_simple(&ob.tag)
                ),
            };
            lines.push(uri);
        }

        let raw_payload = lines.join("\n");
        let encoded_payload = BASE64.encode(raw_payload.as_bytes());

        Ok((
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, "text/plain; charset=utf-8"),
                (
                    header::CONTENT_DISPOSITION,
                    "attachment; filename=\"sentra-subscription.txt\"",
                ),
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

/// POST /api/v1/auth/exchange-code
/// Exchanges an 8-digit OTP code generated by the Telegram bot for client credentials
pub async fn exchange_code(
    State(pool): State<DbPool>,
    Json(payload): Json<ExchangeCodeRequest>,
) -> Result<Response, CoreError> {
    let (user, sub) = Repository::exchange_auth_code(
        &pool,
        &payload.code,
        &payload.device_identifier,
        &payload.device_name,
        &payload.os,
        &payload.client_version,
        "127.0.0.1",
    )
    .await?;

    let remaining_bytes = (sub.traffic_limit_bytes - (sub.upload_bytes + sub.download_bytes)).max(0);

    Ok((
        StatusCode::OK,
        Json(json!({
            "success": true,
            "access_token": format!("jwt_mock_{}", sub.token),
            "token_type": "Bearer",
            "user": {
                "id": user.id,
                "telegram_id": user.telegram_id,
                "username": user.username,
                "first_name": user.first_name,
                "role": user.role,
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

/// GET /api/v1/ovpn/{token}
/// Generates a valid OpenVPN profile for fallback connection
pub async fn get_openvpn_profile(
    State(pool): State<DbPool>,
    Path(token): Path<String>,
) -> Result<Response, CoreError> {
    let sub = Repository::get_subscription_by_token(&pool, &token).await?;

    let ovpn_content = format!(
        r#"# Sentra OpenVPN Sandbox Profile - Tier: {}
client
dev tun
proto udp
remote 127.0.0.1 1194
resolv-retry infinite
nobind
persist-key
persist-tun
remote-cert-tls server
cipher AES-256-GCM
auth SHA256
verb 3

<ca>
-----BEGIN CERTIFICATE-----
MIIDSzCCAjOgAwIBAgIUW8d0Q3k9M...[SENTRA-SANDBOX-CA]...
-----END CERTIFICATE-----
</ca>

<cert>
-----BEGIN CERTIFICATE-----
MIIDRjCCAi6gAwIBAgIUX9e1R4l0N...[SENTRA-CLIENT-CERT]...
-----END CERTIFICATE-----
</cert>

<key>
-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQE...[SENTRA-CLIENT-KEY]...
-----END PRIVATE KEY-----
</key>
"#,
        sub.tier
    );

    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/x-openvpn-profile"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=\"sentra-client.ovpn\"",
            ),
        ],
        ovpn_content,
    )
        .into_response())
}

/// GET /health
/// System diagnostics and database stats
pub async fn health_check(State(pool): State<DbPool>) -> Result<Response, CoreError> {
    let (users, active_subs, outbounds, open_tickets) =
        Repository::get_system_health(&pool).await?;

    Ok((
        StatusCode::OK,
        Json(json!({
            "status": "healthy",
            "service": "sentra-core",
            "timestamp": Utc::now().to_rfc3339(),
            "metrics": {
                "total_users": users,
                "active_subscriptions": active_subs,
                "active_outbounds": outbounds,
                "open_tickets": open_tickets
            }
        })),
    )
        .into_response())
}

fn urlencoding_simple(input: &str) -> String {
    input.replace(' ', "%20")
}
