use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use thiserror::Error;

#[derive(Error, Debug)]
#[allow(dead_code)]
pub enum CoreError {
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),

    #[error("Network HTTP error: {0}")]
    Reqwest(#[from] reqwest::Error),

    #[error("Authentication failed: {0}")]
    AuthFailed(String),

    #[error("User not found")]
    UserNotFound,

    #[error("Subscription not found or token invalid")]
    SubscriptionNotFound,

    #[error("Subscription expired on {0}")]
    SubscriptionExpired(String),

    #[error("Traffic quota exceeded: used {used} of {limit} bytes")]
    QuotaExceeded { used: i64, limit: i64 },

    #[error("User is banned: {0}")]
    UserBanned(String),

    #[error("Device limit reached: maximum {0} devices allowed")]
    DeviceLimitExceeded(i64),

    #[error("Internal server error: {0}")]
    Internal(String),

    #[error("Invalid request input: {0}")]
    BadRequest(String),

    #[error("Proxy initialization error: {0}")]
    ProxyError(String),
}

impl IntoResponse for CoreError {
    fn into_response(self) -> Response {
        let (status, error_code, message) = match &self {
            CoreError::Database(e) => {
                tracing::error!("Database query failed: {:?}", e);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "DATABASE_ERROR",
                    "A database error occurred while processing your request.".to_string(),
                )
            }
            CoreError::Reqwest(e) => {
                tracing::error!("HTTP upstream request failed: {:?}", e);
                (
                    StatusCode::BAD_GATEWAY,
                    "UPSTREAM_GATEWAY_ERROR",
                    "Failed to communicate with network upstream.".to_string(),
                )
            }
            CoreError::AuthFailed(msg) => (
                StatusCode::UNAUTHORIZED,
                "AUTH_FAILED",
                msg.clone(),
            ),
            CoreError::UserNotFound => (
                StatusCode::NOT_FOUND,
                "USER_NOT_FOUND",
                "The requested user account does not exist.".to_string(),
            ),
            CoreError::SubscriptionNotFound => (
                StatusCode::UNAUTHORIZED,
                "SUBSCRIPTION_NOT_FOUND",
                "The provided subscription token is invalid or has been revoked.".to_string(),
            ),
            CoreError::SubscriptionExpired(date) => (
                StatusCode::PAYMENT_REQUIRED,
                "SUBSCRIPTION_EXPIRED",
                format!("Your subscription expired on {}. Please upgrade to continue.", date),
            ),
            CoreError::QuotaExceeded { used, limit } => (
                StatusCode::PAYMENT_REQUIRED,
                "QUOTA_EXCEEDED",
                format!("Data limit exhausted: used {} of {} bytes.", used, limit),
            ),
            CoreError::UserBanned(reason) => (
                StatusCode::FORBIDDEN,
                "USER_BANNED",
                format!("Account suspended: {}", reason),
            ),
            CoreError::DeviceLimitExceeded(max) => (
                StatusCode::FORBIDDEN,
                "DEVICE_LIMIT_EXCEEDED",
                format!("Concurrent device limit reached (max: {} devices).", max),
            ),
            CoreError::Internal(msg) => {
                tracing::error!("Internal error: {}", msg);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "INTERNAL_ERROR",
                    "An unexpected error occurred.".to_string(),
                )
            }
            CoreError::BadRequest(msg) => (
                StatusCode::BAD_REQUEST,
                "BAD_REQUEST",
                msg.clone(),
            ),
            CoreError::ProxyError(msg) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "PROXY_ERROR",
                format!("Telegram proxy error: {}", msg),
            ),
        };

        let body = Json(json!({
            "success": false,
            "error": error_code,
            "message": message,
        }));

        (status, body).into_response()
    }
}
