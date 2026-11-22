use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use teloxide::payloads::SendMessageSetters;
use teloxide::requests::Requester;

use crate::api::{extract_client_ip, AppState};
use crate::db::Repository;
use crate::error::CoreError;

#[derive(Debug, Deserialize, Serialize)]
pub struct PasswordResetRequestPayload {
    pub email: Option<String>,
    pub username: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct PasswordResetConfirmPayload {
    pub email: Option<String>,
    pub username: Option<String>,
    pub code: String,
    pub new_password: String,
}

pub(super) async fn auth_password_reset_request(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<PasswordResetRequestPayload>,
) -> Result<Response, CoreError> {
    let client_ip = extract_client_ip(&headers);
    state.rate_limiter.check_ip(&client_ip).await?;

    let identifier = payload
        .email
        .as_deref()
        .or(payload.username.as_deref())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty());

    let identifier = match identifier {
        Some(id) => id,
        None => {
            state.rate_limiter.record_failure(&client_ip).await;
            return Err(CoreError::BadRequest(
                "لطفاً ایمیل یا نام کاربری خود را وارد فرمایید.".to_string(),
            ));
        }
    };

    let user_opt = Repository::find_user_for_password_reset(&state.pool, identifier).await?;

    // Return generic 200 OK without leaking account existence or status if not found / suspended / banned
    let user = match user_opt {
        Some(u) if u.status != "suspended" && u.status != "banned" => u,
        _ => {
            state.rate_limiter.record_success(&client_ip).await;
            return Ok((
                StatusCode::OK,
                Json(json!({
                    "success": true,
                    "delivery": "telegram",
                    "expires_in_seconds": 600
                })),
            )
                .into_response());
        }
    };

    // Verify telegram_id is linked (return BadRequest in Persian if not linked)
    let telegram_id = match user.telegram_id {
        Some(tid) if tid > 0 => tid,
        _ => {
            state.rate_limiter.record_failure(&client_ip).await;
            return Err(CoreError::BadRequest(
                "حساب کاربری شما هنوز به ربات تلگرام متصل نشده است. لطفاً ابتدا در اپلیکیشن از بخش «تایید حساب در ربات تلگرام» حساب خود را متصل فرمایید یا با پشتیبانی در ارتباط باشید.".to_string(),
            ));
        }
    };

    let code = Repository::create_password_reset_code(&state.pool, user.id).await?;

    if let Some(ref bot) = state.bot {
        let display_name = user.email.as_deref().unwrap_or(&user.first_name);
        let text = format!(
            "🔐 <b>درخواست بازیابی رمز عبور در اپلیکیشن Sentra</b>\n\n\
            درود <b>{}</b> گرامی،\n\
            کد تایید یک‌بار مصرف شما جهت بازنشانی رمز عبور:\n\n\
            🔢 <code>{}</code>\n\n\
            ⏳ این کد به مدت <b>۱۰ دقیقه</b> معتبر است.\n\n\
            ⚠️ <i>اگر این درخواست توسط شما ارسال نشده است، لطفاً بلافاصله روی دکمه زیر کلیک نمایید تا این کد باطل شود:</i>",
            display_name, code
        );

        let send_res = bot
            .send_message(teloxide::types::ChatId(telegram_id), text)
            .parse_mode(teloxide::types::ParseMode::Html)
            .reply_markup(crate::bot::keyboards::password_reset_alert_keyboard())
            .await;

        if let Err(e) = send_res {
            tracing::error!(
                "Failed to send Telegram password reset code to user {}: {:?}",
                telegram_id,
                e
            );
            // Invalidate code if Telegram send fails
            let _ = Repository::invalidate_password_resets_by_telegram_id(&state.pool, telegram_id).await;
            state.rate_limiter.record_failure(&client_ip).await;
            return Err(CoreError::Internal(
                "ارسال پیام به ربات تلگرام با خطا مواجه شد. لطفاً بررسی فرمایید که ربات را مسدود نکرده باشید و مجدداً تلاش نمایید.".to_string(),
            ));
        }
    } else {
        tracing::error!("Telegram bot client not available in AppState for password reset");
        let _ = Repository::invalidate_password_resets_by_telegram_id(&state.pool, telegram_id).await;
        state.rate_limiter.record_failure(&client_ip).await;
        return Err(CoreError::Internal(
            "سیستم اطلاع‌رسانی تلگرام در دسترس نیست.".to_string(),
        ));
    }

    state.rate_limiter.record_success(&client_ip).await;

    Ok((
        StatusCode::OK,
        Json(json!({
            "success": true,
            "delivery": "telegram",
            "expires_in_seconds": 600
        })),
    )
        .into_response())
}

pub(super) async fn auth_password_reset_confirm(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<PasswordResetConfirmPayload>,
) -> Result<Response, CoreError> {
    let client_ip = extract_client_ip(&headers);
    state.rate_limiter.check_ip(&client_ip).await?;

    let identifier = payload
        .email
        .as_deref()
        .or(payload.username.as_deref())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            CoreError::BadRequest("لطفاً ایمیل یا نام کاربری را وارد نمایید.".to_string())
        })?;

    let user = match Repository::confirm_password_reset(
        &state.pool,
        identifier,
        &payload.code,
        &payload.new_password,
    )
    .await
    {
        Ok(u) => {
            state.rate_limiter.record_success(&client_ip).await;
            u
        }
        Err(e) => {
            state.rate_limiter.record_failure(&client_ip).await;
            return Err(e);
        }
    };

    // Send HTML confirmation message to user's Telegram if linked
    if let (Some(ref bot), Some(tid)) = (&state.bot, user.telegram_id) {
        if tid > 0 {
            let msg = "✅ <b>رمز عبور حساب کاربری شما با موفقیت تغییر یافت.</b>\n\n\
                رمز عبور جدید برای حساب کاربری سنترا شما ثبت شد.\n\
                اگر این اقدام توسط شما انجام نشده است، لطفاً بلافاصله به پشتیبانی پیام دهید.";
            let _ = bot
                .send_message(teloxide::types::ChatId(tid), msg)
                .parse_mode(teloxide::types::ParseMode::Html)
                .await;
        }
    }

    Ok((
        StatusCode::OK,
        Json(json!({
            "success": true,
            "message": "رمز عبور با موفقیت تغییر یافت."
        })),
    )
        .into_response())
}
