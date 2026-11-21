pub mod admin_handlers;
pub mod keyboards;
pub mod rate_limiter;
pub mod user_handlers;

use crate::db::DbPool;
use std::sync::Arc;
use teloxide::prelude::*;
use teloxide::types::ParseMode;
use tracing::{error, info, warn};

pub async fn run_telegram_bot(
    token_opt: Option<String>,
    proxy_opt: Option<String>,
    pool: DbPool,
    admin_chat_id: i64,
    base_url: String,
    pro_subscription_price: i64,
) {
    let token = match token_opt {
        Some(t) if !t.trim().is_empty() && !t.contains("SAMPLE") => t,
        _ => {
            warn!("⚠️ TELOXIDE_TOKEN is not configured or is a placeholder. Telegram Bot long-polling daemon skipped, Axum REST API active.");
            return;
        }
    };

    // Initialize bot client with optional proxy (TELOXIDE_PROXY)
    let bot = if let Some(ref proxy_url) = proxy_opt {
        info!("Connecting Telegram Bot through proxy: {}", proxy_url);
        match reqwest::Proxy::all(proxy_url) {
            Ok(proxy) => {
                match teloxide::net::default_reqwest_settings().proxy(proxy).build() {
                    Ok(client) => Bot::with_client(token, client),
                    Err(e) => {
                        error!("Failed to build reqwest client with proxy: {}. Falling back to direct connection.", e);
                        Bot::new(token)
                    }
                }
            }
            Err(e) => {
                error!("Invalid proxy URL format ({}): {}. Falling back to direct.", proxy_url, e);
                Bot::new(token)
            }
        }
    } else {
        Bot::new(token)
    };

    info!("Starting Sentra Telegram Bot in parallel Long Polling mode...");

    let pool = Arc::new(pool);
    let base_url = Arc::new(base_url);
    let rate_limiter = Arc::new(rate_limiter::BotRateLimiter::new());

    let handler = dptree::entry()
        .branch(
            Update::filter_message().endpoint({
                let pool = Arc::clone(&pool);
                let base_url = Arc::clone(&base_url);
                let rate_limiter = Arc::clone(&rate_limiter);
                move |bot: Bot, msg: Message| {
                    let pool = Arc::clone(&pool);
                    let base_url = Arc::clone(&base_url);
                    let rate_limiter = Arc::clone(&rate_limiter);
                    async move {
                        // Anti-spam / Flood Protection (> 5 reqs in < 10s -> 5m Cooldown)
                        let telegram_user_id = msg.from.as_ref().map(|u| u.id.0 as i64).unwrap_or(0);
                        if telegram_user_id != 0 {
                            match rate_limiter.check(telegram_user_id).await {
                                rate_limiter::RateLimitVerdict::BlockAndWarn => {
                                    let _ = bot.send_message(
                                        msg.chat.id,
                                        "⛔ به دلیل ارسال درخواست‌های پی‌درپی، دسترسی شما به ربات به مدت ۵ دقیقه محدود شد.",
                                    )
                                    .await;
                                    return respond(());
                                }
                                rate_limiter::RateLimitVerdict::SilentDrop => {
                                    return respond(());
                                }
                                rate_limiter::RateLimitVerdict::Allowed => {}
                            }
                        }

                        // 1. Check if user sent a Photo (e.g. manual payment receipt or broadcast with photo)
                        if let Some(photos) = msg.photo() {
                            if !photos.is_empty() {
                                // If admin sending a photo with caption starting with /broadcast
                                if admin_handlers::is_authorized_admin(telegram_user_id, admin_chat_id) {
                                    if let Some(caption) = msg.caption() {
                                        if let Some(stripped) = caption.strip_prefix("/broadcast ") {
                                            let broadcast_text = stripped.trim();
                                            let best_photo = &photos[photos.len() - 1];
                                            if let Err(e) = admin_handlers::handle_admin_broadcast(
                                                &bot,
                                                &msg,
                                                &pool,
                                                admin_chat_id,
                                                broadcast_text,
                                                Some(best_photo.file.id.clone()),
                                            )
                                            .await
                                            {
                                                error!("Error in broadcast with photo: {:?}", e);
                                            }
                                            return respond(());
                                        }
                                    }
                                }

                                // Regular user or payment / donation receipt submission
                                if let Err(e) = admin_handlers::handle_receipt_submission(&bot, &msg, &pool, admin_chat_id, pro_subscription_price).await {
                                    error!("Error in handle_receipt_submission: {:?}", e);
                                }
                                return respond(());
                            }
                        }

                        // 1.5. Check if user sent a Document (e.g. app release upload by admin)
                        if let Some(doc) = msg.document() {
                            if admin_handlers::is_authorized_admin(telegram_user_id, admin_chat_id) {
                                if let Some(upload_state) = admin_handlers::get_admin_upload_state(telegram_user_id).await {
                                    match upload_state {
                                        admin_handlers::AdminUploadState::AwaitingFile { platform, version, changelog } => {
                                            if let Err(e) = admin_handlers::handle_admin_file_upload(
                                                &bot,
                                                &msg,
                                                &pool,
                                                admin_chat_id,
                                                doc,
                                                &platform,
                                                &version,
                                                &changelog,
                                            )
                                            .await
                                            {
                                                error!("Error in handle_admin_file_upload: {:?}", e);
                                            }
                                            return respond(());
                                        }
                                        admin_handlers::AdminUploadState::AwaitingVersionAndChangelog { .. } => {
                                            let _ = bot.send_message(
                                                msg.chat.id,
                                                "⚠️ لطفاً ابتدا شماره نسخه و توضیح کوتاه تغییرات را به صورت متن بفرستید، سپس فایل را ارسال نمایید (یا /cancel را ارسال کنید).",
                                            ).await;
                                            return respond(());
                                        }
                                    }
                                }
                            }
                        }

                        // 2. Text Message Routing
                        if let Some(text) = msg.text() {
                            let text = text.trim();

                            // Check active admin state for app release version input
                            if admin_handlers::is_authorized_admin(telegram_user_id, admin_chat_id) {
                                if let Some(upload_state) = admin_handlers::get_admin_upload_state(telegram_user_id).await {
                                    match upload_state {
                                        admin_handlers::AdminUploadState::AwaitingVersionAndChangelog { platform } => {
                                            if let Err(e) = admin_handlers::handle_admin_version_text(&bot, &msg, admin_chat_id, &platform, text).await {
                                                error!("Error in handle_admin_version_text: {:?}", e);
                                            }
                                            return respond(());
                                        }
                                        admin_handlers::AdminUploadState::AwaitingFile { .. } => {
                                            if text == "/cancel" {
                                                admin_handlers::clear_admin_upload_state(telegram_user_id).await;
                                                let _ = bot.send_message(msg.chat.id, "❌ فرآیند آپلود فایل لغو شد.").await;
                                                return respond(());
                                            } else {
                                                let _ = bot.send_message(
                                                    msg.chat.id,
                                                    "⚠️ لطفاً فایل نصبی را به صورت Document در چت بفرستید (یا جهت انصراف /cancel را ارسال نمایید).",
                                                ).await;
                                                return respond(());
                                            }
                                        }
                                    }
                                }

                                // Check active admin state for official outbound input (label + link/json)
                                if let Some(outbound_state) = admin_handlers::get_admin_outbound_state(telegram_user_id).await {
                                    match outbound_state {
                                        admin_handlers::AdminOutboundState::AwaitingOutboundInput { category } => {
                                            if let Err(e) = admin_handlers::handle_admin_outbound_text_input(
                                                &bot,
                                                &msg,
                                                &pool,
                                                admin_chat_id,
                                                &category,
                                                text,
                                            )
                                            .await
                                            {
                                                error!("Error handling admin outbound text input: {:?}", e);
                                            }
                                            return respond(());
                                        }
                                    }
                                }
                            }
                            if text == "/start" {
                                if let Err(e) = user_handlers::handle_start(&bot, &msg, &pool, admin_chat_id).await {
                                    error!("Error in /start: {:?}", e);
                                }
                            } else if text == "📥 دانلود اپلیکیشن Sentra Connect" {
                                if let Err(e) = user_handlers::handle_download_app_menu(&bot, &msg).await {
                                    error!("Error in handle_download_app_menu: {:?}", e);
                                }
                            } else if text == "📤 آپلود / بروزرسانی اپلیکیشن" {
                                if let Err(e) = admin_handlers::handle_app_upload_menu_msg(&bot, &msg, admin_chat_id).await {
                                    error!("Error in handle_app_upload_menu_msg: {:?}", e);
                                }
                            } else if text == "🌐 مدیریت اوتباندها و نودها" {
                                if let Err(e) = admin_handlers::handle_official_outbounds_hub(&bot, msg.chat.id, &pool, admin_chat_id, telegram_user_id).await {
                                    error!("Error in handle_official_outbounds_hub: {:?}", e);
                                }
                            } else if text == "🎁 دریافت اشتراک رایگان (Sentra Lite)" {
                                if let Err(e) = user_handlers::handle_free_account(&bot, &msg, &pool).await {
                                    error!("Error in handle_free_account: {:?}", e);
                                }
                            } else if text == "⚡ ارتقا به پلن ویژه (Sentra Pro / Flow+)" {
                                if let Err(e) = user_handlers::handle_upgrade_prompt(&bot, &msg).await {
                                    error!("Error in handle_upgrade_prompt: {:?}", e);
                                }
                            } else if text == "🔑 دریافت کانفیگ و کد اتصال" {
                                if let Err(e) = user_handlers::handle_get_config_and_links(&bot, &msg, &pool, &base_url).await {
                                    error!("Error in handle_get_config_and_links: {:?}", e);
                                }
                            } else if text == "🍏 دریافت اشتراک iOS (OpenVPN)" {
                                if let Err(e) = user_handlers::handle_ios_subscription_prompt(&bot, &msg, &pool).await {
                                    error!("Error in handle_ios_subscription_prompt: {:?}", e);
                                }
                            } else if text == "🤝 اهدای اوتباند (حمایت از Sentra)" {
                                if let Err(e) = user_handlers::handle_donation_prompt(&bot, &msg).await {
                                    error!("Error in handle_donation_prompt: {:?}", e);
                                }
                            } else if text == "💖 حمایت مالی از توسعه Sentra" {
                                if let Err(e) = user_handlers::handle_financial_donation_prompt(&bot, &msg, pro_subscription_price).await {
                                    error!("Error in handle_financial_donation_prompt: {:?}", e);
                                }
                            } else if text == "🔗 اتصال حساب اپلیکیشن" {
                                if let Err(e) = user_handlers::handle_link_account_prompt(&bot, &msg, &pool).await {
                                    error!("Error in handle_link_account_prompt: {:?}", e);
                                }
                            } else if text == "/link" || text.starts_with("/link ") {
                                let args = if text.len() > 5 { &text[5..] } else { "" };
                                if let Err(e) = user_handlers::handle_link_command(&bot, &msg, &pool, args).await {
                                    error!("Error in handle_link_command: {:?}", e);
                                }
                            } else if let Some(stripped) = text.strip_prefix("/setpassword ") {
                                let args = stripped.trim();
                                if let Err(e) = user_handlers::handle_setpassword_command(&bot, &msg, &pool, args).await {
                                    error!("Error in handle_setpassword_command: {:?}", e);
                                }
                            } else if text.starts_with("vless://")
                                || text.starts_with("vmess://")
                                || text.starts_with("trojan://")
                                || text.starts_with("hy2://")
                                || text.starts_with("hysteria2://")
                                || text.starts_with("tuic://")
                                || text.starts_with("ss://")
                                || (text.starts_with('{') && text.contains("\"server\""))
                            {
                                if let Err(e) = user_handlers::handle_donation_submission(&bot, &msg, &pool, text).await {
                                    error!("Error in handle_donation_submission: {:?}", e);
                                }
                            } else if text == "📊 وضعیت اشتراک و تیکت پشتیبانی" {
                                if let Err(e) = user_handlers::handle_subscription_status(&bot, &msg, &pool).await {
                                    error!("Error in handle_subscription_status: {:?}", e);
                                }
                            } else if text == "/admin" || text == "🛠 پنل مدیریت" || text == "🛡 مدیریت سنترا (پنل ادمین)" {
                                if let Err(e) = admin_handlers::handle_admin_panel(&bot, &msg, &pool, admin_chat_id).await {
                                    error!("Error in /admin: {:?}", e);
                                }
                            } else if text.starts_with("/user ") || text.starts_with("/search ") {
                                let query = if let Some(stripped) = text.strip_prefix("/user ") {
                                    stripped.trim()
                                } else {
                                    text.strip_prefix("/search ").unwrap_or_default().trim()
                                };
                                if let Err(e) = admin_handlers::handle_admin_search_user(&bot, &msg, &pool, admin_chat_id, query).await {
                                    error!("Error in handle_admin_search_user: {:?}", e);
                                }
                            } else if let Some(stripped) = text.strip_prefix("/broadcast ") {
                                let broadcast_text = stripped.trim();
                                if let Err(e) = admin_handlers::handle_admin_broadcast(&bot, &msg, &pool, admin_chat_id, broadcast_text, None).await {
                                    error!("Error in handle_admin_broadcast: {:?}", e);
                                }
                            } else if text == "🔄 وضعیت نودهای خروجی شبکه" {
                                if let Err(e) = admin_handlers::handle_outbounds_menu(&bot, msg.chat.id, &pool, admin_chat_id, telegram_user_id).await {
                                    error!("Error in handle_outbounds_menu: {:?}", e);
                                }
                            } else if text == "🩺 تست سلامت ۶ لایه سیستم" || text == "/health" {
                                if let Err(e) = admin_handlers::handle_six_layer_health_test(&bot, msg.chat.id, &pool, admin_chat_id, telegram_user_id).await {
                                    error!("Error in handle_six_layer_health_test: {:?}", e);
                                }
                            } else if text == "👤 بازگشت به منوی کاربری" {
                                if let Err(e) = admin_handlers::handle_return_to_user_menu(&bot, &msg).await {
                                    error!("Error in handle_return_to_user_menu: {:?}", e);
                                }
                            } else {
                                let _ = bot.send_message(
                                    msg.chat.id,
                                    "💡 لطفاً یکی از گزینه‌های منوی زیر را لمس نمایید یا /start را بفرستید.",
                                )
                                .reply_markup(keyboards::user_main_keyboard_with_admin(admin_handlers::is_authorized_admin(telegram_user_id, admin_chat_id)))
                                .await;
                            }
                        }
                        respond(())
                    }
                }
            }),
        )
        .branch(
            Update::filter_callback_query().endpoint({
                let pool = Arc::clone(&pool);
                let base_url = Arc::clone(&base_url);
                let rate_limiter = Arc::clone(&rate_limiter);
                move |bot: Bot, q: CallbackQuery| {
                    let pool = Arc::clone(&pool);
                    let base_url = Arc::clone(&base_url);
                    let rate_limiter = Arc::clone(&rate_limiter);
                    async move {
                        // Anti-spam / Flood Protection for Callback Queries
                        let telegram_user_id = q.from.id.0 as i64;
                        match rate_limiter.check(telegram_user_id).await {
                            rate_limiter::RateLimitVerdict::BlockAndWarn => {
                                let _ = bot
                                    .answer_callback_query(q.id.clone())
                                    .text("⛔ به دلیل ارسال درخواست‌های پی‌درپی، دسترسی شما به ربات به مدت ۵ دقیقه محدود شد.")
                                    .show_alert(true)
                                    .await;
                                return respond(());
                            }
                            rate_limiter::RateLimitVerdict::SilentDrop => {
                                return respond(());
                            }
                            rate_limiter::RateLimitVerdict::Allowed => {}
                        }

                        if let Some(ref data) = q.data {
                            // User Device Management Callbacks
                            if data == "manage_devices" || data == "back_to_status" {
                                if let Err(e) = user_handlers::handle_manage_devices_callback(&bot, &q, &pool).await {
                                    error!("Error in handle_manage_devices_callback: {:?}", e);
                                }
                            } else if let Some(dev_id) = data.strip_prefix("del_dev_") {
                                if let Err(e) = user_handlers::handle_delete_device_callback(&bot, &q, &pool, dev_id).await {
                                    error!("Error in handle_delete_device_callback: {:?}", e);
                                }
                            }
                            // Admin Dashboard Actions
                            else if data == "adm_action_stats" {
                                if let Err(e) = admin_handlers::handle_realtime_stats_callback(&bot, &q, &pool, admin_chat_id).await {
                                    error!("Error in adm_action_stats: {:?}", e);
                                }
                            } else if data == "adm_action_official_outbounds" {
                                if let Err(e) = admin_handlers::handle_official_outbounds_hub_callback(&bot, &q, &pool, admin_chat_id).await {
                                    error!("Error in adm_action_official_outbounds: {:?}", e);
                                }
                            } else if data == "adm_ob_add_start" {
                                if let Err(e) = admin_handlers::handle_start_add_official_outbound(&bot, &q, admin_chat_id).await {
                                    error!("Error in adm_ob_add_start: {:?}", e);
                                }
                            } else if let Some(cat) = data.strip_prefix("adm_ob_target_") {
                                if let Err(e) = admin_handlers::handle_target_category_chosen(&bot, &q, admin_chat_id, cat).await {
                                    error!("Error in adm_ob_target: {:?}", e);
                                }
                            } else if let Some(alloc) = data.strip_prefix("adm_ob_alloc_") {
                                if let Err(e) = admin_handlers::handle_target_category_chosen(&bot, &q, admin_chat_id, alloc).await {
                                    error!("Error in adm_ob_alloc: {:?}", e);
                                }
                            } else if let Some(id_str) = data.strip_prefix("adm_ob_realloc_") {
                                if let Ok(ob_id) = id_str.parse::<i64>() {
                                    if let Err(e) = admin_handlers::handle_realloc_official_outbound_menu_callback(&bot, &q, admin_chat_id, ob_id).await {
                                        error!("Error in adm_ob_realloc: {:?}", e);
                                    }
                                }
                            } else if let Some(rest) = data.strip_prefix("adm_set_alloc_") {
                                // format: {outbound_id}_{mode}
                                if let Some(idx) = rest.find('_') {
                                    let id_part = &rest[..idx];
                                    let mode_part = &rest[idx + 1..];
                                    if let Ok(ob_id) = id_part.parse::<i64>() {
                                        if let Err(e) = admin_handlers::handle_set_outbound_allocation_callback(&bot, &q, &pool, admin_chat_id, ob_id, mode_part).await {
                                            error!("Error in adm_set_alloc: {:?}", e);
                                        }
                                    }
                                }
                            } else if let Some(id_str) = data.strip_prefix("adm_ob_gemini_") {
                                if let Ok(ob_id) = id_str.parse::<i64>() {
                                    if let Err(e) = admin_handlers::handle_test_gemini_outbound_callback(&bot, &q, &pool, admin_chat_id, ob_id).await {
                                        error!("Error in adm_ob_gemini: {:?}", e);
                                    }
                                }
                            } else if let Some(cat) = data.strip_prefix("adm_ob_list_") {
                                if let Err(e) = admin_handlers::handle_list_official_outbounds(&bot, &q, &pool, admin_chat_id, cat).await {
                                    error!("Error in adm_ob_list: {:?}", e);
                                }
                            } else if let Some(id_str) = data.strip_prefix("adm_ob_ping_") {
                                if let Ok(ob_id) = id_str.parse::<i64>() {
                                    if let Err(e) = admin_handlers::handle_ping_official_outbound_callback(&bot, &q, &pool, admin_chat_id, ob_id).await {
                                        error!("Error in adm_ob_ping: {:?}", e);
                                    }
                                }
                            } else if let Some(id_str) = data.strip_prefix("adm_ob_toggle_") {
                                if let Ok(ob_id) = id_str.parse::<i64>() {
                                    if let Err(e) = admin_handlers::handle_toggle_official_outbound_callback(&bot, &q, &pool, admin_chat_id, ob_id).await {
                                        error!("Error in adm_ob_toggle: {:?}", e);
                                    }
                                }
                            } else if let Some(id_str) = data.strip_prefix("adm_ob_del_") {
                                if let Ok(ob_id) = id_str.parse::<i64>() {
                                    if let Err(e) = admin_handlers::handle_delete_official_outbound_callback(&bot, &q, &pool, admin_chat_id, ob_id).await {
                                        error!("Error in adm_ob_del: {:?}", e);
                                    }
                                }
                            } else if let Some(id_str) = data.strip_prefix("adm_sub_resync_") {
                                if let Ok(source_id) = id_str.parse::<i64>() {
                                    if let Err(e) = admin_handlers::handle_resync_subscription_callback(&bot, &q, &pool, admin_chat_id, source_id).await {
                                        error!("Error in adm_sub_resync: {:?}", e);
                                    }
                                }
                            } else if data == "adm_warp_generate" {
                                if let Err(e) = admin_handlers::handle_generate_warp_callback(&bot, &q, &pool, admin_chat_id).await {
                                    error!("Error in adm_warp_generate: {:?}", e);
                                }
                            } else if data == "adm_action_upload_app" {
                                if let Err(e) = admin_handlers::handle_app_upload_menu_callback(&bot, &q, admin_chat_id).await {
                                    error!("Error in adm_action_upload_app: {:?}", e);
                                }
                            } else if data == "adm_upload_windows" {
                                if let Err(e) = admin_handlers::handle_admin_start_upload(&bot, &q, admin_chat_id, "windows").await {
                                    error!("Error in adm_upload_windows: {:?}", e);
                                }
                            } else if data == "adm_upload_android" {
                                if let Err(e) = admin_handlers::handle_admin_start_upload(&bot, &q, admin_chat_id, "android").await {
                                    error!("Error in adm_upload_android: {:?}", e);
                                }
                            } else if data == "dl_app_windows" {
                                if let Err(e) = user_handlers::handle_download_platform_callback(&bot, &q, &pool, "windows").await {
                                    error!("Error in dl_app_windows: {:?}", e);
                                }
                            } else if data == "dl_app_android" {
                                if let Err(e) = user_handlers::handle_download_platform_callback(&bot, &q, &pool, "android").await {
                                    error!("Error in dl_app_android: {:?}", e);
                                }
                            } else if data == "dl_app_ios" {
                                if let Err(e) = user_handlers::handle_ios_download_callback(&bot, &q, &pool).await {
                                    error!("Error in dl_app_ios: {:?}", e);
                                }
                            } else if data == "adm_action_search" {
                                let prompt = "🔍 <b>جستجو و مدیریت کاربر:</b>\n\nلطفاً شناسه عددی تلگرام، شناسه دیتابیس یا یوزرنیم کاربر را با دستور زیر بفرستید:\n<code>/user &lt;آیدی یا یوزرنیم&gt;</code>\n\n<i>مثال:</i>\n<code>/user 12345678</code> یا <code>/user @username</code>";
                                if let Some(msg) = &q.message {
                                    let _ = bot.send_message(msg.chat().id, prompt).parse_mode(ParseMode::Html).await;
                                }
                                let _ = bot.answer_callback_query(q.id.clone()).await;
                            } else if data == "adm_action_broadcast" {
                                let prompt = "📢 <b>ارسال پیام همگانی (Broadcast):</b>\n\nبرای ارسال پیام متنی به کلیه کاربران سامانه، دستور زیر را بفرستید:\n<code>/broadcast &lt;متن پیام&gt;</code>\n\nبرای ارسال تصویر همراه با متن، عکس مورد نظر را ارسال کرده و در کپشن آن بنویسید:\n<code>/broadcast &lt;متن پیام&gt;</code>";
                                if let Some(msg) = &q.message {
                                    let _ = bot.send_message(msg.chat().id, prompt).parse_mode(ParseMode::Html).await;
                                }
                                let _ = bot.answer_callback_query(q.id.clone()).await;
                            } else if data == "adm_action_outbounds" {
                                if let Some(msg) = &q.message {
                                    let _ = admin_handlers::handle_outbounds_menu(&bot, msg.chat().id, &pool, admin_chat_id, telegram_user_id).await;
                                }
                                let _ = bot.answer_callback_query(q.id.clone()).await;
                            } else if data == "adm_action_health" {
                                if let Some(msg) = &q.message {
                                    let _ = admin_handlers::handle_six_layer_health_test(&bot, msg.chat().id, &pool, admin_chat_id, telegram_user_id).await;
                                }
                                let _ = bot.answer_callback_query(q.id.clone()).await;
                            } else if data == "adm_action_return" {
                                if let Some(msg) = &q.message {
                                    let _ = bot.send_message(msg.chat().id, "👤 به منوی اصلی کاربری سنترا بازگشتید.")
                                        .reply_markup(keyboards::user_main_keyboard_with_admin(true))
                                        .await;
                                }
                                let _ = bot.answer_callback_query(q.id.clone()).await;
                            } else if data == "adm_back_main" {
                                if let Some(msg) = &q.message {
                                    let stats = match crate::db::Repository::get_admin_realtime_stats(&pool).await {
                                        Ok(s) => s,
                                        Err(_) => return respond(()),
                                    };
                                    let text = format!(
                                        r#"🛡 <b>داشبورد مدیریت مرکزی سنترا (Sentra Master Admin)</b>

📊 <b>خلاصه لحظه‌ای وضعیت سیستم:</b>
• کل کاربران ثبت‌شده: <b>{}</b>
• کاربران فعال ویژه (Pro / Flow+): <b>{}</b>
• کاربران مسدودشده (Suspended): <b>{}</b>
• نشست‌ها و دستگاه‌های متصل: <b>{}</b>

جهت دسترسی به هر بخش از دکمه‌های شیشه‌ای زیر استفاده نمایید:"#,
                                        stats.total_users,
                                        stats.premium_users,
                                        stats.suspended_users,
                                        stats.active_sessions
                                    );
                                    let _ = bot.edit_message_text(msg.chat().id, msg.id(), text)
                                        .parse_mode(ParseMode::Html)
                                        .reply_markup(keyboards::admin_dashboard_inline_keyboard())
                                        .await;
                                }
                                let _ = bot.answer_callback_query(q.id.clone()).await;
                            }
                            // User card action callbacks
                            else if let Some(uid_str) = data.strip_prefix("adm_up_pro_") {
                                if let Ok(uid) = uid_str.parse::<i64>() {
                                    if let Err(e) = admin_handlers::handle_admin_upgrade_30_days(&bot, &q, &pool, admin_chat_id, uid, "Sentra Pro").await {
                                        error!("Error in adm_up_pro: {:?}", e);
                                    }
                                }
                            } else if let Some(uid_str) = data.strip_prefix("adm_up_flow_") {
                                if let Ok(uid) = uid_str.parse::<i64>() {
                                    if let Err(e) = admin_handlers::handle_admin_upgrade_30_days(&bot, &q, &pool, admin_chat_id, uid, "Sentra Flow+").await {
                                        error!("Error in adm_up_flow: {:?}", e);
                                    }
                                }
                            } else if let Some(uid_str) = data.strip_prefix("adm_rst_quota_") {
                                if let Ok(uid) = uid_str.parse::<i64>() {
                                    if let Err(e) = admin_handlers::handle_admin_reset_quota(&bot, &q, &pool, admin_chat_id, uid).await {
                                        error!("Error in adm_rst_quota: {:?}", e);
                                    }
                                }
                            } else if let Some(uid_str) = data.strip_prefix("adm_rst_static_") {
                                if let Ok(uid) = uid_str.parse::<i64>() {
                                    if let Err(e) = admin_handlers::handle_admin_reset_static_ip(&bot, &q, &pool, admin_chat_id, uid).await {
                                        error!("Error in adm_rst_static: {:?}", e);
                                    }
                                }
                            } else if let Some(uid_str) = data.strip_prefix("adm_clr_dev_") {
                                if let Ok(uid) = uid_str.parse::<i64>() {
                                    if let Err(e) = admin_handlers::handle_admin_clear_devices(&bot, &q, &pool, admin_chat_id, uid).await {
                                        error!("Error in adm_clr_dev: {:?}", e);
                                    }
                                }
                            } else if let Some(uid_str) = data.strip_prefix("adm_toggle_ban_") {
                                if let Ok(uid) = uid_str.parse::<i64>() {
                                    if let Err(e) = admin_handlers::handle_admin_toggle_block(&bot, &q, &pool, admin_chat_id, uid).await {
                                        error!("Error in adm_toggle_ban: {:?}", e);
                                    }
                                }
                            }
                            // Manual Payment Receipt Callbacks
                            else if let Some(uid_str) = data.strip_prefix("rcpt_approve_pro_") {
                                if let Ok(uid) = uid_str.parse::<i64>() {
                                    if let Err(e) = admin_handlers::handle_receipt_approve(&bot, &q, &pool, admin_chat_id, uid, "Sentra Pro").await {
                                        error!("Error in rcpt_approve_pro: {:?}", e);
                                    }
                                }
                            } else if let Some(uid_str) = data.strip_prefix("rcpt_approve_flow_") {
                                if let Ok(uid) = uid_str.parse::<i64>() {
                                    if let Err(e) = admin_handlers::handle_receipt_approve(&bot, &q, &pool, admin_chat_id, uid, "Sentra Flow+").await {
                                        error!("Error in rcpt_approve_flow: {:?}", e);
                                    }
                                }
                            } else if let Some(uid_str) = data.strip_prefix("rcpt_reject_") {
                                if let Ok(uid) = uid_str.parse::<i64>() {
                                    if let Err(e) = admin_handlers::handle_receipt_reject(&bot, &q, &pool, admin_chat_id, uid).await {
                                        error!("Error in rcpt_reject: {:?}", e);
                                    }
                                }
                            }
                            // Financial Donation Review Callbacks
                            else if let Some(d_id_str) = data.strip_prefix("donate_approve_") {
                                if let Ok(d_id) = d_id_str.parse::<i64>() {
                                    if let Err(e) = admin_handlers::handle_donation_approve(&bot, &q, &pool, admin_chat_id, d_id, pro_subscription_price).await {
                                        error!("Error in donate_approve: {:?}", e);
                                    }
                                }
                            } else if let Some(d_id_str) = data.strip_prefix("donate_reject_") {
                                if let Ok(d_id) = d_id_str.parse::<i64>() {
                                    if let Err(e) = admin_handlers::handle_donation_reject(&bot, &q, &pool, admin_chat_id, d_id).await {
                                        error!("Error in donate_reject: {:?}", e);
                                    }
                                }
                            }
                            // Outbounds & General Callbacks
                            else if let Some(ob_id_str) = data.strip_prefix("toggle_ob_") {
                                if let Ok(ob_id) = ob_id_str.parse::<i64>() {
                                    if let Err(e) = admin_handlers::handle_toggle_outbound_callback(&bot, &q, &pool, admin_chat_id, ob_id).await {
                                        error!("Error in toggle outbound: {:?}", e);
                                    }
                                }
                            } else if data == "sim_pay_success" {
                                if let Err(e) = user_handlers::handle_payment_simulation(&bot, &q, &pool).await {
                                    error!("Error in payment simulation: {:?}", e);
                                }
                            } else if let Some(mode) = data.strip_prefix("ios_mode_") {
                                if let Err(e) = user_handlers::handle_ios_mode_selection(&bot, &q, &pool, mode, &base_url).await {
                                    error!("Error in ios mode selection: {:?}", e);
                                }
                            } else if let Some(mode) = data.strip_prefix("ios_proto_ikev2_") {
                                if let Err(e) = user_handlers::handle_ios_send_ikev2(&bot, &q, &pool, mode, &base_url).await {
                                    error!("Error in ios send ikev2: {:?}", e);
                                }
                            } else if let Some(mode) = data.strip_prefix("ios_proto_ovpn_udp_") {
                                if let Err(e) = user_handlers::handle_ios_send_openvpn(&bot, &q, &pool, mode, "openvpn_udp", &base_url).await {
                                    error!("Error in ios send openvpn udp: {:?}", e);
                                }
                            } else if let Some(mode) = data.strip_prefix("ios_proto_ovpn_tcp_") {
                                if let Err(e) = user_handlers::handle_ios_send_openvpn(&bot, &q, &pool, mode, "openvpn_tcp", &base_url).await {
                                    error!("Error in ios send openvpn tcp: {:?}", e);
                                }
                            } else if data == "ios_sub_back_to_modes" {
                                if let Err(e) = user_handlers::handle_ios_back_to_modes(&bot, &q, &pool).await {
                                    error!("Error in ios back to modes: {:?}", e);
                                }
                            } else if let Some(category) = data.strip_prefix("ticket_") {
                                if let Err(e) = user_handlers::handle_ticket_callback(&bot, &q, &pool, category).await {
                                    error!("Error in ticket callback: {:?}", e);
                                }
                            } else if data == "plan_info_pro" {
                                let _ = bot.answer_callback_query(q.id.clone())
                                    .text("پلن Sentra Pro: مناسب استریم و وبگردی پرسرعت بدون قطعی (۱۵۰ گیگ)")
                                    .show_alert(true)
                                    .await;
                            } else if data == "plan_info_flow" {
                                let _ = bot.answer_callback_query(q.id.clone())
                                    .text("پلن Sentra Flow+: دارای IP مسکونی ثابت آمریکا تضمین‌شده برای Google Flow و Gemini")
                                    .show_alert(true)
                                    .await;
                            }
                        }
                        respond(())
                    }
                }
            }),
        );

    Dispatcher::builder(bot, handler)
        .enable_ctrlc_handler()
        .build()
        .dispatch()
        .await;
}
