use teloxide::prelude::*;
use teloxide::types::ParseMode;

use crate::bot::admin_handlers;
use crate::bot::keyboards::{
    cancel_inline_keyboard, password_reset_alert_keyboard, password_reset_inline_keyboard,
    user_main_keyboard_with_admin,
};
use crate::bot::user_handlers::{clear_user_state, set_user_state, UserState};
use crate::db::{DbPool, Repository};

pub async fn handle_password_reset_menu(
    bot: &Bot,
    msg: &Message,
    pool: &DbPool,
    _admin_chat_id: i64,
) -> anyhow::Result<()> {
    let telegram_user_id = match msg.from.as_ref() {
        Some(u) => u.id.0 as i64,
        None => return Ok(()),
    };

    let user_opt = Repository::get_user_by_telegram_id(pool, telegram_user_id).await?;

    let text = match user_opt {
        Some(user) => {
            let account_identifier = user
                .email
                .as_deref()
                .or(user.username.as_deref())
                .unwrap_or("حساب تلگرام");
            let verify_status = if user.telegram_verified != 0 {
                "🟢 تایید شده"
            } else {
                "🔒 تایید نشده"
            };

            format!(
                "🔑 <b>مدیریت و بازیابی رمز عبور Sentra</b>\n\n\
                👤 حساب متصل: <code>{}</code>\n\
                🛡 وضعیت تایید: <b>{}</b>\n\n\
                جهت بازیابی رمز عبور برای ورود به نرم‌افزار، یکی از گزینه‌های زیر را انتخاب نمایید:",
                account_identifier, verify_status
            )
        }
        None => {
            "🔑 <b>مدیریت و بازیابی رمز عبور Sentra</b>\n\n\
            حساب کاربری متصلی برای این شناسه تلگرام یافت نشد. اگر در نرم‌افزار ثبت‌نام نموده‌اید، لطفاً از بخش تنظیمات نرم‌افزار نسبت به تایید حساب در تلگرام اقدام فرمایید."
                .to_string()
        }
    };

    bot.send_message(msg.chat.id, text)
        .parse_mode(ParseMode::Html)
        .reply_markup(password_reset_inline_keyboard())
        .await?;

    Ok(())
}

pub async fn handle_password_reset_get_code_callback(
    bot: &Bot,
    q: &CallbackQuery,
    pool: &DbPool,
) -> anyhow::Result<()> {
    let telegram_user_id = q.from.id.0 as i64;
    let user_opt = Repository::get_user_by_telegram_id(pool, telegram_user_id).await?;

    let user = match user_opt {
        Some(u) => u,
        None => {
            bot.answer_callback_query(q.id.clone())
                .text("⚠️ ابتدا باید در ربات /start را بزنید یا حساب خود را تایید نمایید.")
                .show_alert(true)
                .await?;
            return Ok(());
        }
    };

    match Repository::create_password_reset_code(pool, user.id).await {
        Ok(code) => {
            bot.answer_callback_query(q.id.clone())
                .text("کد ۶ رقمی صادر گردید.")
                .await?;

            let text = format!(
                "🔢 <b>کد بازیابی ۶ رقمی شما (ویژه نرم‌افزار):</b>\n\n\
                <code>{}</code>\n\n\
                ⏳ این کد به مدت <b>۱۰ دقیقه</b> معتبر است و می‌توانید آن را در صفحه بازیابی رمز عبور Sentra Connect وارد نمایید.\n\n\
                ⚠️ <i>اگر این درخواست را شما ثبت نکرده‌اید، سریعاً دکمه زیر را لمس نمایید:</i>",
                code
            );

            if let Some(msg) = &q.message {
                bot.send_message(msg.chat().id, text)
                    .parse_mode(ParseMode::Html)
                    .reply_markup(password_reset_alert_keyboard())
                    .await?;
            }
        }
        Err(e) => {
            let err_msg = match e {
                crate::error::CoreError::TooManyRequests(msg) => msg,
                _ => "خطا در تولید کد بازیابی. لطفاً دقایقی دیگر مجدداً تلاش فرمایید.".to_string(),
            };
            bot.answer_callback_query(q.id.clone())
                .text(err_msg)
                .show_alert(true)
                .await?;
        }
    }

    Ok(())
}

pub async fn handle_password_reset_set_direct_callback(
    bot: &Bot,
    q: &CallbackQuery,
    pool: &DbPool,
) -> anyhow::Result<()> {
    let telegram_user_id = q.from.id.0 as i64;
    let user_opt = Repository::get_user_by_telegram_id(pool, telegram_user_id).await?;

    if user_opt.is_none() {
        bot.answer_callback_query(q.id.clone())
            .text("⚠️ حسابی برای این تلگرام یافت نشد.")
            .show_alert(true)
            .await?;
        return Ok(());
    }

    set_user_state(telegram_user_id, UserState::AwaitingNewPasswordReset).await;

    bot.answer_callback_query(q.id.clone()).await?;

    let text = "🔐 <b>تنظیم مستقیم رمز عبور جدید</b>\n\n\
        لطفاً رمز عبور جدید خود را در پاسخ به این پیام ارسال فرمایید.\n\n\
        📌 <b>شرایط رمز عبور:</b>\n\
        • طول رمز باید بین ۸ تا ۱۲۸ کاراکتر باشد.\n\
        • پیام ارسالی حاوی رمز عبور بلافاصله پس از دریافت جهت حفظ امنیت حذف خواهد شد.";

    if let Some(msg) = &q.message {
        bot.send_message(msg.chat().id, text)
            .parse_mode(ParseMode::Html)
            .reply_markup(cancel_inline_keyboard())
            .await?;
    }

    Ok(())
}

pub async fn handle_new_password_reset_input(
    bot: &Bot,
    msg: &Message,
    pool: &DbPool,
    admin_chat_id: i64,
    new_password: &str,
) -> anyhow::Result<()> {
    // Immediately delete the user's message containing the password
    let _ = bot.delete_message(msg.chat.id, msg.id).await;

    let telegram_user_id = msg.from.as_ref().map(|u| u.id.0 as i64).unwrap_or(0);
    let is_admin = admin_handlers::is_authorized_admin(telegram_user_id, admin_chat_id);

    clear_user_state(telegram_user_id).await;

    let clean_password = new_password.trim();
    if clean_password.len() < 8 || clean_password.len() > 128 {
        bot.send_message(
            msg.chat.id,
            "❌ <b>خطا:</b> طول رمز عبور باید بین ۸ تا ۱۲۸ کاراکتر باشد. عملیات لغو گردید.",
        )
        .parse_mode(ParseMode::Html)
        .reply_markup(user_main_keyboard_with_admin(is_admin))
        .await?;
        return Ok(());
    }

    match Repository::update_user_password_by_telegram_id(pool, telegram_user_id, clean_password).await {
        Ok(_) => {
            bot.send_message(
                msg.chat.id,
                "✅ <b>رمز عبور جدید با موفقیت ذخیره شد!</b>\n\nهم‌اکنون می‌توانید با رمز عبور جدید در نرم‌افزار Sentra Connect وارد شوید.",
            )
            .parse_mode(ParseMode::Html)
            .reply_markup(user_main_keyboard_with_admin(is_admin))
            .await?;
        }
        Err(e) => {
            bot.send_message(
                msg.chat.id,
                format!("❌ <b>خطا در تنظیم رمز عبور:</b> {}", e),
            )
            .parse_mode(ParseMode::Html)
            .reply_markup(user_main_keyboard_with_admin(is_admin))
            .await?;
        }
    }

    Ok(())
}

pub async fn handle_password_reset_cancel_callback(
    bot: &Bot,
    q: &CallbackQuery,
    pool: &DbPool,
) -> anyhow::Result<()> {
    let telegram_user_id = q.from.id.0 as i64;
    clear_user_state(telegram_user_id).await;

    let _ = Repository::invalidate_password_resets_by_telegram_id(pool, telegram_user_id).await;

    bot.answer_callback_query(q.id.clone())
        .text("تمام کدهای بازیابی باطل شدند.")
        .await?;

    if let Some(msg) = &q.message {
        bot.send_message(
            msg.chat().id,
            "🚫 <b>تمام کدهای فعال بازیابی رمز عبور با موفقیت ابطال گردیدند.</b>\n\nاگر درخواست توسط شما نبوده، هیچ کدی برای دسترسی به حساب شما فعال نیست و امنیت حساب شما برقرار است.",
        )
        .parse_mode(ParseMode::Html)
        .await?;
    }

    Ok(())
}
