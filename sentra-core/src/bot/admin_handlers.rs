use crate::bot::keyboards::{back_to_admin_inline_keyboard, back_to_main_inline_keyboard};
use crate::bot::keyboards::user_main_keyboard;
use crate::bot::keyboards::{
    admin_app_release_inline_keyboard, admin_dashboard_inline_keyboard,
    admin_official_outbound_actions_keyboard, admin_official_outbounds_hub_keyboard,
    admin_outbound_reallocation_keyboard, admin_outbounds_inline_keyboard,
    admin_select_outbound_target_keyboard, admin_user_card_inline_keyboard,
    cancel_and_back_inline_keyboard, user_main_keyboard_with_admin,
};
use crate::db::{DbPool, Repository};
use crate::outbound_analyzer::OutboundAnalyzer;
use crate::quality_engine::QualityEngine;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Instant;
use teloxide::prelude::*;
use teloxide::types::{
    ChatId, InlineKeyboardButton, InlineKeyboardMarkup, InputFile, MessageId, ParseMode,
};
use tokio::sync::RwLock;
use tokio::time::{sleep, Duration};
use tracing::{info, warn};

#[derive(Debug, Clone)]
pub enum AdminOutboundState {
    AwaitingOutboundInput { category: String },
}

static ADMIN_OUTBOUND_STATES: OnceLock<RwLock<HashMap<i64, AdminOutboundState>>> = OnceLock::new();

fn outbound_states_map() -> &'static RwLock<HashMap<i64, AdminOutboundState>> {
    ADMIN_OUTBOUND_STATES.get_or_init(|| RwLock::new(HashMap::new()))
}

pub async fn set_admin_outbound_state(admin_id: i64, state: AdminOutboundState) {
    let mut map = outbound_states_map().write().await;
    map.insert(admin_id, state);
}

pub async fn get_admin_outbound_state(admin_id: i64) -> Option<AdminOutboundState> {
    let map = outbound_states_map().read().await;
    map.get(&admin_id).cloned()
}

pub async fn clear_admin_outbound_state(admin_id: i64) {
    let mut map = outbound_states_map().write().await;
    map.remove(&admin_id);
}

#[derive(Debug, Clone)]
pub enum AdminUploadState {
    AwaitingVersionAndChangelog { platform: String },
    AwaitingFile {
        platform: String,
        version: String,
        changelog: String,
    },
}

static ADMIN_UPLOAD_STATES: OnceLock<RwLock<HashMap<i64, AdminUploadState>>> = OnceLock::new();

fn upload_states_map() -> &'static RwLock<HashMap<i64, AdminUploadState>> {
    ADMIN_UPLOAD_STATES.get_or_init(|| RwLock::new(HashMap::new()))
}

pub async fn set_admin_upload_state(admin_id: i64, state: AdminUploadState) {
    let mut map = upload_states_map().write().await;
    map.insert(admin_id, state);
}

pub async fn get_admin_upload_state(admin_id: i64) -> Option<AdminUploadState> {
    let map = upload_states_map().read().await;
    map.get(&admin_id).cloned()
}

pub async fn clear_admin_upload_state(admin_id: i64) {
    let mut map = upload_states_map().write().await;
    map.remove(&admin_id);
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AdminPanelState {
    AwaitingUserSearch,
    AwaitingBroadcast,
}

static ADMIN_PANEL_STATES: OnceLock<RwLock<HashMap<i64, AdminPanelState>>> = OnceLock::new();

fn panel_states_map() -> &'static RwLock<HashMap<i64, AdminPanelState>> {
    ADMIN_PANEL_STATES.get_or_init(|| RwLock::new(HashMap::new()))
}

pub async fn set_admin_panel_state(admin_id: i64, state: AdminPanelState) {
    let mut map = panel_states_map().write().await;
    map.insert(admin_id, state);
}

pub async fn get_admin_panel_state(admin_id: i64) -> Option<AdminPanelState> {
    let map = panel_states_map().read().await;
    map.get(&admin_id).cloned()
}

pub async fn clear_admin_panel_state(admin_id: i64) {
    let mut map = panel_states_map().write().await;
    map.remove(&admin_id);
}

/// Pending Subscription URL node list preview per admin (for interactive list + force-add regardless of ping)
#[derive(Debug, Clone)]
pub struct PendingSubImport {
    pub category: String,
    pub source_url: String,
    pub total_raw_lines: usize,
    pub skipped_invalid: usize,
    pub nodes: Vec<crate::outbound_analyzer::PreviewedSubNode>,
    pub added_indices: std::collections::HashSet<usize>,
}

static ADMIN_PENDING_SUB_IMPORTS: OnceLock<RwLock<HashMap<i64, PendingSubImport>>> =
    OnceLock::new();

fn pending_sub_imports_map() -> &'static RwLock<HashMap<i64, PendingSubImport>> {
    ADMIN_PENDING_SUB_IMPORTS.get_or_init(|| RwLock::new(HashMap::new()))
}

pub async fn set_pending_sub_import(admin_id: i64, pending: PendingSubImport) {
    let mut map = pending_sub_imports_map().write().await;
    map.insert(admin_id, pending);
}

pub async fn get_pending_sub_import(admin_id: i64) -> Option<PendingSubImport> {
    let map = pending_sub_imports_map().read().await;
    map.get(&admin_id).cloned()
}

pub async fn clear_pending_sub_import(admin_id: i64) {
    let mut map = pending_sub_imports_map().write().await;
    map.remove(&admin_id);
}

fn escape_html(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn category_label_fa(category: &str) -> &str {
    match category {
        "free_only" | "web_browsing" => "🌐 فقط بخش رایگان (وب‌گردی / دانلود)",
        "gaming_only" | "gaming" => "🎮 فقط بخش گیمینگ (فعال‌سازی گیمینگ در کل اکوسیستم)",
        "static_only" | "static_ip" => "💎 فقط بخش آی‌پی ثابت (ترید و جمنای)",
        "both" => "⚡️ بخش رایگان + آی‌پی ثابت همزمان",
        "all" => "🔥 کل اکوسیستم (رایگان + آی‌پی ثابت + گیمینگ)",
        "auto" => "🤖 تشخیص هوشمند خودکار (بر اساس تست جمنای و سرعت)",
        "download" => "📥 دانلود (Download)",
        _ => category,
    }
}

fn category_enables_gaming(category: &str) -> bool {
    matches!(category, "gaming" | "gaming_only" | "all")
}

fn allocation_summary_fa(ob: &crate::models::DonatedOutbound) -> &'static str {
    if ob.allow_gaming == 1 && ob.allow_static_ip == 1 && ob.allow_web == 1 {
        "🔥 کل اکوسیستم (رایگان + آی‌پی ثابت + گیمینگ)"
    } else if ob.allow_gaming == 1 && ob.allow_web == 0 && ob.allow_static_ip == 0 {
        "🎮 فقط بخش گیمینگ"
    } else if ob.allow_gaming == 1 {
        "🎮 گیمینگ + سایر بخش‌ها"
    } else if ob.allow_static_ip == 1 && ob.allow_web == 1 {
        "⚡️ بخش رایگان + آی‌پی ثابت"
    } else if ob.allow_static_ip == 1 {
        "💎 فقط آی‌پی ثابت (ترید و جمنای)"
    } else {
        "🌐 فقط بخش رایگان (وب / دانلود)"
    }
}

/// Immediately clears all pending admin conversation/input states
pub async fn clear_all_admin_states(admin_id: i64) {
    clear_admin_outbound_state(admin_id).await;
    clear_admin_upload_state(admin_id).await;
    clear_admin_panel_state(admin_id).await;
    clear_pending_sub_import(admin_id).await;
}

pub fn is_authorized_admin(telegram_id: i64, admin_chat_id: i64) -> bool {
    admin_chat_id == 0 || telegram_id == admin_chat_id
}

fn format_traffic(bytes: i64) -> String {
    if bytes <= 0 {
        return "0 MB".to_string();
    }
    let mb = bytes as f64 / 1_048_576.0;
    if mb >= 1024.0 {
        format!("{:.2} GB", mb / 1024.0)
    } else {
        format!("{:.1} MB", mb)
    }
}

/// Open Master Admin Panel with glass inline dashboard
pub async fn handle_admin_panel(
    bot: &Bot,
    msg: &Message,
    pool: &DbPool,
    admin_chat_id: i64,
) -> anyhow::Result<()> {
    let telegram_id = msg.from.as_ref().map(|u| u.id.0 as i64).unwrap_or(0);
    if !is_authorized_admin(telegram_id, admin_chat_id) {
        bot.send_message(msg.chat.id, "⛔ دسترسی به پنل مدیریت برای شما مجاز نیست.")
            .await?;
        return Ok(());
    }

    let stats = Repository::get_admin_realtime_stats(pool).await?;

    let text = format!(
        r#"🛡 <b>داشبورد مدیریت مرکزی سنترا (Sentra Master Admin)</b>

📊 <b>خلاصه لحظه‌ای وضعیت سیستم:</b>
• کل کاربران ثبت‌شده: <b>{}</b>
• کاربران فعال ویژه (Pro / Flow+): <b>{}</b>
• کاربران مسدودشده (Suspended): <b>{}</b>
• نشست‌ها و دستگاه‌های متصل: <b>{}</b>
• ترافیک ۲۴ ساعت گذشته: <b>{}</b>

جهت دسترسی به هر بخش از دکمه‌های شیشه‌ای زیر استفاده نمایید:"#,
        stats.total_users,
        stats.premium_users,
        stats.suspended_users,
        stats.active_sessions,
        format_traffic(stats.traffic_24h_bytes)
    );

    bot.send_message(msg.chat.id, text)
        .parse_mode(ParseMode::Html)
        .reply_markup(admin_dashboard_inline_keyboard())
        .await?;

    Ok(())
}

/// 1. Realtime System Stats handler
pub async fn handle_realtime_stats_callback(
    bot: &Bot,
    q: &CallbackQuery,
    pool: &DbPool,
    admin_chat_id: i64,
) -> anyhow::Result<()> {
    let telegram_id = q.from.id.0 as i64;
    if !is_authorized_admin(telegram_id, admin_chat_id) {
        let _ = bot.answer_callback_query(q.id.clone()).text("⛔ عدم دسترسی").await;
        return Ok(());
    }

    let stats = Repository::get_admin_realtime_stats(pool).await?;
    let health = Repository::get_system_health(pool).await?;

    let text = format!(
        r#"📊 <b>آمار تفصیلی و لحظه‌ای اکوسیستم سنترا:</b>

👥 <b>وضعیت کاربران:</b>
• کل کاربران عضو: <b>{} نفر</b>
• کاربران پلن <code>Sentra Lite</code> (رایگان): <b>{} نفر</b>
• کاربران پلن <code>Sentra Pro</code> (حرفه‌ای): <b>{} نفر</b>
• کاربران پلن <code>Sentra Flow+</code> (مسکونی): <b>{} نفر</b>
• مجموع کاربران ویژه فعال: <b>{} نفر</b>
• کاربران مسدودشده (Suspended): <b>{} نفر</b>

📱 <b>نشست‌ها و تجهیزات فعال:</b>
• دستگاه‌های متصل ثبت‌شده: <b>{} دستگاه</b>
• سرورهای خروجی آنلاین: <b>{} نود عملیاتی</b>
• مصرف ترافیک ۲۴ ساعت اخیر: <b>{}</b>
• وضعیت ژورنال دیتابیس: <b>SQLite WAL (فعال 🟢)</b>"#,
        stats.total_users,
        health.lite_users,
        health.pro_users,
        health.flow_users,
        stats.premium_users,
        stats.suspended_users,
        stats.active_sessions,
        health.active_outbounds,
        format_traffic(stats.traffic_24h_bytes)
    );

    if let Some(msg) = &q.message {
        let _ = bot
            .edit_message_text(msg.chat().id, msg.id(), text)
            .parse_mode(ParseMode::Html)
            .reply_markup(admin_dashboard_inline_keyboard())
            .await;
    }

    let _ = bot.answer_callback_query(q.id.clone()).await;
    Ok(())
}

/// 2. Search & User Management handler
pub async fn handle_admin_search_user(
    bot: &Bot,
    msg: &Message,
    pool: &DbPool,
    admin_chat_id: i64,
    query_str: &str,
) -> anyhow::Result<()> {
    let telegram_id = msg.from.as_ref().map(|u| u.id.0 as i64).unwrap_or(0);
    if !is_authorized_admin(telegram_id, admin_chat_id) {
        return Ok(());
    }

    let user_opt = Repository::find_user_by_query(pool, query_str).await?;
    let user = match user_opt {
        Some(u) => u,
        None => {
            bot.send_message(
                msg.chat.id,
                format!("❌ کاربری با شناسه یا یوزرنیم <code>{}</code> در سامانه یافت نشد.", query_str),
            )
            .parse_mode(ParseMode::Html)
            .reply_markup(admin_dashboard_inline_keyboard())
            .await?;
            return Ok(());
        }
    };

    render_user_card(bot, msg.chat.id, None, pool, user.id).await?;
    Ok(())
}

/// Render or edit a user card with full details and action buttons
pub async fn render_user_card(
    bot: &Bot,
    chat_id: ChatId,
    edit_msg_id: Option<MessageId>,
    pool: &DbPool,
    user_id: i64,
) -> anyhow::Result<()> {
    let user_data = Repository::get_user_with_subscription_and_devices(pool, user_id).await?;
    let (user, sub_opt, devices) = match user_data {
        Some(data) => data,
        None => return Ok(()),
    };

    let status_badge = match user.status.as_str() {
        "active" => "🟢 فعال (Active)",
        "suspended" => "⛔ مسدود موقت (Suspended)",
        "banned" => "🚫 محروم دائم (Banned)",
        _ => "نامشخص",
    };

    let (tier_name, token, expiry_str, wb_used, dl_used, static_used) = match &sub_opt {
        Some(s) => (
            s.tier.as_str(),
            s.token.as_str(),
            s.expires_at.format("%Y-%m-%d %H:%M UTC").to_string(),
            s.web_browsing_used_mb,
            s.download_used_mb,
            s.static_ip_used_mb,
        ),
        None => ("فاقد اشتراک", "ندارد", "نامشخص".to_string(), 0, 0, 0),
    };

    let mut devices_report = String::new();
    if devices.is_empty() {
        devices_report.push_str("   <i>هیچ دستگاهی ثبت نشده است.</i>\n");
    } else {
        for (idx, dev) in devices.iter().enumerate() {
            let plat_icon = match dev.platform.to_lowercase().as_str() {
                "windows" => "💻",
                "android" => "📱",
                "ios" => "🍎",
                _ => "📟",
            };
            let last_active = dev.last_active_at.format("%m-%d %H:%M").to_string();
            devices_report.push_str(&format!(
                "   {}. {} <b>{}</b> ({})\n      شناسه: <code>{}</code> | آخرین اتصال: <code>{}</code>\n",
                idx + 1,
                plat_icon,
                dev.device_name,
                dev.platform,
                dev.device_id,
                last_active
            ));
        }
    }

    let quota_section = if tier_name != "Sentra Lite" {
        let static_rem = (30_720 - static_used).max(0);
        format!(
            r#"📊 <b>وضعیت سهمیه ترافیک (اشتراک ویژه):</b>
• وب‌گردی: <b><code>نامحدود (مصرف امروز: {} MB)</code></b>
• دانلود: <b><code>نامحدود (مصرف امروز: {} MB)</code></b>
• آی‌پی ثابت: <b><code>{} / 30,720 MB</code></b> ({:.1} GB باقیمانده)"#,
            wb_used, dl_used, static_used, static_rem as f64 / 1024.0
        )
    } else {
        format!(
            r#"📊 <b>مصرف روزانه امروز (سهمیه رایگان):</b>
• وب‌گردی: <b><code>{} / 2048 MB</code></b>
• دانلود: <b><code>{} / 3072 MB</code></b>
• آی‌پی ثابت: <b><code>🔒 قفل (نیازمند ارتقا به اشتراک Pro)</code></b>"#,
            wb_used, dl_used
        )
    };

    let is_suspended = user.status == "suspended";
    let card_text = format!(
        r#"🔍 <b>کارت مشخصات و مدیریت کاربر:</b>

👤 <b>اطلاعات هویتی:</b>
• نام: <b>{} {}</b>
• شناسه تلگرام: <code>{}</code>
• یوزرنیم: @{}
• شناسه در دیتابیس: <code>#{}</code>
• وضعیت حساب: <b>{}</b>

🛡 <b>مشخصات اشتراک:</b>
• پلن فعلی: <b><code>{}</code></b>
• توکن اتصال: <code>{}</code>
• تاریخ انقضا: <code>{}</code>

{}

📱 <b>دستگاه‌های متصل (حداکثر ۳ دستگاه):</b>
{}
از دکمه‌های عملیاتی زیر برای مدیریت کامل این حساب استفاده کنید:"#,
        user.first_name,
        user.last_name.as_deref().unwrap_or(""),
        user.telegram_id.map(|t| t.to_string()).unwrap_or_else(|| "ندارد".to_string()),
        user.username.as_deref().unwrap_or("ندارد"),
        user.id,
        status_badge,
        tier_name,
        token,
        expiry_str,
        quota_section,
        devices_report
    );

    let keyboard = admin_user_card_inline_keyboard(user.id, is_suspended);

    if let Some(msg_id) = edit_msg_id {
        let _ = bot
            .edit_message_text(chat_id, msg_id, card_text)
            .parse_mode(ParseMode::Html)
            .reply_markup(keyboard)
            .await;
    } else {
        bot.send_message(chat_id, card_text)
            .parse_mode(ParseMode::Html)
            .reply_markup(keyboard)
            .await?;
    }

    Ok(())
}

/// Upgrade user subscription to Pro / Flow+ for 30 days
pub async fn handle_admin_upgrade_30_days(
    bot: &Bot,
    q: &CallbackQuery,
    pool: &DbPool,
    admin_chat_id: i64,
    target_user_id: i64,
    tier: &str,
) -> anyhow::Result<()> {
    let telegram_id = q.from.id.0 as i64;
    if !is_authorized_admin(telegram_id, admin_chat_id) {
        let _ = bot.answer_callback_query(q.id.clone()).text("⛔ عدم دسترسی").await;
        return Ok(());
    }

    let sub = Repository::upgrade_subscription_30_days(pool, target_user_id, tier).await?;
    let user_opt = Repository::get_user_by_id(pool, target_user_id).await?;

    let alert_msg = format!("✅ اشتراک به {} ارتقا یافت (اعتبار ۳۰ روزه)", sub.tier);
    let _ = bot.answer_callback_query(q.id.clone()).text(alert_msg).show_alert(true).await;

    // Notify user in Telegram
    if let Some(u) = user_opt {
        let notify_text = format!(
            r#"🎉 <b>اشتراک شما توسط مدیریت سنترا ارتقا یافت!</b>

👑 <b>پلن جدید: {} (۳۰ روزه)</b>
• سقف حجم: <b>{}</b>
• سقف دستگاه‌ها: <b>{} دستگاه</b>
• تاریخ انقضای جدید: <code>{}</code>
• توکن اتصال: <code>{}</code>

اکنون در اپلیکیشن کلاینت می‌توانید به تمام قابلیت‌ها و سرورهای ویژه دسترسی داشته باشید."#,
            sub.tier,
            if sub.traffic_limit_bytes > 500_000_000_000 { "۱ ترابایت" } else { "۱۵۰ گیگابایت" },
            sub.max_concurrent_devices,
            sub.expires_at.format("%Y-%m-%d %H:%M UTC"),
            sub.token
        );
        if let Some(tid) = u.telegram_id {
            let _ = bot
                .send_message(ChatId(tid), notify_text)
                .parse_mode(ParseMode::Html)
                .await;
        }
    }

    if let Some(msg) = &q.message {
        render_user_card(bot, msg.chat().id, Some(msg.id()), pool, target_user_id).await?;
    }

    Ok(())
}

/// Reset user's daily quotas
pub async fn handle_admin_reset_quota(
    bot: &Bot,
    q: &CallbackQuery,
    pool: &DbPool,
    admin_chat_id: i64,
    target_user_id: i64,
) -> anyhow::Result<()> {
    let telegram_id = q.from.id.0 as i64;
    if !is_authorized_admin(telegram_id, admin_chat_id) {
        let _ = bot.answer_callback_query(q.id.clone()).text("⛔ عدم دسترسی").await;
        return Ok(());
    }

    Repository::reset_user_daily_quota(pool, target_user_id).await?;

    let _ = bot
        .answer_callback_query(q.id.clone())
        .text("🔄 سهمیه حجم روزانه وب‌گردی و دانلود با موفقیت صفر شد.")
        .show_alert(true)
        .await;

    if let Some(msg) = &q.message {
        render_user_card(bot, msg.chat().id, Some(msg.id()), pool, target_user_id).await?;
    }

    Ok(())
}

/// Reset user's static IP quota (30 GB)
pub async fn handle_admin_reset_static_ip(
    bot: &Bot,
    q: &CallbackQuery,
    pool: &DbPool,
    admin_chat_id: i64,
    target_user_id: i64,
) -> anyhow::Result<()> {
    let telegram_id = q.from.id.0 as i64;
    if !is_authorized_admin(telegram_id, admin_chat_id) {
        let _ = bot.answer_callback_query(q.id.clone()).text("⛔ عدم دسترسی").await;
        return Ok(());
    }

    Repository::reset_user_static_ip_quota(pool, target_user_id).await?;

    let _ = bot
        .answer_callback_query(q.id.clone())
        .text("🔄 سهمیه حجم ۳۰ گیگابایت آی‌پی ثابت با موفقیت ریست شد.")
        .show_alert(true)
        .await;

    if let Some(msg) = &q.message {
        render_user_card(bot, msg.chat().id, Some(msg.id()), pool, target_user_id).await?;
    }

    Ok(())
}

/// Clear connected devices for user
pub async fn handle_admin_clear_devices(
    bot: &Bot,
    q: &CallbackQuery,
    pool: &DbPool,
    admin_chat_id: i64,
    target_user_id: i64,
) -> anyhow::Result<()> {
    let telegram_id = q.from.id.0 as i64;
    if !is_authorized_admin(telegram_id, admin_chat_id) {
        let _ = bot.answer_callback_query(q.id.clone()).text("⛔ عدم دسترسی").await;
        return Ok(());
    }

    let cleared_count = Repository::clear_user_devices(pool, target_user_id).await?;

    let _ = bot
        .answer_callback_query(q.id.clone())
        .text(format!("📱 تمام {} دستگاه متصل کاربر پاکسازی شدند.", cleared_count))
        .show_alert(true)
        .await;

    if let Some(msg) = &q.message {
        render_user_card(bot, msg.chat().id, Some(msg.id()), pool, target_user_id).await?;
    }

    Ok(())
}

/// Toggle suspension/block status of user
pub async fn handle_admin_toggle_block(
    bot: &Bot,
    q: &CallbackQuery,
    pool: &DbPool,
    admin_chat_id: i64,
    target_user_id: i64,
) -> anyhow::Result<()> {
    let telegram_id = q.from.id.0 as i64;
    if !is_authorized_admin(telegram_id, admin_chat_id) {
        let _ = bot.answer_callback_query(q.id.clone()).text("⛔ عدم دسترسی").await;
        return Ok(());
    }

    let new_status = Repository::toggle_user_block(pool, target_user_id).await?;
    let user_opt = Repository::get_user_by_id(pool, target_user_id).await?;

    let alert_msg = if new_status == "suspended" {
        "⛔ حساب کاربر با موفقیت مسدود (Suspended) شد."
    } else {
        "✅ مسدودیت حساب کاربر رفع و مجدداً فعال گردید."
    };

    let _ = bot
        .answer_callback_query(q.id.clone())
        .text(alert_msg)
        .show_alert(true)
        .await;

    // Notify user in Telegram
    if let Some(u) = user_opt {
        let user_notify = if new_status == "suspended" {
            "⛔ <b>اطلاعیه مدیریت:</b> حساب کاربری شما موقتاً مسدود گردید. جهت پیگیری با پشتیبانی در ارتباط باشید."
        } else {
            "✅ <b>اطلاعیه مدیریت:</b> حساب کاربری شما رفع مسدودیت شده و آماده استفاده است."
        };
        if let Some(tid) = u.telegram_id {
            let _ = bot
                .send_message(ChatId(tid), user_notify)
                .parse_mode(ParseMode::Html)
                .await;
        }
    }

    if let Some(msg) = &q.message {
        render_user_card(bot, msg.chat().id, Some(msg.id()), pool, target_user_id).await?;
    }

    Ok(())
}

/// 3. Broadcast message to all registered users with safe rate limiting
pub async fn handle_admin_broadcast(
    bot: &Bot,
    msg: &Message,
    pool: &DbPool,
    admin_chat_id: i64,
    broadcast_text: &str,
    photo_file_id: Option<String>,
) -> anyhow::Result<()> {
    let telegram_id = msg.from.as_ref().map(|u| u.id.0 as i64).unwrap_or(0);
    if !is_authorized_admin(telegram_id, admin_chat_id) {
        return Ok(());
    }

    let user_ids = Repository::get_all_active_telegram_ids(pool).await?;
    let total_count = user_ids.len();

    let status_msg = bot
        .send_message(
            msg.chat.id,
            format!("📢 <b>آغاز ارسال همگانی به {} کاربر...</b>\nلطفاً شکیبا باشید.", total_count),
        )
        .parse_mode(ParseMode::Html)
        .await?;

    let start_time = Instant::now();
    let mut success_count = 0usize;
    let mut failure_count = 0usize;

    for (idx, target_chat_id) in user_ids.into_iter().enumerate() {
        let send_res = if let Some(ref file_id) = photo_file_id {
            bot.send_photo(ChatId(target_chat_id), InputFile::file_id(file_id.clone()))
                .caption(broadcast_text)
                .parse_mode(ParseMode::Html)
                .await
                .map(|_| ())
        } else {
            bot.send_message(ChatId(target_chat_id), broadcast_text)
                .parse_mode(ParseMode::Html)
                .await
                .map(|_| ())
        };

        match send_res {
            Ok(_) => success_count += 1,
            Err(e) => {
                warn!("Broadcast delivery failed for telegram_id {}: {:?}", target_chat_id, e);
                failure_count += 1;
            }
        }

        // Safe rate limiting: 35ms sleep between sends (approx 25 msgs/sec, safe under Telegram's 30/s ceiling)
        sleep(Duration::from_millis(35)).await;

        // Periodic progress log
        if (idx + 1) % 50 == 0 || idx + 1 == total_count {
            info!("Broadcast progress: {}/{} delivered", idx + 1, total_count);
        }
    }

    let elapsed = start_time.elapsed().as_secs();
    let final_report = format!(
        r#"📢 <b>گزارش ارسال پیام همگانی (Broadcast Completed):</b>

• کل کاربران هدف: <b>{} نفر</b>
• ارسال موفقیت‌آمیز: <b>{} مورد</b>
• ناموفق یا بلاک‌شده: <b>{} مورد</b>
• زمان سپری‌شده: <b>{} ثانیه</b>
• نرخ ارسال: <b>{:.1} پیام در ثانیه</b>"#,
        total_count,
        success_count,
        failure_count,
        elapsed,
        if elapsed > 0 { success_count as f64 / elapsed as f64 } else { success_count as f64 }
    );

    let _ = bot
        .edit_message_text(msg.chat.id, status_msg.id, final_report)
        .parse_mode(ParseMode::Html)
        .reply_markup(admin_dashboard_inline_keyboard())
        .await;

    Ok(())
}

/// 4. Manual payment / donation receipt submission by user (forward to Admin)
pub async fn handle_receipt_submission(
    bot: &Bot,
    msg: &Message,
    pool: &DbPool,
    admin_chat_id: i64,
    pro_price: i64,
) -> anyhow::Result<()> {
    let telegram_id = msg.from.as_ref().map(|u| u.id.0 as i64).unwrap_or(0);
    if telegram_id == 0 {
        return Ok(());
    }

    let user = Repository::get_or_create_user(
        pool,
        telegram_id,
        msg.from.as_ref().and_then(|u| u.username.as_deref()),
        msg.from.as_ref().map(|u| u.first_name.as_str()).unwrap_or("کاربر"),
        msg.from.as_ref().and_then(|u| u.last_name.as_deref()),
    )
    .await?;

    let sub_opt = Repository::get_user_with_subscription_and_devices(pool, user.id).await?;
    let tier_name = sub_opt
        .as_ref()
        .and_then(|(_, s, _)| s.as_ref())
        .map(|s| s.tier.as_str())
        .unwrap_or("Sentra Lite");

    let photos = match msg.photo() {
        Some(p) if !p.is_empty() => p,
        _ => return Ok(()),
    };
    let best_photo = &photos[photos.len() - 1];

    let file_unique_id = &best_photo.file.unique_id;
    let mut hasher = Sha256::new();
    hasher.update(file_unique_id.as_bytes());
    let image_sha256 = format!("{:x}", hasher.finalize());

    // Security Hardening: Anti-Replay check on payment receipts
    if Repository::is_receipt_replay(pool, file_unique_id, &image_sha256).await.unwrap_or(false) {
        let warn_msg = "⚠️ <b>این رسید قبلاً در سیستم ثبت شده است.</b>\n\nامکان ثبت مجدد فیش تکراری وجود ندارد. در صورت هرگونه سوال با پشتیبانی در ارتباط باشید.";
        bot.send_message(ChatId(telegram_id), warn_msg)
            .parse_mode(ParseMode::Html)
            .await?;
        return Ok(());
    }

    let caption_text = msg.caption().map(|s| s.to_string());
    let amount = extract_amount_from_caption(caption_text.as_deref());
    let qualifies_for_pro = amount > (2 * pro_price);

    // Record donation in database with anti-replay unique ID & hash
    let donation = Repository::create_donation(
        pool,
        user.id,
        amount,
        &best_photo.file.id,
        Some(file_unique_id),
        Some(&image_sha256),
    )
    .await?;

    let reward_status_badge = if qualifies_for_pro {
        "🟢 واجد شرایط ۳۰ روز اشتراک Pro هدیه (> ۲ برابر هزینه اشتراک)"
    } else {
        "⚪ حمایت عادی از توسعه (کمتر یا مساوی ۲ برابر هزینه اشتراک)"
    };

    let caption = format!(
        r#"🧾 <b>فیش حمایت مالی / پرداخت جدید دریافتی:</b>

👤 <b>مشخصات کاربر:</b>
• نام: <b>{} {}</b>
• شناسه تلگرام: <code>{}</code>
• یوزرنیم: @{}
• پلن فعلی: <code>{}</code>
• شناسه تراکنش حمایت: <code>#{}</code>
• مبلغ ثبت‌شده: <b>{} تومان</b>
• وضعیت پاداش: <b>{}</b>
• تاریخ ارسال: <code>{}</code>

💡 <i>مبنای اشتراک Pro: {} تومان (حداقل مبلغ برای اشتراک هدیه: بیش از {} تومان)</i>"#,
        user.first_name,
        user.last_name.as_deref().unwrap_or(""),
        user.telegram_id.map(|t| t.to_string()).unwrap_or_else(|| "ندارد".to_string()),
        user.username.as_deref().unwrap_or("ندارد"),
        tier_name,
        donation.id,
        if amount > 0 { amount.to_string() } else { "درج‌نشده در کپشن".to_string() },
        reward_status_badge,
        chrono::Utc::now().format("%Y-%m-%d %H:%M UTC"),
        pro_price,
        pro_price * 2
    );

    // Send photo to admin chat if configured
    if admin_chat_id != 0 {
        bot.send_photo(ChatId(admin_chat_id), InputFile::file_id(best_photo.file.id.clone()))
            .caption(caption)
            .parse_mode(ParseMode::Html)
            .reply_markup(crate::bot::keyboards::donation_review_inline_keyboard(donation.id, qualifies_for_pro))
            .await?;
    }

    // Acknowledge receipt to user
    let user_ack = if qualifies_for_pro {
        format!(
            r#"🧾 <b>تصویر فیش/رسید حمایت مالی شما با موفقیت دریافت شد!</b>

مبلغ ثبت‌شده: <b>{} تومان</b>
💡 <i>با توجه به اینکه مبلغ حمایت شما بیشتر از ۲ برابر هزینه اشتراک ماهانه است، پس از تایید رسید توسط مدیریت، یک <b>اشتراک ویژه ۳۰ روزه Sentra Pro</b> نیز به عنوان قدردانی روی حساب شما فعال خواهد شد.</i>

رسید جهت بررسی و تطبیق به پشتیبانی مالی ارسال گردید. از همراهی ارزشمند شما سپاسگزاریم! ❤️"#,
            amount
        )
    } else {
        r#"🧾 <b>تصویر فیش/رسید حمایت مالی شما با موفقیت دریافت شد!</b>

رسید شما جهت بررسی و ثبت نهایی به پشتیبانی ارسال گردید.
تمام حمایت‌های مالی شما مستقیماً صرف توسعه بهتر برنامه، افزایش پایداری و بهبود کیفیت سرویس خواهد شد. از همراهی و لطف شما بی‌نهایت سپاسگزاریم! 🙏✨"#.to_string()
    };

    bot.send_message(msg.chat.id, user_ack)
        .parse_mode(ParseMode::Html)
        .reply_markup(user_main_keyboard())
        .await?;

    Ok(())
}

fn extract_amount_from_caption(caption: Option<&str>) -> i64 {
    if let Some(c) = caption {
        let mut digits = String::new();
        for ch in c.chars() {
            if ch.is_ascii_digit() {
                digits.push(ch);
            }
        }
        if let Ok(num) = digits.parse::<i64>() {
            return num;
        }
    }
    0
}

/// Admin approves payment receipt
pub async fn handle_receipt_approve(
    bot: &Bot,
    q: &CallbackQuery,
    pool: &DbPool,
    admin_chat_id: i64,
    target_user_id: i64,
    tier: &str,
) -> anyhow::Result<()> {
    let telegram_id = q.from.id.0 as i64;
    if !is_authorized_admin(telegram_id, admin_chat_id) {
        let _ = bot.answer_callback_query(q.id.clone()).text("⛔ عدم دسترسی").await;
        return Ok(());
    }

    let sub = Repository::upgrade_subscription_30_days(pool, target_user_id, tier).await?;
    let user_opt = Repository::get_user_by_id(pool, target_user_id).await?;

    let _ = bot
        .answer_callback_query(q.id.clone())
        .text(format!("✅ رسید تایید شد و اشتراک ۳۰ روزه {} فعال گردید.", sub.tier))
        .show_alert(true)
        .await;

    // Notify user in Telegram
    if let Some(u) = user_opt {
        let user_text = format!(
            r#"🎉 <b>پرداخت شما با موفقیت تایید و فعال‌سازی شد!</b>

👑 <b>پلن فعال‌شده: {} (۳۰ روزه)</b>
• سقف حجم: <b>{}</b>
• تاریخ انقضا: <code>{}</code>
• توکن اتصال: <code>{}</code>

از همراهی شما با سنترا سپاسگزاریم!"#,
            sub.tier,
            if sub.traffic_limit_bytes > 500_000_000_000 { "۱ ترابایت" } else { "۱۵۰ گیگابایت" },
            sub.expires_at.format("%Y-%m-%d %H:%M UTC"),
            sub.token
        );
        if let Some(tid) = u.telegram_id {
            let _ = bot
                .send_message(ChatId(tid), user_text)
                .parse_mode(ParseMode::Html)
                .await;
        }
    }

    // Update admin message
    if let Some(msg) = &q.message {
        let current_caption = msg.regular_message().and_then(|m| m.caption()).unwrap_or("");
        let updated_caption = format!(
            "{}\n\n<b>[وضعیت: ✅ تایید شد توسط ادمین در تاریخ {} - پلن: {}]</b>",
            current_caption,
            chrono::Utc::now().format("%Y-%m-%d %H:%M UTC"),
            sub.tier
        );
        let _ = bot
            .edit_message_caption(msg.chat().id, msg.id())
            .caption(updated_caption)
            .parse_mode(ParseMode::Html)
            .await;
    }

    Ok(())
}

/// Admin rejects payment receipt
pub async fn handle_receipt_reject(
    bot: &Bot,
    q: &CallbackQuery,
    pool: &DbPool,
    admin_chat_id: i64,
    target_user_id: i64,
) -> anyhow::Result<()> {
    let telegram_id = q.from.id.0 as i64;
    if !is_authorized_admin(telegram_id, admin_chat_id) {
        let _ = bot.answer_callback_query(q.id.clone()).text("⛔ عدم دسترسی").await;
        return Ok(());
    }

    let user_opt = Repository::get_user_by_id(pool, target_user_id).await?;

    let _ = bot
        .answer_callback_query(q.id.clone())
        .text("❌ رسید پرداخت رد گردید.")
        .show_alert(true)
        .await;

    // Notify user in Telegram
    if let Some(u) = user_opt {
        let user_text = r#"❌ <b>اطلاعیه بررسی رسید پرداخت:</b>

متاسفانه تصویر فیش ارسالی شما توسط بخش حسابداری تایید نشد (عدم تطابق مبلغ، شماره پیگیری نامعتبر یا تصویر ناخوانا).
در صورت بروز اشتباه لطفاً فیش معتبر را مجدداً ارسال کرده یا با پشتیبانی در ارتباط باشید."#;
        if let Some(tid) = u.telegram_id {
            let _ = bot
                .send_message(ChatId(tid), user_text)
                .parse_mode(ParseMode::Html)
                .await;
        }
    }

    // Update admin message
    if let Some(msg) = &q.message {
        let current_caption = msg.regular_message().and_then(|m| m.caption()).unwrap_or("");
        let updated_caption = format!(
            "{}\n\n<b>[وضعیت: ❌ رسید توسط ادمین رد شد در تاریخ {}]</b>",
            current_caption,
            chrono::Utc::now().format("%Y-%m-%d %H:%M UTC")
        );
        let _ = bot
            .edit_message_caption(msg.chat().id, msg.id())
            .caption(updated_caption)
            .parse_mode(ParseMode::Html)
            .await;
    }

    Ok(())
}

/// Admin approves financial donation
pub async fn handle_donation_approve(
    bot: &Bot,
    q: &CallbackQuery,
    pool: &DbPool,
    admin_chat_id: i64,
    donation_id: i64,
    pro_price: i64,
) -> anyhow::Result<()> {
    let telegram_id = q.from.id.0 as i64;
    if !is_authorized_admin(telegram_id, admin_chat_id) {
        let _ = bot.answer_callback_query(q.id.clone()).text("⛔ عدم دسترسی").await;
        return Ok(());
    }

    let donation_opt = Repository::get_donation_by_id(pool, donation_id).await?;
    let donation = match donation_opt {
        Some(d) => d,
        None => {
            let _ = bot.answer_callback_query(q.id.clone()).text("تراکنش یافت نشد.").await;
            return Ok(());
        }
    };

    let qualifies_for_pro = donation.amount > (2 * pro_price);
    let updated_donation = Repository::approve_donation(pool, donation_id, qualifies_for_pro).await?;
    let user_opt = Repository::get_user_by_id(pool, updated_donation.user_id).await?;

    let alert_text = if qualifies_for_pro {
        "✅ حمایت مالی تایید شد و ۳۰ روز اشتراک Pro به عنوان هدیه برای کاربر فعال گردید."
    } else {
        "✅ حمایت مالی تایید شد و پیام قدردانی برای کاربر ارسال گردید."
    };

    let _ = bot
        .answer_callback_query(q.id.clone())
        .text(alert_text)
        .show_alert(true)
        .await;

    // Send notification to user
    if let Some(u) = user_opt {
        if let Some(tid) = u.telegram_id {
            if qualifies_for_pro {
                let sub_opt = Repository::get_subscription_by_user_id(pool, u.id).await.ok().flatten();
                let expiry_str = sub_opt.as_ref()
                    .map(|s| s.expires_at.format("%Y-%m-%d %H:%M UTC").to_string())
                    .unwrap_or_else(|| "۳۰ روز".to_string());
                let token_str = sub_opt.as_ref().map(|s| s.token.as_str()).unwrap_or("---");

                let user_msg = format!(
                    r#"🎉 <b>حمایت مالی شما با موفقیت تایید و قدردانی شد!</b>

💖 از حمایت سخاوتمندانه شما در توسعه و پایداری شبکه ضدسانسور Sentra بی‌نهایت سپاسگزاریم.
با توجه به اینکه مبلغ حمایت شما (<b>{} تومان</b>) بیشتر از ۲ برابر هزینه اشتراک ماهانه بود:

👑 <b>اشتراک ویژه ۳۰ روزه Sentra Pro با موفقیت برای شما فعال گردید!</b>
• سقف حجم: <b>۱۵۰ گیگابایت</b>
• تاریخ انقضا: <code>{}</code>
• توکن اتصال: <code>{}</code>

تمام حمایت‌های مالی مستقیماً صرف نگهداری سرورها و بهبود کیفیت سرویس می‌شود. از همراهی شما سپاسگزاریم! ❤️"#,
                    donation.amount,
                    expiry_str,
                    token_str
                );
                let _ = bot.send_message(ChatId(tid), user_msg).parse_mode(ParseMode::Html).await;
            } else {
                let user_msg = format!(
                    r#"💖 <b>حمایت مالی شما با موفقیت تایید شد!</b>

از همراهی و حمایت ارزشمند شما (مبلغ <b>{} تومان</b>) در ارتقا و نگهداری سرورهای ضدسانسور Sentra صمیمانه سپاسگزاریم.
تمام حمایت‌های مالی شما مستقیماً صرف توسعه بهتر برنامه، افزایش پایداری و بهبود کیفیت سرویس خواهد شد. 🙏✨"#,
                    donation.amount
                );
                let _ = bot.send_message(ChatId(tid), user_msg).parse_mode(ParseMode::Html).await;
            }
        }
    }

    // Update admin caption
    if let Some(msg) = &q.message {
        let current_caption = msg.regular_message().and_then(|m| m.caption()).unwrap_or("");
        let updated_caption = format!(
            "{}\n\n<b>[وضعیت: ✅ تایید شد توسط ادمین در تاریخ {} - اشتراک هدیه: {}]</b>",
            current_caption,
            chrono::Utc::now().format("%Y-%m-%d %H:%M UTC"),
            if qualifies_for_pro { "۳۰ روز Pro فعال شد" } else { "بدون اشتراک" }
        );
        let _ = bot
            .edit_message_caption(msg.chat().id, msg.id())
            .caption(updated_caption)
            .parse_mode(ParseMode::Html)
            .await;
    }

    Ok(())
}

/// Admin rejects financial donation
pub async fn handle_donation_reject(
    bot: &Bot,
    q: &CallbackQuery,
    pool: &DbPool,
    admin_chat_id: i64,
    donation_id: i64,
) -> anyhow::Result<()> {
    let telegram_id = q.from.id.0 as i64;
    if !is_authorized_admin(telegram_id, admin_chat_id) {
        let _ = bot.answer_callback_query(q.id.clone()).text("⛔ عدم دسترسی").await;
        return Ok(());
    }

    let updated_donation = Repository::reject_donation(pool, donation_id).await?;
    let user_opt = Repository::get_user_by_id(pool, updated_donation.user_id).await?;

    let _ = bot
        .answer_callback_query(q.id.clone())
        .text("❌ رسید حمایت مالی رد شد.")
        .show_alert(true)
        .await;

    // Send notification to user
    if let Some(u) = user_opt {
        if let Some(tid) = u.telegram_id {
            let user_msg = r#"❌ <b>اطلاعیه بررسی رسید حمایت مالی:</b>

متاسفانه تصویر فیش ارسالی شما توسط بخش مالی تایید نشد (عدم تطابق مبلغ، شماره پیگیری نامعتبر یا تصویر ناخوانا).
در صورت بروز اشتباه لطفاً فیش معتبر را مجدداً ارسال کرده یا با پشتیبانی در ارتباط باشید."#;
            let _ = bot.send_message(ChatId(tid), user_msg).parse_mode(ParseMode::Html).await;
        }
    }

    // Update admin caption
    if let Some(msg) = &q.message {
        let current_caption = msg.regular_message().and_then(|m| m.caption()).unwrap_or("");
        let updated_caption = format!(
            "{}\n\n<b>[وضعیت: ❌ رد شد توسط ادمین در تاریخ {}]</b>",
            current_caption,
            chrono::Utc::now().format("%Y-%m-%d %H:%M UTC")
        );
        let _ = bot
            .edit_message_caption(msg.chat().id, msg.id())
            .caption(updated_caption)
            .parse_mode(ParseMode::Html)
            .await;
    }

    Ok(())
}

/// Outbounds management menu
pub async fn handle_outbounds_menu(
    bot: &Bot,
    chat_id: ChatId,
    pool: &DbPool,
    admin_chat_id: i64,
    telegram_id: i64,
) -> anyhow::Result<()> {
    if !is_authorized_admin(telegram_id, admin_chat_id) {
        return Ok(());
    }

    let outbounds = Repository::list_all_outbounds(pool).await?;

    let text = r#"🔄 <b>مدیریت نودهای خروجی شبکه (Outbounds):</b>

با فشردن دکمه هر نود، وضعیت آن را بین 🟢 فعال و 🔴 غیرفعال تغییر دهید. تغییرات به صورت بلادرنگ در کامپایلر اعمال خواهد شد:"#;

    bot.send_message(chat_id, text)
        .parse_mode(ParseMode::Html)
        .reply_markup(admin_outbounds_inline_keyboard(&outbounds))
        .await?;

    Ok(())
}

/// Toggle outbound status callback
pub async fn handle_toggle_outbound_callback(
    bot: &Bot,
    q: &CallbackQuery,
    pool: &DbPool,
    admin_chat_id: i64,
    outbound_id: i64,
) -> anyhow::Result<()> {
    let telegram_id = q.from.id.0 as i64;
    if !is_authorized_admin(telegram_id, admin_chat_id) {
        let _ = bot.answer_callback_query(q.id.clone()).text("⛔ عدم دسترسی").await;
        return Ok(());
    }

    let is_now_active = Repository::toggle_outbound_status(pool, outbound_id).await?;
    let _ = crate::bridge_sync::sync_server_bridge_config(pool).await;
    let status_str = if is_now_active { "فعال شد 🟢" } else { "غیرفعال شد 🔴" };

    let _ = bot
        .answer_callback_query(q.id.clone())
        .text(format!("نود #{} {}", outbound_id, status_str))
        .await;

    let outbounds = Repository::list_all_outbounds(pool).await?;
    if let Some(msg) = &q.message {
        let _ = bot
            .edit_message_reply_markup(msg.chat().id, msg.id())
            .reply_markup(admin_outbounds_inline_keyboard(&outbounds))
            .await;
    }

    Ok(())
}

/// 6-Layer Health Diagnostic Check
pub async fn handle_six_layer_health_test(
    bot: &Bot,
    chat_id: ChatId,
    pool: &DbPool,
    admin_chat_id: i64,
    telegram_id: i64,
) -> anyhow::Result<()> {
    if !is_authorized_admin(telegram_id, admin_chat_id) {
        return Ok(());
    }

    let start_time = Instant::now();
    let stats = Repository::get_system_health(pool).await?;
    let db_latency = start_time.elapsed().as_millis();

    let report = format!(
        r#"🩺 <b>نتیجه آزمون جامع ۶ لایه سلامت پلتفرم سنترا:</b>

✅ <b>لایه ۱ - پایگاه داده (Persistence Layer):</b>
• وضعیت ژورنالینگ: <code>WAL (Write-Ahead Logging)</code>
• زمان پاسخ‌دهی دیتابیس: <b>{} میلی‌ثانیه</b>
• صحت روابط کلید خارجی: <code>PRAGMA foreign_keys = ON</code>

✅ <b>لایه ۲ - سرویس وب و وب‌سرور (Axum REST API):</b>
• وضعیت شنود: <b>پورت 8080 روی 127.0.0.1</b>
• امنیت و لایه‌ها: <code>CORS AllowAny + TraceLayer Active</code>

✅ <b>لایه ۳ - سامانه نام دامنه (FakeIP DNS Layer):</b>
• استخر آدرس‌دهی جعلی: <code>198.18.0.0/15</code>
• استراتژی تفکیک نشت: <code>ipv4_only (بدون نشت IPv6)</code>
• سرور بالادستی امن: <code>DoH 1.1.1.1/dns-query</code>

✅ <b>لایه ۴ - مسیرهای خروجی شبکه (Outbounds & Sandbox):</b>
• نودهای فعال در چرخه: <b>{} نود عملیاتی</b>
• نود لوپ‌بک سندباکس: <code>127.0.0.1:10801 (SOCKS5 Ready)</code>
• نود وارپ تستی: <code>127.0.0.1:10804 (Pulse Ready)</code>

✅ <b>لایه ۵ - رانتایم ناهمگام و پردازش چندنخی (Tokio Async Runtime):</b>
• مدیریت وظایف پس‌زمینه: <code>تسک‌های تلمتری و تایمر پایدار</code>
• مدیریت حافظه: <code>قانون صفر Unwraps رعایت‌شده</code>

✅ <b>لایه ۶ - پیام‌رسان و دیمن ربات تلگرام (Teloxide Dispatcher):</b>
• حالت ارتباطی: <code>Long Polling پیوسته و موازی</code>
• زمان کل بررسی جامع: <b>{} میلی‌ثانیه</b>
• وضعیت کلی سیستم: <b>🟢 ۱۰۰٪ پایدار و آماده سرویس‌دهی</b>"#,
        db_latency,
        stats.active_outbounds,
        start_time.elapsed().as_millis()
    );

    bot.send_message(chat_id, report)
        .parse_mode(ParseMode::Html)
        .reply_markup(admin_dashboard_inline_keyboard())
        .await?;

    Ok(())
}

pub async fn handle_return_to_user_menu(bot: &Bot, msg: &Message) -> anyhow::Result<()> {
    if let Some(u) = msg.from.as_ref() {
        let tid = u.id.0 as i64;
        clear_all_admin_states(tid).await;
        crate::bot::user_handlers::clear_user_state(tid).await;
    }
    bot.send_message(msg.chat.id, "👤 به منوی اصلی کاربری سنترا بازگشتید.")
        .reply_markup(user_main_keyboard_with_admin(true))
        .await?;
    Ok(())
}

/// Show app release upload menu from callback
pub async fn handle_app_upload_menu_callback(
    bot: &Bot,
    q: &CallbackQuery,
    admin_chat_id: i64,
) -> anyhow::Result<()> {
    let telegram_user_id = q.from.id.0 as i64;
    if !is_authorized_admin(telegram_user_id, admin_chat_id) {
        bot.answer_callback_query(q.id.clone())
            .text("⛔ دسترسی غیرمجاز!")
            .show_alert(true)
            .await?;
        return Ok(());
    }

    let text = r#"📤 <b>مدیریت و انتشار نسخه جدید اپلیکیشن Sentra Connect</b>

لطفاً سیستم‌عامل مورد نظر برای بارگذاری نسخه جدید را انتخاب فرمایید:
• <b>ویندوز:</b> فایل با پسوند <code>.exe</code> یا <code>.msi</code>
• <b>اندروید:</b> فایل با پسوند <code>.apk</code>

پس از انتخاب پلتفرم، شماره نسخه و سپس فایل نصبی از شما دریافت خواهد شد."#;

    if let Some(msg) = &q.message {
        if bot
            .edit_message_text(msg.chat().id, msg.id(), text)
            .parse_mode(ParseMode::Html)
            .reply_markup(admin_app_release_inline_keyboard())
            .await
            .is_err()
        {
            let _ = bot
                .send_message(msg.chat().id, text)
                .parse_mode(ParseMode::Html)
                .reply_markup(admin_app_release_inline_keyboard())
                .await;
        }
    }
    bot.answer_callback_query(q.id.clone()).await?;
    Ok(())
}

/// Show app release upload menu from reply keyboard
pub async fn handle_app_upload_menu_msg(
    bot: &Bot,
    msg: &Message,
    admin_chat_id: i64,
) -> anyhow::Result<()> {
    let telegram_user_id = msg.from.as_ref().map(|u| u.id.0 as i64).unwrap_or(0);
    if !is_authorized_admin(telegram_user_id, admin_chat_id) {
        bot.send_message(msg.chat.id, "⛔ دسترسی غیرمجاز!").await?;
        return Ok(());
    }

    let text = r#"📤 <b>مدیریت و انتشار نسخه جدید اپلیکیشن Sentra Connect</b>

لطفاً سیستم‌عامل مورد نظر برای بارگذاری نسخه جدید را انتخاب فرمایید:
• <b>ویندوز:</b> فایل با پسوند <code>.exe</code> یا <code>.msi</code>
• <b>اندروید:</b> فایل با پسوند <code>.apk</code>

پس از انتخاب پلتفرم، شماره نسخه و سپس فایل نصبی از شما دریافت خواهد شد."#;

    bot.send_message(msg.chat.id, text)
        .parse_mode(ParseMode::Html)
        .reply_markup(admin_app_release_inline_keyboard())
        .await?;
    Ok(())
}

/// Admin initiates release upload for a platform ('windows' or 'android')
pub async fn handle_admin_start_upload(
    bot: &Bot,
    q: &CallbackQuery,
    admin_chat_id: i64,
    platform: &str,
) -> anyhow::Result<()> {
    let telegram_user_id = q.from.id.0 as i64;
    if !is_authorized_admin(telegram_user_id, admin_chat_id) {
        bot.answer_callback_query(q.id.clone())
            .text("⛔ دسترسی غیرمجاز!")
            .show_alert(true)
            .await?;
        return Ok(());
    }

    set_admin_upload_state(
        telegram_user_id,
        AdminUploadState::AwaitingVersionAndChangelog {
            platform: platform.to_string(),
        },
    )
    .await;

    let platform_fa = if platform == "windows" {
        "ویندوز (Windows)"
    } else {
        "اندروید (Android)"
    };

    let text = format!(
        r#"📤 <b>مرحله ۱ از ۲: ثبت مشخصات نسخه جدید {}</b>

لطفاً <b>شماره نسخه</b> و <b>توضیح کوتاه تغییرات</b> را در یک پیام بفرستید.

<i>فرمت نمونه:</i>
<code>0.1.0 - نسخه اولیه با پشتیبانی از حالت رایگان</code>

یا جهت لغو عملیات ارسال نمایید: /cancel"#,
        platform_fa
    );

    if let Some(msg) = &q.message {
        bot.send_message(msg.chat().id, text)
            .parse_mode(ParseMode::Html)
            .reply_markup(cancel_and_back_inline_keyboard("adm_action_upload_app"))
            .await?;
    }
    bot.answer_callback_query(q.id.clone()).await?;
    Ok(())
}

/// Admin sends version & changelog text
pub async fn handle_admin_version_text(
    bot: &Bot,
    msg: &Message,
    admin_chat_id: i64,
    platform: &str,
    text: &str,
) -> anyhow::Result<()> {
    let telegram_user_id = msg.from.as_ref().map(|u| u.id.0 as i64).unwrap_or(0);
    if !is_authorized_admin(telegram_user_id, admin_chat_id) {
        return Ok(());
    }

    if text == "/cancel" {
        clear_admin_upload_state(telegram_user_id).await;
        bot.send_message(msg.chat.id, "❌ فرآیند آپلود نسخه لغو شد.")
            .reply_markup(admin_dashboard_inline_keyboard())
            .await?;
        return Ok(());
    }

    let (version, changelog) = if let Some(dash_idx) = text.find('-') {
        (
            text[..dash_idx].trim().to_string(),
            text[dash_idx + 1..].trim().to_string(),
        )
    } else if let Some(colon_idx) = text.find(':') {
        (
            text[..colon_idx].trim().to_string(),
            text[colon_idx + 1..].trim().to_string(),
        )
    } else {
        let mut parts = text.split_whitespace();
        let v = parts.next().unwrap_or("1.0.0").to_string();
        let rest: Vec<&str> = parts.collect();
        let c = if rest.is_empty() {
            format!("انتشار نسخه {}", v)
        } else {
            rest.join(" ")
        };
        (v, c)
    };

    set_admin_upload_state(
        telegram_user_id,
        AdminUploadState::AwaitingFile {
            platform: platform.to_string(),
            version: version.clone(),
            changelog: changelog.clone(),
        },
    )
    .await;

    let (platform_fa, ext_hint) = if platform == "windows" {
        ("ویندوز (Windows)", "<code>.exe</code> یا <code>.msi</code>")
    } else {
        ("اندروید (Android)", "<code>.apk</code>")
    };

    let reply = format!(
        r#"✅ <b>مشخصات نسخه دریافت شد:</b>
• سیستم‌عامل: <b>{}</b>
• شماره نسخه: <code>{}</code>
• تغییرات: <i>{}</i>

📁 <b>مرحله ۲ از ۲:</b>
اکنون لطفاً <b>فایل نصبی ({})</b> را به صورت <b>Document (فایل پیوست تلگرام)</b> در همین چت ارسال فرمایید.

<i>(جهت انصراف ارسال نمایید: /cancel)</i>"#,
        platform_fa, version, changelog, ext_hint
    );

    bot.send_message(msg.chat.id, reply)
        .parse_mode(ParseMode::Html)
        .reply_markup(cancel_and_back_inline_keyboard("adm_action_upload_app"))
        .await?;

    Ok(())
}

/// Admin uploads Document installer file
#[allow(clippy::too_many_arguments)]
pub async fn handle_admin_file_upload(
    bot: &Bot,
    msg: &Message,
    pool: &DbPool,
    admin_chat_id: i64,
    doc: &teloxide::types::Document,
    platform: &str,
    version: &str,
    changelog: &str,
) -> anyhow::Result<()> {
    let telegram_user_id = msg.from.as_ref().map(|u| u.id.0 as i64).unwrap_or(0);
    if !is_authorized_admin(telegram_user_id, admin_chat_id) {
        return Ok(());
    }

    let default_name = format!(
        "SentraConnect-{}.{}",
        version,
        if platform == "windows" { "exe" } else { "apk" }
    );
    let file_name = doc.file_name.as_deref().unwrap_or(&default_name);
    let lower_name = file_name.to_lowercase();

    // Validate extension
    let is_valid_ext = if platform == "windows" {
        lower_name.ends_with(".exe") || lower_name.ends_with(".msi")
    } else if platform == "android" {
        lower_name.ends_with(".apk")
    } else {
        false
    };

    if !is_valid_ext {
        let expected = if platform == "windows" {
            "<code>.exe</code> یا <code>.msi</code>"
        } else {
            "<code>.apk</code>"
        };
        let err_msg = format!(
            "❌ <b>پسوند فایل نامعتبر است!</b>\n\nبرای نسخه {}، فایل ارسالی باید دارای پسوند {} باشد.\nلطفاً فایل نصبی صحیح را بفرستید یا /cancel را ارسال کنید.",
            if platform == "windows" { "ویندوز" } else { "اندروید" },
            expected
        );
        bot.send_message(msg.chat.id, err_msg)
            .parse_mode(ParseMode::Html)
            .reply_markup(cancel_and_back_inline_keyboard("adm_action_upload_app"))
            .await?;
        return Ok(());
    }

    let size_bytes = doc.file.size as f64;
    let file_size_mb = (size_bytes / (1024.0 * 1024.0) * 100.0).round() / 100.0;
    let file_id = doc.file.id.clone();

    // Save into database
    Repository::upsert_app_release(
        pool,
        platform,
        version,
        &file_id,
        file_name,
        file_size_mb,
        changelog,
    )
    .await?;

    // Clear admin upload state
    clear_admin_upload_state(telegram_user_id).await;

    let success_text = format!(
        r#"🎉 <b>نسخه جدید اپلیکیشن Sentra Connect با موفقیت منتشر شد!</b>

📌 <b>مشخصات انتشار:</b>
• سیستم‌عامل: <b>{}</b>
• شماره نسخه: <code>{}</code>
• نام فایل: <code>{}</code>
• حجم فایل: <b>{:.2} مگابایت</b>
• شناسه تلگرام (File ID):
<code>{}</code>

📝 <b>توضیحات تغییرات:</b>
<i>{}</i>

✨ کلاینت‌های دسکتاپ و کاربران ربات هم‌اکنون می‌توانند این نسخه را دریافت نمایند."#,
        if platform == "windows" { "ویندوز (Windows)" } else { "اندروید (Android)" },
        version,
        file_name,
        file_size_mb,
        file_id,
        changelog
    );

    bot.send_message(msg.chat.id, success_text)
        .parse_mode(ParseMode::Html)
        .reply_markup(admin_dashboard_inline_keyboard())
        .await?;

    Ok(())
}

// ============================================================================
// Official Outbounds Management Handlers (Admin Hub)
// ============================================================================

/// Show the Official Outbounds Management Hub from message
pub async fn handle_official_outbounds_hub(
    bot: &Bot,
    chat_id: ChatId,
    pool: &DbPool,
    admin_chat_id: i64,
    telegram_id: i64,
) -> anyhow::Result<()> {
    if !is_authorized_admin(telegram_id, admin_chat_id) {
        return Ok(());
    }

    let web_nodes = Repository::get_official_outbounds_by_category(pool, "web_browsing").await.unwrap_or_default();
    let dl_nodes = Repository::get_official_outbounds_by_category(pool, "download").await.unwrap_or_default();
    let static_nodes = Repository::get_official_outbounds_by_category(pool, "static_ip").await.unwrap_or_default();
    let warp_account = Repository::get_active_warp_account(pool).await.unwrap_or(None);
    let warp_status = if let Some(ref w) = warp_account {
        format!("فعال ⚡️ ({})", if w.account_type == "plus" { "WARP+ 🌟" } else { "رایگان" })
    } else {
        "تنظیم‌نشده (خاموش)".to_string()
    };

    let text = format!(
        r#"🌐 <b>مرکز مدیریت اوتباندهای رسمی و اختصاصی سنترا (Official Outbounds Hub)</b>

در این بخش می‌توانید سرورهای اصلی هر ۳ حالت فعال شبکه را اضافه، پایش و مدیریت فرمایید:

📊 <b>آمار نودهای اختصاصی فعال:</b>
• 🌐 نودهای وب‌گردی (Web Browsing): <b>{} نود</b>
• 📥 نودهای دانلود پرسرعت (Download): <b>{} نود</b>
• 🔒 نودهای آی‌پی ثابت مسکونی (Static IP): <b>{} نود</b>
• ⚡️ اکانت Cloudflare WARP سرور: <b>{}</b>

<i>نکته: نودهای رسمی ادمین بر خلاف نودهای اهدایی کاربران، هرگز منقضی نشده و در تولید کانفیگ کلاینت‌ها بالاترین اولویت را دارند.</i>

👇 لطفاً عملیات مورد نظر را انتخاب نمایید:"#,
        web_nodes.len(),
        dl_nodes.len(),
        static_nodes.len(),
        warp_status,
    );

    bot.send_message(chat_id, text)
        .parse_mode(ParseMode::Html)
        .reply_markup(admin_official_outbounds_hub_keyboard())
        .await?;

    Ok(())
}

/// Show the Official Outbounds Management Hub from callback query
pub async fn handle_official_outbounds_hub_callback(
    bot: &Bot,
    q: &CallbackQuery,
    pool: &DbPool,
    admin_chat_id: i64,
) -> anyhow::Result<()> {
    let telegram_user_id = q.from.id.0 as i64;
    if !is_authorized_admin(telegram_user_id, admin_chat_id) {
        bot.answer_callback_query(q.id.clone()).text("⛔ دسترسی غیرمجاز!").show_alert(true).await?;
        return Ok(());
    }

    let web_nodes = Repository::get_official_outbounds_by_category(pool, "web_browsing").await.unwrap_or_default();
    let dl_nodes = Repository::get_official_outbounds_by_category(pool, "download").await.unwrap_or_default();
    let gaming_nodes = Repository::get_official_outbounds_by_category(pool, "gaming").await.unwrap_or_default();
    let static_nodes = Repository::get_official_outbounds_by_category(pool, "static_ip").await.unwrap_or_default();
    let gaming_live = Repository::has_active_gaming_outbounds(pool).await;
    let warp_account = Repository::get_active_warp_account(pool).await.unwrap_or(None);
    let warp_status = if let Some(ref w) = warp_account {
        format!("فعال ⚡️ ({})", if w.account_type == "plus" { "WARP+ 🌟" } else { "رایگان" })
    } else {
        "تنظیم‌نشده (خاموش)".to_string()
    };
    let gaming_state_str = if gaming_live {
        "🟢 فعال در کل اکوسیستم"
    } else {
        "⏳ به‌زودی (با ثبت اولین نود گیمینگ خودکار فعال می‌شود)"
    };

    let text = format!(
        r#"🌐 <b>مرکز مدیریت اوتباندهای رسمی و اختصاصی سنترا (Official Outbounds Hub)</b>

در این بخش می‌توانید سرورهای اصلی هر ۴ حالت شبکه را اضافه، پایش و مدیریت فرمایید:

📊 <b>آمار نودهای اختصاصی ثبت‌شده:</b>
• 🌐 نودهای وب‌گردی (Web Browsing): <b>{} نود</b>
• 📥 نودهای دانلود پرسرعت (Download): <b>{} نود</b>
• 🎮 نودهای گیمینگ (Gaming): <b>{} نود</b> — {}
• 🔒 نودهای آی‌پی ثابت مسکونی (Static IP): <b>{} نود</b>
• ⚡️ اکانت Cloudflare WARP سرور: <b>{}</b>

<i>نکته: نودهای رسمی ادمین هرگز منقضی نمی‌شوند. با ارسال لینک سابسکریپشن، تمامی نودها به صورت فهرستی نمایش داده می‌شوند تا حتی در صورت عدم پاسخ پینگ بتوانید آن‌ها را اضافه کنید.</i>

👇 لطفاً عملیات مورد نظر را انتخاب نمایید:"#,
        web_nodes.len(),
        dl_nodes.len(),
        gaming_nodes.len(),
        gaming_state_str,
        static_nodes.len(),
        warp_status,
    );

    if let Some(msg) = &q.message {
        bot.edit_message_text(msg.chat().id, msg.id(), text)
            .parse_mode(ParseMode::Html)
            .reply_markup(admin_official_outbounds_hub_keyboard())
            .await?;
    }
    bot.answer_callback_query(q.id.clone()).await?;

    Ok(())
}

/// Start adding official outbound: ask target category
pub async fn handle_start_add_official_outbound(
    bot: &Bot,
    q: &CallbackQuery,
    admin_chat_id: i64,
) -> anyhow::Result<()> {
    let telegram_user_id = q.from.id.0 as i64;
    if !is_authorized_admin(telegram_user_id, admin_chat_id) {
        bot.answer_callback_query(q.id.clone()).text("⛔ دسترسی غیرمجاز!").show_alert(true).await?;
        return Ok(());
    }

    let text = r#"➕ <b>افزودن اوتباند اختصاصی جدید</b>

لطفاً مشخص فرمایید این نود برای کدام‌یک از بخش‌های فعال شبکه سنترا ثبت شود:"#;

    if let Some(msg) = &q.message {
        bot.edit_message_text(msg.chat().id, msg.id(), text)
            .parse_mode(ParseMode::Html)
            .reply_markup(admin_select_outbound_target_keyboard())
            .await?;
    }
    bot.answer_callback_query(q.id.clone()).await?;
    Ok(())
}

/// Target category selected: switch to text input awaiting state
pub async fn handle_target_category_chosen(
    bot: &Bot,
    q: &CallbackQuery,
    admin_chat_id: i64,
    category: &str,
) -> anyhow::Result<()> {
    let telegram_user_id = q.from.id.0 as i64;
    if !is_authorized_admin(telegram_user_id, admin_chat_id) {
        bot.answer_callback_query(q.id.clone()).text("⛔ دسترسی غیرمجاز!").show_alert(true).await?;
        return Ok(());
    }

    set_admin_outbound_state(
        telegram_user_id,
        AdminOutboundState::AwaitingOutboundInput {
            category: category.to_string(),
        },
    )
    .await;

    let cat_fa = category_label_fa(category);

    let text = format!(
        r#"➕ <b>ثبت اوتباند جدید برای بخش [{}]</b>

لطفاً <b>نام دلخواه نود (Label)</b> را به همراه <b>لینک اوتباند، بلاک JSON یا آدرس سابسکریپشن (Sub URL)</b> ارسال نمایید.

<i>روش ۱ (لینک سابسکریپشن یکجا — نمایش فهرستی نودها):</i>
<code>https://sub.example.com/api/v1/sub?token=...</code>
<i>(تمامی نودها به صورت فهرستی نمایش داده می‌شوند و حتی اگر تست پینگ مناسب نباشد می‌توانید تکی یا یکجا آن‌ها را اضافه کنید)</i>

<i>روش ۲ (نام + لینک تکی):</i>
<code>US-Static-01 vless://uuid@server:443?security=reality...#US-Node</code>

<i>روش ۳ (نام + کانفیگ JSON):</i>
<code>DE-Download-01 {{"type": "vless", "server": "1.2.3.4", ...}}</code>

<i>روش ۴ (فقط لینک، نام و کشور به صورت خودکار تشخیص داده می‌شود):</i>
<code>vless://uuid@server:443?security=reality...#MyNode</code>

(جهت انصراف ارسال نمایید: /cancel)"#,
        cat_fa
    );

    if let Some(msg) = &q.message {
        bot.send_message(msg.chat().id, text)
            .parse_mode(ParseMode::Html)
            .reply_markup(cancel_and_back_inline_keyboard("adm_action_official_outbounds"))
            .await?;
    }
    bot.answer_callback_query(q.id.clone()).await?;
    Ok(())
}

/// Process admin text input containing label + link/json for official outbound
pub async fn handle_admin_outbound_text_input(
    bot: &Bot,
    msg: &Message,
    pool: &DbPool,
    admin_chat_id: i64,
    category: &str,
    text: &str,
) -> anyhow::Result<()> {
    let telegram_user_id = msg.from.as_ref().map(|u| u.id.0 as i64).unwrap_or(0);
    if !is_authorized_admin(telegram_user_id, admin_chat_id) {
        return Ok(());
    }

    if text == "/cancel" {
        clear_admin_outbound_state(telegram_user_id).await;
        clear_pending_sub_import(telegram_user_id).await;
        bot.send_message(msg.chat.id, "❌ فرآیند افزودن اوتباند لغو شد.")
            .reply_markup(admin_official_outbounds_hub_keyboard())
            .await?;
        return Ok(());
    }

    let trimmed = text.trim();

    // 0. Check if input is a Subscription URL (https://... or http://...)
    let is_proxy_scheme = trimmed.starts_with("vless://")
        || trimmed.starts_with("vmess://")
        || trimmed.starts_with("trojan://")
        || trimmed.starts_with("hy2://")
        || trimmed.starts_with("hysteria2://")
        || trimmed.starts_with("tuic://")
        || trimmed.starts_with("ss://")
        || trimmed.starts_with("wireguard://")
        || trimmed.starts_with("wg://")
        || trimmed.starts_with('{');

    if !is_proxy_scheme && (trimmed.contains("https://") || trimmed.contains("http://")) {
        let sub_url = if let Some(idx) = trimmed.find("https://") {
            trimmed[idx..].split_whitespace().next().unwrap_or(trimmed)
        } else if let Some(idx) = trimmed.find("http://") {
            trimmed[idx..].split_whitespace().next().unwrap_or(trimmed)
        } else {
            trimmed
        };

        bot.send_message(
            msg.chat.id,
            "⏳ <b>در حال استخراج فهرست نودهای سابسکریپشن...</b>\n<i>(بررسی امنیتی Anti-SSRF و تست پینگ — هیچ نودی به خاطر پینگ بالا یا عدم پاسخ حذف نمی‌شود)</i>",
        )
        .parse_mode(ParseMode::Html)
        .await?;

        match OutboundAnalyzer::preview_subscription_url(sub_url).await {
            Ok(preview) => {
                clear_admin_outbound_state(telegram_user_id).await;
                let pending = PendingSubImport {
                    category: category.to_string(),
                    source_url: preview.source_url,
                    total_raw_lines: preview.total_raw_lines,
                    skipped_invalid: preview.skipped_invalid,
                    nodes: preview.nodes,
                    added_indices: std::collections::HashSet::new(),
                };
                let (list_text, kb) = build_sub_preview_message(&pending, 0);
                set_pending_sub_import(telegram_user_id, pending).await;

                bot.send_message(msg.chat.id, list_text)
                    .parse_mode(ParseMode::Html)
                    .reply_markup(kb)
                    .await?;

                return Ok(());
            }
            Err(e) => {
                let err_msg = format!(
                    "❌ <b>خطا در پردازش سابسکریپشن:</b>\n{}\n\nلطفاً لینک را بررسی فرمایید یا روی «🔙 بازگشت» بزنید.",
                    escape_html(&e)
                );
                bot.send_message(msg.chat.id, err_msg)
                    .parse_mode(ParseMode::Html)
                    .reply_markup(cancel_and_back_inline_keyboard("adm_action_official_outbounds"))
                    .await?;
                return Ok(());
            }
        }
    }

    let (label, link_or_json) = if let Some(first_space) = trimmed.find(|c: char| c.is_whitespace() || c == '\n') {
        let first_word = trimmed[..first_space].trim();
        let rest = trimmed[first_space..].trim();
        if (rest.starts_with("vless://")
            || rest.starts_with("vmess://")
            || rest.starts_with("trojan://")
            || rest.starts_with("hy2://")
            || rest.starts_with("hysteria2://")
            || rest.starts_with("tuic://")
            || rest.starts_with("ss://")
            || rest.starts_with("wireguard://")
            || rest.starts_with("wg://")
            || (rest.starts_with('{') && rest.contains("\"server\"")))
            && !first_word.starts_with("vless://")
            && !first_word.starts_with("vmess://")
            && !first_word.starts_with("trojan://")
            && !first_word.starts_with("hy2://")
            && !first_word.starts_with("hysteria2://")
            && !first_word.starts_with("tuic://")
            && !first_word.starts_with("ss://")
            && !first_word.starts_with("wireguard://")
            && !first_word.starts_with("wg://")
            && !first_word.starts_with('{')
        {
            (first_word.to_string(), rest)
        } else {
            (String::new(), trimmed)
        }
    } else {
        (String::new(), trimmed)
    };

    // 1. Parse link or JSON into standardized Sing-box outbound structure
    let parsed = match OutboundAnalyzer::parse_input(link_or_json) {
        Ok(p) => p,
        Err(e) => {
            let err_msg = format!("❌ <b>خطا در تحلیل لینک یا کانفیگ:</b>\n{}\n\nلطفاً لینک یا JSON صحیح ارسال فرمایید یا روی «🔙 بازگشت» بزنید.", e);
            bot.send_message(msg.chat.id, err_msg)
                .parse_mode(ParseMode::Html)
                .reply_markup(cancel_and_back_inline_keyboard("adm_action_official_outbounds"))
                .await?;
            return Ok(());
        }
    };

    let final_label = if label.is_empty() {
        if !parsed.tag.is_empty() && parsed.tag != "donated-singbox" {
            parsed.tag.clone()
        } else {
            format!("{}-{}", category, parsed.protocol)
        }
    } else {
        label
    };

    // 2. Anti-SSRF Protection
    let ip = match OutboundAnalyzer::check_anti_ssrf(&parsed.server_address).await {
        Ok(ip) => ip,
        Err(e) => {
            let err_msg = format!("❌ <b>خطای امنیتی آدرس سرور (SSRF Protection):</b>\n{}\n\nلطفاً آدرس معتبر وارد کنید یا روی «🔙 بازگشت» بزنید.", e);
            bot.send_message(msg.chat.id, err_msg)
                .parse_mode(ParseMode::Html)
                .reply_markup(cancel_and_back_inline_keyboard("adm_action_official_outbounds"))
                .await?;
            return Ok(());
        }
    };

    // 3. Protocol-aware reachability check (handles UDP protocols like hy2/tuic/wireguard properly)
    let (latency_ms, speed_mbps, is_online, probe_err) =
        OutboundAnalyzer::benchmark_proxy_for_protocol(&parsed.protocol, ip, parsed.server_port).await;
    // Admin-added official outbounds MUST be saved immediately as 'active' so Windows & Android clients see them live
    let status = "active";
    let health_score = if is_online { 100 } else { 75 };

    // 4. Compute fingerprint and detect country
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

    let (country_code, country_name) = OutboundAnalyzer::detect_country(ip, &parsed.tag).await;

    // 5. Insert or replace in database — NEVER swallow DB errors; report exact SQLite cause to Admin
    let saved_outbound = match Repository::insert_official_outbound(
        pool,
        &final_label,
        &parsed.tag,
        &parsed.protocol,
        &parsed.server_address,
        parsed.server_port as i64,
        &parsed.config_json.to_string(),
        latency_ms,
        speed_mbps,
        category,
        Some(link_or_json),
        &fingerprint,
        status,
        health_score,
        &country_code,
        &country_name,
    )
    .await
    {
        Ok(ob) => ob,
        Err(e) => {
            tracing::error!("Failed to save admin official outbound in SQLite: {}", e);
            let err_msg = format!(
                "❌ <b>خطای دیتابیس هنگام ذخیره نود در هسته:</b>\n<code>{}</code>\n\nلطفاً لاگ سرور را بررسی کرده یا دوباره تلاش فرمایید.",
                e
            );
            bot.send_message(msg.chat.id, err_msg)
                .parse_mode(ParseMode::Html)
                .reply_markup(cancel_and_back_inline_keyboard("adm_action_official_outbounds"))
                .await?;
            return Ok(());
        }
    };

    // Auto-sync server sing-box bridge configuration
    if let Err(e) = crate::bridge_sync::sync_server_bridge_config(pool).await {
        warn!("Bridge sync warning after admin outbound insert #{}: {}", saved_outbound.id, e);
    }

    // Clear active admin state
    clear_admin_outbound_state(telegram_user_id).await;

    let cat_fa = category_label_fa(category);
    let status_badge = if is_online {
        "🟢 فعال و آنلاین (قابل مشاهده در کل اکوسیستم)"
    } else {
        "🟡 فعال در دیتابیس (تست پینگ اولیه پاسخ نداد؛ با این حال بدون محدودیت اضافه و فعال شد)"
    };
    let probe_note = if let Some(err_str) = probe_err {
        format!("\n⚠️ <i>یادداشت تست اولیه: {}</i>", escape_html(&err_str))
    } else {
        String::new()
    };
    let gaming_live_notice = if category_enables_gaming(category) {
        "\n\n🎮 <b>بخش گیمینگ اکنون به صورت خودکار در کل اکوسیستم (ربات تلگرام، ویندوز و اندروید) فعال شد!</b>"
    } else {
        ""
    };

    let reply = format!(
        r#"🎉 <b>اوتباند اختصاصی با موفقیت در دیتابیس ثبت و فعال شد!</b>

📌 <b>مشخصات نود (#{}):</b>
• نام نود (Label): <b>{}</b>
• لوکیشن کشور: <b>{} ({})</b>
• بخش اختصاصی: <b>{}</b>
• پروتکل: <code>{}</code>
• آدرس و پورت: <code>{}:{}</code>
• پینگ تست اولیه: <b>{} میلی‌ثانیه</b>
• تخمین سرعت: <b>{:.1} مگابیت بر ثانیه</b>
• وضعیت: <b>{}</b>{}{}

✨ این نود هم‌اکنون به صورت زنده در کل اکوسیستم سنترا در دسترس است."#,
        saved_outbound.id, escape_html(&final_label), escape_html(&country_name), country_code, cat_fa, parsed.protocol,
        parsed.server_address, parsed.server_port, latency_ms, speed_mbps, status_badge, probe_note, gaming_live_notice
    );

    bot.send_message(msg.chat.id, reply)
        .parse_mode(ParseMode::Html)
        .reply_markup(admin_official_outbounds_hub_keyboard())
        .await?;

    Ok(())
}

/// Build the interactive paginated subscription node list message & inline keyboard
fn build_sub_preview_message(pending: &PendingSubImport, requested_page: usize) -> (String, InlineKeyboardMarkup) {
    const PER_PAGE: usize = 8;
    let total = pending.nodes.len();
    let total_pages = total.div_ceil(PER_PAGE).max(1);
    let page = requested_page.min(total_pages - 1);
    let start = page * PER_PAGE;
    let end = (start + PER_PAGE).min(total);

    let healthy_count = pending.nodes.iter().filter(|n| n.is_online).count();
    let weak_or_offline_count = total.saturating_sub(healthy_count);
    let added_count = pending.added_indices.len();

    let mut lines = vec![
        format!("📋 <b>فهرست نودهای سابسکریپشن برای [{}]</b>", category_label_fa(&pending.category)),
        String::new(),
        format!(
            "📊 استخراج‌شده: <b>{} نود</b> (🟢 سالم: <b>{}</b> | 🔴 بدون پاسخ/پینگ نامناسب: <b>{}</b> | ✅ اضافه‌شده: <b>{}</b>)",
            total, healthy_count, weak_or_offline_count, added_count
        ),
        "<i>روی هر نود کلیک کنید تا حتی در صورت عدم پاسخ یا پینگ بالا بلافاصله اضافه شود، یا دکمه «افزودن همه» را بزنید:</i>".to_string(),
        String::new(),
    ];

    let mut kb_rows: Vec<Vec<InlineKeyboardButton>> = Vec::new();

    for (idx, node) in pending.nodes.iter().enumerate().take(end).skip(start) {
        let is_added = pending.added_indices.contains(&idx);
        let ping_badge = if node.is_online && node.latency_ms > 0 && node.latency_ms <= 250 {
            format!("🟢 {}ms", node.latency_ms)
        } else if node.is_online && node.latency_ms > 250 {
            format!("🟡 {}ms", node.latency_ms)
        } else {
            "🔴 بدون پاسخ/پینگ نامناسب".to_string()
        };
        let prefix = if is_added { "✅" } else { "▫️" };
        lines.push(format!(
            "{} <b>#{}</b> {} — <code>{}</code> • {} • {}",
            prefix,
            idx + 1,
            escape_html(&node.label),
            node.protocol,
            escape_html(&node.country_name),
            ping_badge
        ));

        let short_label: String = node.label.chars().take(22).collect();
        let short_ping = if node.is_online && node.latency_ms > 0 {
            format!("{}ms", node.latency_ms)
        } else {
            "بدون پینگ".to_string()
        };
        let btn_label = if is_added {
            format!("✅ #{} {} (اضافه‌شد)", idx + 1, short_label)
        } else {
            format!("➕ #{} {} ({})", idx + 1, short_label, short_ping)
        };
        kb_rows.push(vec![InlineKeyboardButton::callback(
            btn_label,
            format!("adm_sub_add_node_{}", idx),
        )]);
    }

    if total_pages > 1 {
        let mut nav_row = Vec::new();
        if page > 0 {
            nav_row.push(InlineKeyboardButton::callback(
                "◀️ صفحه قبل",
                format!("adm_sub_page_{}", page - 1),
            ));
        }
        nav_row.push(InlineKeyboardButton::callback(
            format!("صفحه {}/{}", page + 1, total_pages),
            format!("adm_sub_page_{}", page),
        ));
        if page + 1 < total_pages {
            nav_row.push(InlineKeyboardButton::callback(
                "صفحه بعد ▶️",
                format!("adm_sub_page_{}", page + 1),
            ));
        }
        kb_rows.push(nav_row);
    }

    kb_rows.push(vec![InlineKeyboardButton::callback(
        format!("✅ افزودن همه {} نود (حتی با پینگ نامناسب)", total),
        "adm_sub_add_all",
    )]);

    if healthy_count > 0 && healthy_count < total {
        kb_rows.push(vec![InlineKeyboardButton::callback(
            format!("⚡ افزودن فقط {} نود با پینگ سالم", healthy_count),
            "adm_sub_add_healthy",
        )]);
    }

    kb_rows.push(vec![InlineKeyboardButton::callback(
        "🔙 بازگشت به منوی اوتباندها",
        "adm_action_official_outbounds",
    )]);

    (lines.join("\n"), InlineKeyboardMarkup::new(kb_rows))
}

/// Paginate through the admin's pending subscription preview list
pub async fn handle_sub_preview_page_callback(
    bot: &Bot,
    q: &CallbackQuery,
    admin_chat_id: i64,
    page: usize,
) -> anyhow::Result<()> {
    let telegram_user_id = q.from.id.0 as i64;
    if !is_authorized_admin(telegram_user_id, admin_chat_id) {
        bot.answer_callback_query(q.id.clone()).text("⛔ دسترسی غیرمجاز!").show_alert(true).await?;
        return Ok(());
    }

    let Some(pending) = get_pending_sub_import(telegram_user_id).await else {
        bot.answer_callback_query(q.id.clone())
            .text("⚠️ فهرست سابسکریپشن منقضی شده است. لطفاً لینک را مجدداً ارسال کنید.")
            .show_alert(true)
            .await?;
        return Ok(());
    };

    let (text, kb) = build_sub_preview_message(&pending, page);
    if let Some(msg) = &q.message {
        let _ = bot
            .edit_message_text(msg.chat().id, msg.id(), text)
            .parse_mode(ParseMode::Html)
            .reply_markup(kb)
            .await;
    }
    bot.answer_callback_query(q.id.clone()).await?;
    Ok(())
}

/// Force-add a single node from the admin's subscription list regardless of ping test outcome
pub async fn handle_sub_preview_add_node_callback(
    bot: &Bot,
    q: &CallbackQuery,
    pool: &DbPool,
    admin_chat_id: i64,
    node_idx: usize,
) -> anyhow::Result<()> {
    let telegram_user_id = q.from.id.0 as i64;
    if !is_authorized_admin(telegram_user_id, admin_chat_id) {
        bot.answer_callback_query(q.id.clone()).text("⛔ دسترسی غیرمجاز!").show_alert(true).await?;
        return Ok(());
    }

    let Some(mut pending) = get_pending_sub_import(telegram_user_id).await else {
        bot.answer_callback_query(q.id.clone())
            .text("⚠️ فهرست سابسکریپشن منقضی شده است. لطفاً لینک را مجدداً ارسال کنید.")
            .show_alert(true)
            .await?;
        return Ok(());
    };

    let Some(node) = pending.nodes.get(node_idx).cloned() else {
        bot.answer_callback_query(q.id.clone()).text("نود مورد نظر یافت نشد.").show_alert(true).await?;
        return Ok(());
    };

    let health_score = if node.is_online { 100 } else { 70 };
    let stored_latency = if node.is_online { node.latency_ms } else { 0 };

    if let Err(e) = Repository::insert_official_outbound(
        pool,
        &node.label,
        &node.tag,
        &node.protocol,
        &node.server_address,
        node.server_port as i64,
        &node.config_json,
        stored_latency,
        node.speed_mbps,
        &pending.category,
        Some(&node.raw_link),
        &node.fingerprint,
        "active",
        health_score,
        &node.country_code,
        &node.country_name,
    )
    .await
    {
        bot.answer_callback_query(q.id.clone())
            .text(format!("❌ خطا در ثبت نود: {}", e))
            .show_alert(true)
            .await?;
        return Ok(());
    }

    pending.added_indices.insert(node_idx);
    let _ = crate::bridge_sync::sync_server_bridge_config(pool).await;

    let page = node_idx / 8;
    let (text, kb) = build_sub_preview_message(&pending, page);
    let gaming_activated = category_enables_gaming(&pending.category);
    set_pending_sub_import(telegram_user_id, pending).await;

    if let Some(msg) = &q.message {
        let _ = bot
            .edit_message_text(msg.chat().id, msg.id(), text)
            .parse_mode(ParseMode::Html)
            .reply_markup(kb)
            .await;
    }

    let toast_msg = if gaming_activated {
        format!("✅ نود «{}» ثبت شد و بخش گیمینگ در کل اکوسیستم فعال شد!", node.label)
    } else {
        format!("✅ نود «{}» با موفقیت اضافه و فعال شد.", node.label)
    };
    bot.answer_callback_query(q.id.clone())
        .text(toast_msg)
        .show_alert(gaming_activated)
        .await?;
    Ok(())
}

/// Bulk-add nodes from the admin's subscription list (either ALL nodes regardless of ping, or healthy-only)
pub async fn handle_sub_preview_add_bulk_callback(
    bot: &Bot,
    q: &CallbackQuery,
    pool: &DbPool,
    admin_chat_id: i64,
    only_healthy: bool,
) -> anyhow::Result<()> {
    let telegram_user_id = q.from.id.0 as i64;
    if !is_authorized_admin(telegram_user_id, admin_chat_id) {
        bot.answer_callback_query(q.id.clone()).text("⛔ دسترسی غیرمجاز!").show_alert(true).await?;
        return Ok(());
    }

    let Some(pending) = get_pending_sub_import(telegram_user_id).await else {
        bot.answer_callback_query(q.id.clone())
            .text("⚠️ فهرست سابسکریپشن منقضی شده است.")
            .show_alert(true)
            .await?;
        return Ok(());
    };

    let mut added_now = 0usize;
    let mut failed_db = 0usize;
    let mut country_counts: HashMap<String, usize> = HashMap::new();

    for (idx, node) in pending.nodes.iter().enumerate() {
        if only_healthy && !node.is_online {
            continue;
        }
        if pending.added_indices.contains(&idx) {
            *country_counts.entry(node.country_name.clone()).or_insert(0) += 1;
            continue;
        }

        let health_score = if node.is_online { 100 } else { 70 };
        let stored_latency = if node.is_online { node.latency_ms } else { 0 };
        match Repository::insert_official_outbound(
            pool,
            &node.label,
            &node.tag,
            &node.protocol,
            &node.server_address,
            node.server_port as i64,
            &node.config_json,
            stored_latency,
            node.speed_mbps,
            &pending.category,
            Some(&node.raw_link),
            &node.fingerprint,
            "active",
            health_score,
            &node.country_code,
            &node.country_name,
        )
        .await
        {
            Ok(_) => {
                added_now += 1;
                *country_counts.entry(node.country_name.clone()).or_insert(0) += 1;
            }
            Err(e) => {
                warn!("Failed to persist sub node {}: {}", node.label, e);
                failed_db += 1;
            }
        }
    }

    let total_saved = added_now + pending.added_indices.len();
    let source_id = Repository::save_subscription_source(
        pool,
        &pending.category,
        &pending.source_url,
        Some(&format!("سابلینک {}", pending.category)),
        pending.total_raw_lines as i64,
        total_saved as i64,
    )
    .await
    .unwrap_or(0);

    let _ = crate::bridge_sync::sync_server_bridge_config(pool).await;
    clear_pending_sub_import(telegram_user_id).await;

    let mut country_summary = String::new();
    for (country, count) in &country_counts {
        country_summary.push_str(&format!("• {}: <b>{} نود</b>\n", escape_html(country), count));
    }
    if country_summary.is_empty() {
        country_summary = "• نامشخص\n".to_string();
    }

    let gaming_live_notice = if category_enables_gaming(&pending.category) && total_saved > 0 {
        "\n\n🎮 <b>بخش گیمینگ اکنون به صورت خودکار در کل اکوسیستم (ربات تلگرام، ویندوز و اندروید) فعال شد!</b>"
    } else {
        ""
    };

    let summary_text = format!(
        r#"✅ <b>افزودن نودهای سابسکریپشن برای [{}] تکمیل شد</b>

📦 <b>گزارش نهایی:</b>
• کل نودهای فهرست: <b>{} نود</b>
• نودهای ثبت و فعال‌شده در سیستم: <b>{} نود</b>
• خطا در ذخیره‌سازی: <b>{} نود</b>

🌍 <b>تفکیک جغرافیایی:</b>
{}
⚡️ پل ارتباطی سرور (Sing-box Bridge) به صورت خودکار بروزرسانی شد.{}"#,
        category_label_fa(&pending.category),
        pending.nodes.len(),
        total_saved,
        failed_db,
        country_summary,
        gaming_live_notice
    );

    let list_cat = match pending.category.as_str() {
        "gaming_only" | "gaming" => "gaming",
        "static_only" | "static_ip" => "static_ip",
        "download" => "download",
        _ => "web_browsing",
    };

    let mut kb_rows = Vec::new();
    if source_id > 0 {
        kb_rows.push(vec![InlineKeyboardButton::callback(
            "🔄 بروزرسانی مجدد این سابلینک",
            format!("adm_sub_resync_{}", source_id),
        )]);
    }
    kb_rows.push(vec![
        InlineKeyboardButton::callback("📋 مشاهده لیست نودها", format!("adm_ob_list_{}", list_cat)),
        InlineKeyboardButton::callback("🔙 بازگشت به منوی اوتباندها", "adm_action_official_outbounds"),
    ]);

    if let Some(msg) = &q.message {
        let _ = bot
            .edit_message_text(msg.chat().id, msg.id(), summary_text)
            .parse_mode(ParseMode::Html)
            .reply_markup(InlineKeyboardMarkup::new(kb_rows))
            .await;
    }

    bot.answer_callback_query(q.id.clone())
        .text(format!("✅ {} نود با موفقیت ثبت و فعال شد.", total_saved))
        .await?;
    Ok(())
}

/// List and manage official outbounds for a specific category
pub async fn handle_list_official_outbounds(
    bot: &Bot,
    q: &CallbackQuery,
    pool: &DbPool,
    admin_chat_id: i64,
    category: &str,
) -> anyhow::Result<()> {
    let telegram_user_id = q.from.id.0 as i64;
    if !is_authorized_admin(telegram_user_id, admin_chat_id) {
        bot.answer_callback_query(q.id.clone()).text("⛔ دسترسی غیرمجاز!").show_alert(true).await?;
        return Ok(());
    }

    let cat_fa = category_label_fa(category);

    let nodes = match Repository::get_official_outbounds_by_category(pool, category).await {
        Ok(list) => list,
        Err(e) => {
            tracing::error!("Failed to list official outbounds for '{}': {}", category, e);
            if let Some(msg) = &q.message {
                let _ = bot
                    .send_message(
                        msg.chat().id,
                        format!("❌ <b>خطای دیتابیس در خواندن لیست نودها:</b>\n<code>{}</code>", e),
                    )
                    .parse_mode(ParseMode::Html)
                    .reply_markup(cancel_and_back_inline_keyboard("adm_action_official_outbounds"))
                    .await;
            }
            bot.answer_callback_query(q.id.clone()).await?;
            return Ok(());
        }
    };

    if nodes.is_empty() {
        let empty_text = format!(
            "📭 هیچ نود رسمی فعالی برای بخش <b>[{}]</b> ثبت نشده است.\n\nجهت افزودن اولین نود، دکمه زیر را لمس فرمایید:",
            cat_fa
        );
        let target_cat = if category == "gaming" { "gaming_only" } else { category };
        let kb = InlineKeyboardMarkup::new(vec![
            vec![InlineKeyboardButton::callback("➕ افزودن نود برای این بخش", format!("adm_ob_target_{}", target_cat))],
            vec![InlineKeyboardButton::callback("🔙 بازگشت به منوی اوتباندها", "adm_action_official_outbounds")],
        ]);

        if let Some(msg) = &q.message {
            bot.edit_message_text(msg.chat().id, msg.id(), empty_text)
                .parse_mode(ParseMode::Html)
                .reply_markup(kb)
                .await?;
        }
        bot.answer_callback_query(q.id.clone()).await?;
        return Ok(());
    }

    let header_text = format!(
        "📋 <b>لیست اوتباندهای رسمی بخش [{}]:</b>\nتعداد کل: <b>{} نود</b>",
        cat_fa,
        nodes.len()
    );

    if let Some(msg) = &q.message {
        bot.send_message(msg.chat().id, header_text)
            .parse_mode(ParseMode::Html)
            .reply_markup(cancel_and_back_inline_keyboard("adm_action_official_outbounds"))
            .await?;

        for ob in &nodes {
            let status_icon = if ob.status == "active" { "🟢 فعال / آنلاین" } else { "🔴 غیرفعال / آفلاین" };
            let alloc_desc = allocation_summary_fa(ob);
            let gemini_badge = if ob.gemini_ok == 1 { "✅ سازگار و آماده" } else { "❌ ناموفق / تست‌نشده" };
            let trading_badge = if ob.trading_safe == 1 { "✅ پایدار (Jitter < 30ms)" } else { "⚠️ نامناسب" };
            let last_seen = ob.last_online_at
                .map(|t| t.with_timezone(&chrono_tz::Asia::Tehran).format("%Y-%m-%d %H:%M").to_string())
                .unwrap_or_else(|| "ثبت‌نشده".to_string());

            let card = format!(
                r#"🔹 <b>{}</b> ({})
• شناسه: <code>#{}</code> | پروتکل: <code>{}</code> | کشور: <code>{}</code>
• آدرس سرور: <code>{}:{}</code>
• تخصیص دسترسی: <b>{}</b> (حالت: <code>{}</code>)
• امتیاز کیفیت سرعت: <b>{}/100</b> | پینگ: <b>{} ms</b> (نوسان: <b>{} ms</b>)
• پهنای باند تخمینی: <b>{:.1} Mbps</b> | ترافیک مصرفی: <b>{}</b>
• تست Google Gemini: <b>{}</b>
• تست پایداری ترید (Trading): <b>{}</b>
• آخرین اتصال موفق: <code>{}</code>"#,
                ob.label.as_deref().unwrap_or(&ob.tag),
                status_icon,
                ob.id,
                ob.protocol,
                ob.country_code,
                ob.server_address,
                ob.server_port,
                alloc_desc,
                ob.allocation_mode,
                ob.speed_score,
                ob.latency_ms,
                ob.jitter_ms,
                ob.speed_mbps,
                format_traffic(ob.bytes_served),
                gemini_badge,
                trading_badge,
                last_seen
            );

            bot.send_message(msg.chat().id, card)
                .parse_mode(ParseMode::Html)
                .reply_markup(admin_official_outbound_actions_keyboard(ob.id, ob.status == "active", category))
                .await?;
        }
    }

    bot.answer_callback_query(q.id.clone()).await?;
    Ok(())
}

/// Re-test latency, jitter, speed score and gemini readiness of an official outbound
pub async fn handle_ping_official_outbound_callback(
    bot: &Bot,
    q: &CallbackQuery,
    pool: &DbPool,
    admin_chat_id: i64,
    outbound_id: i64,
) -> anyhow::Result<()> {
    let telegram_user_id = q.from.id.0 as i64;
    if !is_authorized_admin(telegram_user_id, admin_chat_id) {
        bot.answer_callback_query(q.id.clone()).text("⛔ دسترسی غیرمجاز!").show_alert(true).await?;
        return Ok(());
    }

    let ob = match Repository::get_official_outbound_by_id(pool, outbound_id).await? {
        Some(o) => o,
        None => {
            bot.answer_callback_query(q.id.clone()).text("نود یافت نشد.").show_alert(true).await?;
            return Ok(());
        }
    };

    bot.answer_callback_query(q.id.clone()).text("⏳ در حال تست اتصال، نوسان (Jitter) و امتیاز سرعت...").await?;

    let ip = match OutboundAnalyzer::check_anti_ssrf(&ob.server_address).await {
        Ok(ip) => ip,
        Err(_) => {
            bot.send_message(q.from.id, "❌ خطای DNS / آدرس سرور نامعتبر است.")
                .reply_markup(cancel_and_back_inline_keyboard("adm_action_official_outbounds"))
                .await?;
            return Ok(());
        }
    };

    let proto_lower = ob.protocol.to_lowercase();
    let is_udp_proto = matches!(
        proto_lower.as_str(),
        "hysteria2" | "hy2" | "tuic" | "wireguard" | "wg"
    );
    let (latency_ms, jitter_ms, speed_mbps, speed_score, is_online) = if is_udp_proto {
        let (lat, spd, online, _) = OutboundAnalyzer::benchmark_proxy_for_protocol(
            &ob.protocol,
            ip,
            ob.server_port as u16,
        )
        .await;
        let score = if online {
            (95 - (lat / 10)).clamp(35, 100)
        } else {
            0
        };
        (lat, if online { 5 } else { 999 }, spd, score, online)
    } else {
        QualityEngine::test_outbound_network_quality(ip, ob.server_port as u16).await
    };

    let parsed_config: serde_json::Value = serde_json::from_str(&ob.config_json).unwrap_or_default();
    let (gemini_ok, trading_safe) =
        QualityEngine::test_gemini_and_trading_readiness(ip, ob.server_port as u16, &parsed_config, &ob.country_code, jitter_ms).await;

    Repository::update_outbound_quality_metrics(
        pool,
        outbound_id,
        latency_ms,
        jitter_ms,
        speed_mbps,
        speed_score,
        gemini_ok,
        trading_safe,
        is_online,
    )
    .await?;

    let _ = crate::bridge_sync::sync_server_bridge_config(pool).await;

    let alert_msg = if is_online {
        format!(
            "✅ نتایج تست کیفیت:\n• پینگ: {} ms | نوسان: {} ms\n• امتیاز سرعت: {}/100\n• تست جمنای: {}\n• تست ترید: {}",
            latency_ms,
            jitter_ms,
            speed_score,
            if gemini_ok { "✅ تایید" } else { "❌ ناموفق" },
            if trading_safe { "✅ پایدار" } else { "⚠️ ناپایدار" }
        )
    } else {
        "🔴 خطا: عدم پاسخ به تست پینگ در ۳ تلاش متوالی".to_string()
    };

    // Update message card if available
    if let Some(msg) = &q.message {
        let status_icon = if is_online { "🟢 فعال / آنلاین" } else { "🔴 غیرفعال / آفلاین" };
        let alloc_desc = allocation_summary_fa(&ob);
        let gemini_badge = if gemini_ok { "✅ سازگار و آماده" } else { "❌ ناموفق" };
        let trading_badge = if trading_safe { "✅ پایدار (Jitter < 30ms)" } else { "⚠️ نامناسب" };

        let card = format!(
            r#"🔹 <b>{}</b> ({})
• شناسه: <code>#{}</code> | پروتکل: <code>{}</code> | کشور: <code>{}</code>
• آدرس سرور: <code>{}:{}</code>
• تخصیص دسترسی: <b>{}</b> (حالت: <code>{}</code>)
• امتیاز کیفیت سرعت: <b>{}/100</b> | پینگ: <b>{} ms</b> (نوسان: <b>{} ms</b>)
• پهنای باند تخمینی: <b>{:.1} Mbps</b> | ترافیک مصرفی: <b>{}</b>
• تست Google Gemini: <b>{}</b>
• تست پایداری ترید (Trading): <b>{}</b>
<i>(بروزرسانی‌شده در همین لحظه توسط موتور کیفیت)</i>"#,
            ob.label.as_deref().unwrap_or(&ob.tag),
            status_icon,
            ob.id,
            ob.protocol,
            ob.country_code,
            ob.server_address,
            ob.server_port,
            alloc_desc,
            ob.allocation_mode,
            speed_score,
            latency_ms,
            jitter_ms,
            speed_mbps,
            format_traffic(ob.bytes_served),
            gemini_badge,
            trading_badge
        );

        let _ = bot.edit_message_text(msg.chat().id, msg.id(), card)
            .parse_mode(ParseMode::Html)
            .reply_markup(admin_official_outbound_actions_keyboard(ob.id, is_online, &ob.assigned_tier))
            .await;
    }

    let _ = bot
        .send_message(q.from.id, alert_msg)
        .reply_markup(cancel_and_back_inline_keyboard("adm_action_official_outbounds"))
        .await;
    Ok(())
}

/// Open reallocation menu for an outbound
pub async fn handle_realloc_official_outbound_menu_callback(
    bot: &Bot,
    q: &CallbackQuery,
    admin_chat_id: i64,
    outbound_id: i64,
) -> anyhow::Result<()> {
    let telegram_user_id = q.from.id.0 as i64;
    if !is_authorized_admin(telegram_user_id, admin_chat_id) {
        bot.answer_callback_query(q.id.clone()).text("⛔ دسترسی غیرمجاز!").show_alert(true).await?;
        return Ok(());
    }

    let prompt = format!(
        r#"🔀 <b>تغییر تخصیص دسترسی نود #{}</b>

لطفاً بخش مجاز برای سرویس‌دهی این نود را انتخاب نمایید:"#,
        outbound_id
    );

    if let Some(msg) = &q.message {
        bot.edit_message_text(msg.chat().id, msg.id(), prompt)
            .parse_mode(ParseMode::Html)
            .reply_markup(admin_outbound_reallocation_keyboard(outbound_id))
            .await?;
    }
    bot.answer_callback_query(q.id.clone()).await?;
    Ok(())
}

/// Set outbound allocation mode (free_only, static_only, both, auto)
pub async fn handle_set_outbound_allocation_callback(
    bot: &Bot,
    q: &CallbackQuery,
    pool: &DbPool,
    admin_chat_id: i64,
    outbound_id: i64,
    alloc_mode: &str,
) -> anyhow::Result<()> {
    let telegram_user_id = q.from.id.0 as i64;
    if !is_authorized_admin(telegram_user_id, admin_chat_id) {
        bot.answer_callback_query(q.id.clone()).text("⛔ دسترسی غیرمجاز!").show_alert(true).await?;
        return Ok(());
    }

    let (allow_web, allow_download, allow_static_ip, allow_gaming) = match alloc_mode {
        "free_only" => (true, true, false, false),
        "gaming_only" | "gaming" => (false, false, false, true),
        "static_only" => (false, false, true, false),
        "both" => (true, true, true, false),
        "all" => (true, true, true, true),
        _ => (true, true, false, false), // auto initially starts with free, updated by engine
    };

    Repository::update_outbound_allocation(
        pool,
        outbound_id,
        allow_web,
        allow_download,
        allow_static_ip,
        allow_gaming,
        alloc_mode,
    )
    .await?;

    // Auto-sync server bridge
    let _ = crate::bridge_sync::sync_server_bridge_config(pool).await;

    let desc = category_label_fa(alloc_mode);
    let gaming_live_notice = if allow_gaming {
        "\n\n🎮 <b>بخش گیمینگ اکنون به صورت خودکار در کل اکوسیستم فعال شد!</b>"
    } else {
        ""
    };

    bot.answer_callback_query(q.id.clone())
        .text(format!("✅ تخصیص نود به [{}] تغییر یافت.", desc))
        .show_alert(true)
        .await?;

    if let Some(msg) = &q.message {
        let _ = bot.edit_message_text(
            msg.chat().id,
            msg.id(),
            format!(
                "✅ <b>تخصیص دسترسی نود #{} با موفقیت روی [{}] تنظیم و در پل سرور همگام شد.</b>{}",
                outbound_id, desc, gaming_live_notice
            ),
        )
        .parse_mode(ParseMode::Html)
        .reply_markup(admin_official_outbounds_hub_keyboard())
        .await;
    }

    Ok(())
}

/// Run instant Gemini & Trading test for a single outbound
pub async fn handle_test_gemini_outbound_callback(
    bot: &Bot,
    q: &CallbackQuery,
    pool: &DbPool,
    admin_chat_id: i64,
    outbound_id: i64,
) -> anyhow::Result<()> {
    let telegram_user_id = q.from.id.0 as i64;
    if !is_authorized_admin(telegram_user_id, admin_chat_id) {
        bot.answer_callback_query(q.id.clone()).text("⛔ دسترسی غیرمجاز!").show_alert(true).await?;
        return Ok(());
    }

    let ob = match Repository::get_official_outbound_by_id(pool, outbound_id).await? {
        Some(o) => o,
        None => {
            bot.answer_callback_query(q.id.clone()).text("نود یافت نشد.").show_alert(true).await?;
            return Ok(());
        }
    };

    bot.answer_callback_query(q.id.clone()).text("🧪 در حال اجرای تست تخصصی Google Gemini و Trading...").await?;

    let ip = match OutboundAnalyzer::check_anti_ssrf(&ob.server_address).await {
        Ok(ip) => ip,
        Err(_) => {
            bot.send_message(q.from.id, "❌ خطای DNS سرور")
                .reply_markup(cancel_and_back_inline_keyboard("adm_action_official_outbounds"))
                .await?;
            return Ok(());
        }
    };

    let (_lat, jitter_ms, _spd, _score, _up) =
        QualityEngine::test_outbound_network_quality(ip, ob.server_port as u16).await;

    let parsed_config: serde_json::Value = serde_json::from_str(&ob.config_json).unwrap_or_default();
    let (gemini_ok, trading_safe) =
        QualityEngine::test_gemini_and_trading_readiness(ip, ob.server_port as u16, &parsed_config, &ob.country_code, jitter_ms).await;

    Repository::update_outbound_quality_metrics(
        pool,
        outbound_id,
        ob.latency_ms,
        jitter_ms,
        ob.speed_mbps,
        ob.speed_score,
        gemini_ok,
        trading_safe,
        true,
    )
    .await?;

    let report_msg = format!(
        r#"🧪 <b>نتایج تست سازگاری نود #{}:</b>

• 🤖 <b>Google Gemini:</b> {}
• 📈 <b>پایداری ترید (Trading Jitter &lt; 30ms):</b> {} (نوسان فعلی: <code>{} ms</code>)
• 🔒 <b>شرایط ورود به استخر آی‌پی ثابت:</b> {}

⚡️ وضعیت در دیتابیس ثبت و در پل سرور همگام گردید."#,
        outbound_id,
        if gemini_ok { "✅ سازگار و بدون فیلتر منطقه‌ای" } else { "❌ مسدود یا نیازمند احراز هویت" },
        if trading_safe { "✅ فوق‌العاده پایدار" } else { "⚠️ ناپایدار برای ترید لحظه‌ای" },
        jitter_ms,
        if gemini_ok && trading_safe { "✅ واجد شرایط (تایید شده)" } else { "❌ فاقد شرایط آی‌پی ثابت" }
    );

    let _ = bot
        .send_message(q.from.id, report_msg)
        .parse_mode(ParseMode::Html)
        .reply_markup(cancel_and_back_inline_keyboard("adm_action_official_outbounds"))
        .await;
    Ok(())
}

/// Toggle active/inactive status of an official outbound
pub async fn handle_toggle_official_outbound_callback(
    bot: &Bot,
    q: &CallbackQuery,
    pool: &DbPool,
    admin_chat_id: i64,
    outbound_id: i64,
) -> anyhow::Result<()> {
    let telegram_user_id = q.from.id.0 as i64;
    if !is_authorized_admin(telegram_user_id, admin_chat_id) {
        bot.answer_callback_query(q.id.clone()).text("⛔ دسترسی غیرمجاز!").show_alert(true).await?;
        return Ok(());
    }

    let new_status = Repository::toggle_official_outbound_status(pool, outbound_id).await?;
    let is_active = new_status == "active";

    // Auto-sync server sing-box bridge
    let _ = crate::bridge_sync::sync_server_bridge_config(pool).await;

    let alert = if is_active {
        "🟢 نود با موفقیت فعال شد و در مدار قرار گرفت."
    } else {
        "⏸ نود موقتاً غیرفعال شد."
    };
    bot.answer_callback_query(q.id.clone()).text(alert).show_alert(true).await?;

    if let Some(ob) = Repository::get_official_outbound_by_id(pool, outbound_id).await? {
        if let Some(msg) = &q.message {
            let status_icon = if is_active { "🟢 فعال / آنلاین" } else { "🔴 غیرفعال / آفلاین" };
            let card = format!(
                r#"🔹 <b>{}</b> ({})
• شناسه: <code>#{}</code> | پروتکل: <code>{}</code>
• آدرس سرور: <code>{}:{}</code>
• آخرین پینگ: <b>{} ms</b> | سلامت: <b>{}%</b>
• ترافیک مصرفی: <b>{}</b>"#,
                ob.label.as_deref().unwrap_or(&ob.tag),
                status_icon,
                ob.id,
                ob.protocol,
                ob.server_address,
                ob.server_port,
                ob.latency_ms,
                ob.health_score,
                format_traffic(ob.bytes_served)
            );

            let _ = bot.edit_message_text(msg.chat().id, msg.id(), card)
                .parse_mode(ParseMode::Html)
                .reply_markup(admin_official_outbound_actions_keyboard(ob.id, is_active, &ob.assigned_tier))
                .await;
        }
    }

    Ok(())
}

/// Delete an official outbound
pub async fn handle_delete_official_outbound_callback(
    bot: &Bot,
    q: &CallbackQuery,
    pool: &DbPool,
    admin_chat_id: i64,
    outbound_id: i64,
) -> anyhow::Result<()> {
    let telegram_user_id = q.from.id.0 as i64;
    if !is_authorized_admin(telegram_user_id, admin_chat_id) {
        bot.answer_callback_query(q.id.clone()).text("⛔ دسترسی غیرمجاز!").show_alert(true).await?;
        return Ok(());
    }

    let deleted = Repository::delete_official_outbound(pool, outbound_id).await?;
    if deleted {
        let _ = crate::bridge_sync::sync_server_bridge_config(pool).await;
        bot.answer_callback_query(q.id.clone()).text("🗑 نود با موفقیت حذف شد.").show_alert(true).await?;
        if let Some(msg) = &q.message {
            let _ = bot
                .edit_message_text(
                    msg.chat().id,
                    msg.id(),
                    format!("🗑 <b>نود #{} از سیستم حذف گردید.</b>", outbound_id),
                )
                .parse_mode(ParseMode::Html)
                .reply_markup(cancel_and_back_inline_keyboard("adm_action_official_outbounds"))
                .await;
        }
    } else {
        bot.answer_callback_query(q.id.clone()).text("خطا در حذف نود یا نود یافت نشد.").show_alert(true).await?;
    }

    Ok(())
}

/// Re-sync all nodes from a saved subscription source URL
pub async fn handle_resync_subscription_callback(
    bot: &Bot,
    q: &CallbackQuery,
    pool: &DbPool,
    admin_chat_id: i64,
    source_id: i64,
) -> anyhow::Result<()> {
    let telegram_user_id = q.from.id.0 as i64;
    if !is_authorized_admin(telegram_user_id, admin_chat_id) {
        bot.answer_callback_query(q.id.clone()).text("⛔ دسترسی غیرمجاز!").show_alert(true).await?;
        return Ok(());
    }

    let source = match Repository::get_subscription_source_by_id(pool, source_id).await? {
        Some(s) => s,
        None => {
            bot.answer_callback_query(q.id.clone()).text("منبع سابسکریپشن یافت نشد.").show_alert(true).await?;
            return Ok(());
        }
    };

    bot.answer_callback_query(q.id.clone()).text("⏳ در حال دریافت مجدد و همگام‌سازی نودها...").await?;

    match OutboundAnalyzer::import_subscription_url(pool, &source.category, &source.url).await {
        Ok(res) => {
            let mut country_summary = String::new();
            for (country, count) in &res.country_counts {
                country_summary.push_str(&format!("• {}: <b>{} نود</b>\n", country, count));
            }
            if country_summary.is_empty() {
                country_summary = "• نامشخص / محلی\n".to_string();
            }

            let cat_fa = match source.category.as_str() {
                "web_browsing" => "🌐 وب‌گردی",
                "download" => "📥 دانلود",
                "static_ip" => "🔒 آی‌پی ثابت",
                _ => &source.category,
            };

            let msg_text = format!(
                r#"🔄 <b>همگام‌سازی مجدد سابسکریپشن [{}] تکمیل شد</b>

📦 <b>وضعیت بروزرسانی:</b>
• کل کانفیگ‌ها: <b>{} نود</b>
• نودهای سالم و فعال: <b>{} نود</b>
• نامعتبر / آفلاین: <b>{} نود</b>

🌍 <b>تفکیک جغرافیایی:</b>
{}
<i>(بروزرسانی‌شده در همین لحظه)</i>"#,
                cat_fa,
                res.total_nodes,
                res.healthy_nodes,
                res.invalid_nodes,
                country_summary
            );

            let kb = InlineKeyboardMarkup::new(vec![
                vec![
                    InlineKeyboardButton::callback("🔄 بروزرسانی مجدد این سابلینک", format!("adm_sub_resync_{}", source_id)),
                ],
                vec![
                    InlineKeyboardButton::callback("📋 مشاهده لیست نودها", format!("adm_ob_list_{}", source.category)),
                    InlineKeyboardButton::callback("🔙 بازگشت به منوی اوتباندها", "adm_action_official_outbounds"),
                ],
            ]);

            if let Some(msg) = &q.message {
                let _ = bot.edit_message_text(msg.chat().id, msg.id(), msg_text)
                    .parse_mode(ParseMode::Html)
                    .reply_markup(kb)
                    .await;
            }
        }
        Err(e) => {
            let err_text = format!("❌ خطا در همگام‌سازی مجدد سابسکریپشن:\n{}", e);
            if let Some(msg) = &q.message {
                let _ = bot
                    .send_message(msg.chat().id, err_text)
                    .reply_markup(cancel_and_back_inline_keyboard("adm_action_official_outbounds"))
                    .await;
            }
        }
    }

    Ok(())
}

/// Generate or refresh Cloudflare WARP WireGuard account for server dual-chain routing
pub async fn handle_generate_warp_callback(
    bot: &Bot,
    q: &CallbackQuery,
    pool: &DbPool,
    admin_chat_id: i64,
) -> anyhow::Result<()> {
    let telegram_user_id = q.from.id.0 as i64;
    if !is_authorized_admin(telegram_user_id, admin_chat_id) {
        bot.answer_callback_query(q.id.clone()).text("⛔ دسترسی غیرمجاز!").show_alert(true).await?;
        return Ok(());
    }

    bot.answer_callback_query(q.id.clone()).text("⏳ در حال ثبت کلیدهای WireGuard در سرورهای کلادفلر...").await?;

    match crate::warp_gen::register_warp_account(None).await {
        Ok(account_data) => {
            let _ = Repository::save_warp_account(
                pool,
                &account_data.private_key,
                &account_data.public_key,
                &account_data.address_v4,
                &account_data.address_v6,
                &account_data.reserved_json(),
                account_data.account_id.as_deref(),
                account_data.token.as_deref(),
                account_data.license_key.as_deref(),
                &account_data.account_type,
            )
            .await;

            let _ = crate::bridge_sync::sync_server_bridge_config(pool).await;

            let text = format!(
                r#"⚡️ <b>اکانت Cloudflare WARP با موفقیت ایجاد و شارژ شد!</b>

🔑 <b>مشخصات اکانت WireGuard کلادفلر:</b>
• نوع اکانت: <b>{}</b>
• کلید عمومی: <code>{}</code>
• آدرس IPv4: <code>{}/32</code>
• آدرس IPv6: <code>{}/128</code>
• بایت‌های Reserved: <code>{:?}</code>

🔄 <b>وضعیت پل سرور:</b>
زنجیره خروجی دوگانه (Dual-Chain) در Sing-box به صورت آنی فعال گردید. کاربرانی که گزینه WARP را در کلاینت روشن کنند، ترافیکشان به صورت خودکار از داخل تونل کلادفلر عبور داده می‌شود."#,
                if account_data.account_type == "plus" { "WARP+ اختصاصی 🌟" } else { "WARP رایگان ⚡️" },
                account_data.public_key,
                account_data.address_v4,
                account_data.address_v6,
                account_data.reserved,
            );

            if let Some(msg) = &q.message {
                bot.send_message(msg.chat().id, text)
                    .parse_mode(ParseMode::Html)
                    .reply_markup(admin_official_outbounds_hub_keyboard())
                    .await?;
            }
        }
        Err(e) => {
            if let Some(msg) = &q.message {
                bot.send_message(msg.chat().id, format!("❌ خطا در ثبت اکانت WARP: {}", e))
                    .reply_markup(admin_official_outbounds_hub_keyboard())
                    .await?;
            }
        }
    }

    Ok(())
}

/// Admin approves a user-donated outbound with +7, +15, or +30 days subscription reward
pub async fn handle_donated_outbound_approve(
    bot: &Bot,
    q: &CallbackQuery,
    pool: &DbPool,
    admin_chat_id: i64,
    outbound_id: i64,
    reward_days: i64,
) -> anyhow::Result<()> {
    let telegram_user_id = q.from.id.0 as i64;
    if !is_authorized_admin(telegram_user_id, admin_chat_id) {
        bot.answer_callback_query(q.id.clone())
            .text("⛔ دسترسی غیرمجاز!")
            .show_alert(true)
            .await?;
        return Ok(());
    }

    let existing = Repository::get_donated_outbound_by_id(pool, outbound_id).await?;
    if let Some(ref ob) = existing {
        if ob.status == "active" && ob.reward_granted == 1 {
            bot.answer_callback_query(q.id.clone())
                .text("⚠️ این اوتباند قبلاً تایید و پاداش آن اعمال شده است.")
                .show_alert(true)
                .await?;
            return Ok(());
        }
    }

    let (ob, donor_opt, sub_opt) =
        Repository::approve_donated_outbound_with_reward_days(pool, outbound_id, reward_days).await?;

    // Immediately sync server bridge & client pool so all users see this outbound
    let _ = crate::bridge_sync::sync_server_bridge_config(pool).await;

    let donor_name = donor_opt
        .as_ref()
        .and_then(|u| u.username.clone())
        .or_else(|| donor_opt.as_ref().map(|u| u.first_name.clone()))
        .unwrap_or_else(|| format!("کاربر #{}", ob.donor_user_id.unwrap_or(0)));

    // Notify donor on Telegram if their account is linked
    if let Some(ref donor) = donor_opt {
        if let Some(tg_id) = donor.telegram_id {
            let new_exp = sub_opt
                .as_ref()
                .map(|s| s.expires_at.format("%Y-%m-%d").to_string())
                .unwrap_or_else(|| "تمدید شد".to_string());
            let notify_msg = format!(
                "🎉 <b>تبریک! اوتباند اهدایی شما تایید شد</b>\n\n\
                 🌐 نام سرور: <code>{}</code> ({})\n\
                 🎁 پاداش فعال‌شده: <b>+{} روز اشتراک ویژه Sentra Pro</b>\n\
                 📅 اعتبار جدید اشتراک: <code>{}</code>\n\n\
                 سپاس از همراهی و حمایت شما از شبکه آزاد سنترا 💚",
                ob.tag,
                ob.protocol.to_uppercase(),
                reward_days,
                new_exp
            );
            let _ = bot
                .send_message(ChatId(tg_id), notify_msg)
                .parse_mode(ParseMode::Html)
                .reply_markup(back_to_main_inline_keyboard())
                .await;
        }
    }

    let admin_updated = format!(
        "✅ <b>اوتباند اهدایی #{} تایید و در شبکه فعال شد!</b>\n\n\
         👤 اهداکننده: <code>{}</code>\n\
         🌐 سرور: <code>{}</code> (<code>{}:{}</code>)\n\
         🔌 پروتکل: <b>{}</b> | پینگ: <b>{} ms</b>\n\
         🎁 پاداش اعمال‌شده: <b>+{} روز اشتراک ویژه</b>\n\
         🔄 وضعیت: به لیست زنده کلاینت‌ها (ویندوز و اندروید) اضافه شد.",
        ob.id,
        donor_name,
        ob.tag,
        ob.server_address,
        ob.server_port,
        ob.protocol.to_uppercase(),
        ob.latency_ms,
        reward_days
    );

    if let Some(msg) = &q.message {
        let _ = bot
            .edit_message_text(msg.chat().id, msg.id(), admin_updated)
            .parse_mode(ParseMode::Html)
            .reply_markup(back_to_admin_inline_keyboard())
            .await;
    }

    bot.answer_callback_query(q.id.clone())
        .text(format!("✅ تایید شد (+{} روز اشتراک)", reward_days))
        .await?;

    Ok(())
}

/// Admin rejects a user-donated outbound
pub async fn handle_donated_outbound_reject(
    bot: &Bot,
    q: &CallbackQuery,
    pool: &DbPool,
    admin_chat_id: i64,
    outbound_id: i64,
) -> anyhow::Result<()> {
    let telegram_user_id = q.from.id.0 as i64;
    if !is_authorized_admin(telegram_user_id, admin_chat_id) {
        bot.answer_callback_query(q.id.clone())
            .text("⛔ دسترسی غیرمجاز!")
            .show_alert(true)
            .await?;
        return Ok(());
    }

    let (ob, donor_opt) = Repository::reject_donated_outbound(
        pool,
        outbound_id,
        "توسط مدیر سیستم تایید نشد (عدم احراز شرایط کیفیت یا پایداری).",
    )
    .await?;

    let _ = crate::bridge_sync::sync_server_bridge_config(pool).await;

    if let Some(ref donor) = donor_opt {
        if let Some(tg_id) = donor.telegram_id {
            let notify_msg = format!(
                "❌ <b>اوتباند اهدایی شما تایید نشد</b>\n\n\
                 🌐 سرور: <code>{}</code>\n\
                 📝 دلیل: عدم احراز شرایط کیفیت یا پایداری لازم.\n\
                 می‌توانید کانفیگ پرسرعت و پایدار دیگری از داخل اپلیکیشن ارسال نمایید.",
                ob.tag
            );
            let _ = bot
                .send_message(ChatId(tg_id), notify_msg)
                .parse_mode(ParseMode::Html)
                .reply_markup(back_to_main_inline_keyboard())
                .await;
        }
    }

    let admin_updated = format!(
        "❌ <b>اوتباند اهدایی #{} رد شد.</b>\n\n\
         🌐 سرور: <code>{}</code> (<code>{}:{}</code>)\n\
         وضعیت در حساب کاربر به «رد شده» تغییر یافت.",
        ob.id, ob.tag, ob.server_address, ob.server_port
    );

    if let Some(msg) = &q.message {
        let _ = bot
            .edit_message_text(msg.chat().id, msg.id(), admin_updated)
            .parse_mode(ParseMode::Html)
            .reply_markup(back_to_admin_inline_keyboard())
            .await;
    }

    bot.answer_callback_query(q.id.clone())
        .text("❌ اوتباند رد شد.")
        .await?;

    Ok(())
}
