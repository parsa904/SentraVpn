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

    #[error("سقف حجم روزانه شما برای حالت {mode} به اتمام رسیده است ({used_mb} مگابایت از {limit_mb} مگابایت). سهمیه روزانه هر ۲۴ ساعت ریست می‌شود.")]
    DailyQuotaExceeded { mode: String, used_mb: i64, limit_mb: i64 },

    #[error("سقف حجم ۳۰ گیگابایت ماهانه آی‌پی ثابت به پایان رسیده است ({used_mb} از {limit_mb} مگابایت مصرف شده). جهت تمدید یا خرید حجم اضافه از طریق ربات تلگرام اقدام فرمایید. بخش‌های وب‌گردی و دانلود همچنان به صورت نامحدود در دسترس شما هستند.")]
    StaticIpQuotaExceeded { used_mb: i64, limit_mb: i64 },

    #[error("دسترسی به حالت {mode} مختص کاربران اشتراک ویژه است. لطفا اشتراک خود را ارتقا دهید.")]
    ModeLocked { mode: String },

    #[error("حالت {mode} در حال حاضر غیرفعال است و به‌زودی اضافه می‌شود.")]
    ModeComingSoon { mode: String },

    #[error("حساب شما به دلیل الگوی مصرف ترافیک غیرعادی موقتاً متوقف شده است. لطفاً با پشتیبانی در ارتباط باشید.")]
    AccountSuspended(String),

    #[error("سقف مجاز تعداد دستگاه‌های متصل (حداکثر {max} دستگاه) تکمیل شده است. لطفاً برای اتصال دستگاه جدید، یکی از دستگاه‌های قبلی را حذف نمایید.")]
    MaxDevicesReached { max: i64 },

    #[error("User is banned: {0}")]
    UserBanned(String),

    #[error("Device limit reached: maximum {0} devices allowed")]
    DeviceLimitExceeded(i64),

    #[error("Internal server error: {0}")]
    Internal(String),

    #[error("Invalid request input: {0}")]
    BadRequest(String),

    #[error("Too many requests: {0}")]
    TooManyRequests(String),

    #[error("Proxy initialization error: {0}")]
    ProxyError(String),

    #[error("{0}")]
    StaticIpPreparing(String),
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
            CoreError::DailyQuotaExceeded { mode, used_mb, limit_mb } => (
                StatusCode::PAYMENT_REQUIRED,
                "DAILY_QUOTA_EXCEEDED",
                format!(
                    "سقف حجم روزانه شما برای حالت [{}] به اتمام رسیده است ({} از {} مگابایت مصرف شده). سهمیه روزانه شما هر ۲۴ ساعت مجدداً فعال می‌شود.",
                    mode, used_mb, limit_mb
                ),
            ),
            CoreError::StaticIpQuotaExceeded { used_mb, limit_mb } => (
                StatusCode::PAYMENT_REQUIRED,
                "STATIC_IP_QUOTA_EXCEEDED",
                format!(
                    "سقف سهمیه ۳۰ گیگابایت ماهانه آی‌پی ثابت اختصاصی شما به اتمام رسیده است ({} از {} مگابایت مصرف شده). دسترسی به آی‌پی ثابت موقتاً متوقف شد؛ اما وب‌گردی و دانلود شما همچنان به صورت کاملاً نامحدود فعال است. جهت شارژ مجدد آی‌پی ثابت از ربات تلگرام اقدام فرمایید.",
                    used_mb, limit_mb
                ),
            ),
            CoreError::ModeLocked { mode } => (
                StatusCode::FORBIDDEN,
                "MODE_LOCKED",
                format!(
                    "دسترسی به حالت [{}] مختص کاربران اشتراک ویژه (Pro و Flow+) است. جهت استفاده از آی‌پی ثابت تمیز و بدون خطای ترید و جمنای، اشتراک خود را ارتقا دهید.",
                    mode
                ),
            ),
            CoreError::ModeComingSoon { mode } => (
                StatusCode::BAD_REQUEST,
                "MODE_COMING_SOON",
                format!("حالت [{}] هنوز در دسترس نیست و به‌زودی به پلتفرم سنترا اضافه می‌شود.", mode),
            ),
            CoreError::StaticIpPreparing(msg) => (
                StatusCode::SERVICE_UNAVAILABLE,
                "STATIC_IP_PREPARING",
                msg.clone(),
            ),
            CoreError::AccountSuspended(msg) => (
                StatusCode::FORBIDDEN,
                "ACCOUNT_SUSPENDED",
                msg.clone(),
            ),
            CoreError::MaxDevicesReached { max } => (
                StatusCode::FORBIDDEN,
                "MAX_DEVICES_REACHED",
                format!(
                    "سقف مجاز تعداد دستگاه‌های متصل (حداکثر {} دستگاه) تکمیل شده است. لطفاً برای اتصال دستگاه جدید، یکی از دستگاه‌های قبلی را از تنظیمات اپلیکیشن یا ربات تلگرام حذف نمایید.",
                    max
                ),
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
            CoreError::TooManyRequests(msg) => (
                StatusCode::TOO_MANY_REQUESTS,
                "TOO_MANY_REQUESTS",
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
