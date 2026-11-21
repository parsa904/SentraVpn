pub mod admin_handlers;
pub mod keyboards;
pub mod user_handlers;

use crate::db::DbPool;
use std::sync::Arc;
use teloxide::prelude::*;
use tracing::{error, info, warn};

pub async fn run_telegram_bot(
    token_opt: Option<String>,
    proxy_opt: Option<String>,
    pool: DbPool,
    admin_chat_id: i64,
    base_url: String,
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

    let handler = dptree::entry()
        .branch(
            Update::filter_message().endpoint({
                let pool = Arc::clone(&pool);
                let base_url = Arc::clone(&base_url);
                move |bot: Bot, msg: Message| {
                    let pool = Arc::clone(&pool);
                    let base_url = Arc::clone(&base_url);
                    async move {
                        if let Some(text) = msg.text() {
                            let text = text.trim();
                            if text == "/start" {
                                if let Err(e) = user_handlers::handle_start(&bot, &msg, &pool, admin_chat_id).await {
                                    error!("Error in /start: {:?}", e);
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
                            } else if text == "📊 وضعیت اشتراک و تیکت پشتیبانی" {
                                if let Err(e) = user_handlers::handle_subscription_status(&bot, &msg, &pool).await {
                                    error!("Error in handle_subscription_status: {:?}", e);
                                }
                            } else if text == "/admin" || text == "🛡 مدیریت سنترا (پنل ادمین)" {
                                if let Err(e) = admin_handlers::handle_admin_panel(&bot, &msg, &pool, admin_chat_id).await {
                                    error!("Error in /admin: {:?}", e);
                                }
                            } else if text == "📊 آمار و تفکیک کاربران" {
                                if let Err(e) = admin_handlers::handle_users_breakdown(&bot, &msg, &pool, admin_chat_id).await {
                                    error!("Error in handle_users_breakdown: {:?}", e);
                                }
                            } else if text == "🔄 وضعیت نودهای خروجی شبکه" {
                                if let Err(e) = admin_handlers::handle_outbounds_menu(&bot, &msg, &pool, admin_chat_id).await {
                                    error!("Error in handle_outbounds_menu: {:?}", e);
                                }
                            } else if text == "🩺 تست سلامت ۶ لایه سیستم" || text == "/health" {
                                if let Err(e) = admin_handlers::handle_six_layer_health_test(&bot, &msg, &pool, admin_chat_id).await {
                                    error!("Error in handle_six_layer_health_test: {:?}", e);
                                }
                            } else if text == "👤 بازگشت به منوی کاربری" {
                                if let Err(e) = admin_handlers::handle_return_to_user_menu(&bot, &msg).await {
                                    error!("Error in handle_return_to_user_menu: {:?}", e);
                                }
                            } else if text.starts_with("/tier ") {
                                let parts: Vec<&str> = text[6..].split_whitespace().collect();
                                if parts.len() == 2 {
                                    if let Ok(target_id) = parts[0].parse::<i64>() {
                                        if let Err(e) = admin_handlers::handle_manual_tier_change(&bot, &msg, &pool, admin_chat_id, target_id, parts[1]).await {
                                            error!("Error in handle_manual_tier_change: {:?}", e);
                                        }
                                    }
                                }
                            } else {
                                let _ = bot.send_message(
                                    msg.chat.id,
                                    "💡 لطفاً یکی از گزینه‌های منوی زیر را لمس نمایید یا /start را بفرستید.",
                                )
                                .reply_markup(keyboards::user_main_keyboard())
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
                move |bot: Bot, q: CallbackQuery| {
                    let pool = Arc::clone(&pool);
                    async move {
                        if let Some(ref data) = q.data {
                            if data == "sim_pay_success" {
                                if let Err(e) = user_handlers::handle_payment_simulation(&bot, &q, &pool).await {
                                    error!("Error in payment simulation: {:?}", e);
                                }
                            } else if data.starts_with("ticket_") {
                                let category = &data[7..];
                                if let Err(e) = user_handlers::handle_ticket_callback(&bot, &q, &pool, category).await {
                                    error!("Error in ticket callback: {:?}", e);
                                }
                            } else if let Some(ob_id_str) = data.strip_prefix("toggle_ob_") {
                                if let Ok(ob_id) = ob_id_str.parse::<i64>() {
                                    if let Err(e) = admin_handlers::handle_toggle_outbound_callback(&bot, &q, &pool, admin_chat_id, ob_id).await {
                                        error!("Error in toggle outbound: {:?}", e);
                                    }
                                }
                            } else if data == "plan_info_pro" {
                                let _ = bot.answer_callback_query(q.id.clone())
                                    .text("پلن Sentra Pro: مناسب استریم و وبگردی پرسرعت بدون قطعی")
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
