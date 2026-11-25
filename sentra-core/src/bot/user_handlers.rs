use crate::bot::keyboards::{
    auth_choice_inline_keyboard, auth_retry_inline_keyboard, back_to_main_inline_keyboard,
    cancel_and_back_inline_keyboard, download_app_inline_keyboard, ios_modes_inline_keyboard,
    ios_protocol_choice_keyboard, subscription_status_inline_keyboard,
    upgrade_plans_inline_keyboard, user_account_inline_keyboard, user_devices_inline_keyboard,
    user_main_keyboard_for_user,
};
use crate::compiler;
use crate::db::{DbPool, Repository};
use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use teloxide::prelude::*;
use teloxide::types::{InputFile, KeyboardMarkup, ParseMode};
use tokio::sync::RwLock;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UserState {
    AwaitingDonationLink,
    AwaitingReceiptPhoto,
    AwaitingLinkCode,
    AwaitingAppLoginUsername,
    AwaitingAppLoginPassword { username: String },
}

static USER_STATES: OnceLock<RwLock<HashMap<i64, UserState>>> = OnceLock::new();
static LOGIN_FAILURE_TRACKER: OnceLock<RwLock<HashMap<i64, Vec<Instant>>>> = OnceLock::new();

const LOGIN_MAX_FAILED_ATTEMPTS: usize = 5;
const LOGIN_LOCKOUT_WINDOW: Duration = Duration::from_secs(15 * 60);

fn user_states_map() -> &'static RwLock<HashMap<i64, UserState>> {
    USER_STATES.get_or_init(|| RwLock::new(HashMap::new()))
}

fn login_failure_map() -> &'static RwLock<HashMap<i64, Vec<Instant>>> {
    LOGIN_FAILURE_TRACKER.get_or_init(|| RwLock::new(HashMap::new()))
}

fn escape_html(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

async fn is_login_rate_limited(telegram_id: i64) -> bool {
    let now = Instant::now();
    let mut map = login_failure_map().write().await;
    let entries = map.entry(telegram_id).or_default();
    entries.retain(|t| now.duration_since(*t) < LOGIN_LOCKOUT_WINDOW);
    entries.len() >= LOGIN_MAX_FAILED_ATTEMPTS
}

async fn record_failed_login(telegram_id: i64) {
    let now = Instant::now();
    let mut map = login_failure_map().write().await;
    let entries = map.entry(telegram_id).or_default();
    entries.retain(|t| now.duration_since(*t) < LOGIN_LOCKOUT_WINDOW);
    entries.push(now);
}

async fn clear_failed_logins(telegram_id: i64) {
    let mut map = login_failure_map().write().await;
    map.remove(&telegram_id);
}

pub async fn set_user_state(telegram_id: i64, state: UserState) {
    let mut map = user_states_map().write().await;
    map.insert(telegram_id, state);
}

pub async fn get_user_state(telegram_id: i64) -> Option<UserState> {
    let map = user_states_map().read().await;
    map.get(&telegram_id).cloned()
}

pub async fn clear_user_state(telegram_id: i64) {
    let mut map = user_states_map().write().await;
    map.remove(&telegram_id);
}

/// Resolve the right main keyboard ("📝 ثبت نام" vs "👤 حساب کاربری") for any Telegram user
pub async fn resolve_user_main_keyboard(
    pool: &DbPool,
    telegram_id: i64,
    admin_chat_id: i64,
) -> KeyboardMarkup {
    let is_registered = Repository::get_user_by_telegram_id(pool, telegram_id)
        .await
        .ok()
        .flatten()
        .is_some();
    let is_admin = crate::bot::admin_handlers::is_authorized_admin(telegram_id, admin_chat_id);
    user_main_keyboard_for_user(is_registered, is_admin)
}

/// Prompt an unregistered user to register or sign in with their app account before using account-bound features
async fn prompt_registration_required(bot: &Bot, chat_id: ChatId) -> anyhow::Result<()> {
    let text = r#"📝 <b>ابتدا ثبت‌نام یا ورود به حساب را انجام دهید</b>

برای دسترسی به این بخش، لطفاً یکی از دو گزینه زیر را انتخاب نمایید:
• <b>🆕 ثبت نام:</b> ایجاد فوری حساب و دریافت کد شناسایی اختصاصی
• <b>🔐 ورود با حساب برنامه:</b> ورود با نام کاربری و رمز عبور اپلیکیشن ویندوز یا اندروید"#;

    bot.send_message(chat_id, text)
        .parse_mode(ParseMode::Html)
        .reply_markup(auth_choice_inline_keyboard())
        .await?;
    Ok(())
}

/// Global Back handler: clears any pending UserState or Admin*State and returns to main menu
pub async fn handle_user_back_to_main_callback(
    bot: &Bot,
    q: &CallbackQuery,
    pool: &DbPool,
    admin_chat_id: i64,
) -> anyhow::Result<()> {
    let tid = q.from.id.0 as i64;
    clear_user_state(tid).await;
    crate::bot::admin_handlers::clear_all_admin_states(tid).await;

    let keyboard = resolve_user_main_keyboard(pool, tid, admin_chat_id).await;

    let _ = bot
        .answer_callback_query(q.id.clone())
        .text("🔙 بازگشت به منوی اصلی")
        .await;

    if let Some(msg) = &q.message {
        let _ = bot
            .send_message(
                msg.chat().id,
                "🏠 <b>منوی اصلی ربات سنترا (Sentra)</b>\n\nعملیات قبلی بسته شد. لطفاً یکی از گزینه‌های زیر را انتخاب نمایید:",
            )
            .parse_mode(ParseMode::Html)
            .reply_markup(keyboard)
            .await;
    }

    Ok(())
}

pub async fn handle_start(
    bot: &Bot,
    msg: &Message,
    pool: &DbPool,
    admin_chat_id: i64,
) -> anyhow::Result<()> {
    let telegram_user = match msg.from.as_ref() {
        Some(u) => u,
        None => return Ok(()),
    };

    let tid = telegram_user.id.0 as i64;
    let is_admin_user = admin_chat_id != 0 && (tid == admin_chat_id);
    let safe_first_name = escape_html(&telegram_user.first_name);

    // Do NOT auto-register first-time users on /start; let them choose Register or Login with App Account
    let existing_user = Repository::get_user_by_telegram_id(pool, tid).await?;

    let Some(user) = existing_user else {
        let mut welcome = format!(
            r#"👋 درود <b>{}</b> گرامی، به پلتفرم هوشمند ضدسانسور <b>سنترا (Sentra)</b> خوش آمدید!

برای شروع استفاده از سرویس و همگام‌سازی اشتراک بین ربات تلگرام، ویندوز و اندروید، روی دکمه <b>«📝 ثبت نام»</b> در بالای منو بزنید:
• <b>🆕 ثبت نام:</b> ساخت فوری حساب و دریافت کد شناسایی اختصاصی
• <b>🔐 ورود با حساب برنامه:</b> اتصال اکانت موجود شما در اپلیکیشن با نام کاربری و رمز عبور"#,
            safe_first_name
        );

        if is_admin_user {
            welcome.push_str("\n\n👑 <i>دسترسی مدیر کل فعال است. برای ورود به پنل ادمین دستور /admin را ارسال کنید.</i>");
        }

        bot.send_message(msg.chat.id, welcome)
            .parse_mode(ParseMode::Html)
            .reply_markup(user_main_keyboard_for_user(false, is_admin_user))
            .await?;

        return Ok(());
    };

    let mut sub = Repository::create_or_ensure_lite_subscription(pool, user.id).await?;
    let _ = Repository::check_and_reset_daily_quota(pool, &mut sub).await;
    let total_used_bytes = (sub.upload_bytes + sub.download_bytes).max(0);
    let remaining_gb = (sub.traffic_limit_bytes - total_used_bytes).max(0) as f64 / (1024.0 * 1024.0 * 1024.0);
    let total_limit_gb = sub.traffic_limit_bytes.max(0) as f64 / (1024.0 * 1024.0 * 1024.0);
    let linked_line = match &user.username {
        Some(uname) if !uname.trim().is_empty() => format!("• نام کاربری: <code>@{}</code>\n", escape_html(uname)),
        _ => String::new(),
    };

    let mut text = format!(
        r#"👋 خوش آمدید <b>{}</b> گرامی!

👤 <b>وضعیت حساب کاربری شما (همگام با ویندوز و اندروید):</b>
{}• نوع اشتراک: <b>{}</b>
• حجم باقیمانده: <b>{:.2} GB</b> از <code>{:.0} GB</code>
• وضعیت شبکه: <b>🟢 پایدار و فعال</b>

برای مشاهده جزئیات مصرف و اشتراک، روی دکمه <b>«👤 حساب کاربری»</b> در بالای منو بزنید."#,
        escape_html(&user.first_name),
        linked_line,
        escape_html(&sub.tier),
        remaining_gb,
        total_limit_gb
    );

    if is_admin_user {
        text.push_str("\n\n👑 <i>دسترسی مدیر کل فعال است. برای ورود به پنل ادمین دستور /admin را ارسال کنید.</i>");
    }

    bot.send_message(msg.chat.id, text)
        .parse_mode(ParseMode::Html)
        .reply_markup(user_main_keyboard_for_user(true, is_admin_user))
        .await?;

    Ok(())
}

/// Handle tapping the big "📝 ثبت نام" button: shows two options (Register / Login with App Account)
pub async fn handle_register_menu(
    bot: &Bot,
    msg: &Message,
    pool: &DbPool,
    admin_chat_id: i64,
) -> anyhow::Result<()> {
    let telegram_user = match msg.from.as_ref() {
        Some(u) => u,
        None => return Ok(()),
    };
    let tid = telegram_user.id.0 as i64;

    // If user is already registered, refresh keyboard to "👤 حساب کاربری" and open their Account card
    if Repository::get_user_by_telegram_id(pool, tid).await?.is_some() {
        let is_admin = crate::bot::admin_handlers::is_authorized_admin(tid, admin_chat_id);
        let _ = bot
            .send_message(msg.chat.id, "✅ حساب کاربری شما از قبل ثبت شده است.")
            .reply_markup(user_main_keyboard_for_user(true, is_admin))
            .await;
        return handle_user_account_info(bot, msg, pool, admin_chat_id).await;
    }

    let text = r#"📝 <b>ثبت‌نام و ورود به حساب سنترا (Sentra)</b>

لطفاً یکی از دو گزینه زیر را انتخاب نمایید:

• <b>🆕 ثبت نام:</b> اگر هنوز حسابی ندارید، با یک کلیک ثبت‌نام کنید تا کد شناسایی شما صادر شود.
• <b>🔐 ورود با حساب برنامه:</b> اگر قبلاً در اپلیکیشن ویندوز یا اندروید حساب ساخته‌اید، با نام کاربری و رمز عبور خود وارد شوید تا تمام اطلاعات شما همگام شود."#;

    bot.send_message(msg.chat.id, text)
        .parse_mode(ParseMode::Html)
        .reply_markup(auth_choice_inline_keyboard())
        .await?;

    Ok(())
}

/// Handle inline callback "auth_register_new": registers user and reveals ONLY their identification code, then switches menu to "👤 حساب کاربری"
pub async fn handle_register_new_callback(
    bot: &Bot,
    q: &CallbackQuery,
    pool: &DbPool,
    admin_chat_id: i64,
) -> anyhow::Result<()> {
    let telegram_user = &q.from;
    let tid = telegram_user.id.0 as i64;
    let is_admin = crate::bot::admin_handlers::is_authorized_admin(tid, admin_chat_id);

    clear_user_state(tid).await;

    let user = Repository::get_or_create_user(
        pool,
        tid,
        telegram_user.username.as_deref(),
        &telegram_user.first_name,
        telegram_user.last_name.as_deref(),
    )
    .await?;

    let _sub = Repository::create_or_ensure_lite_subscription(pool, user.id).await?;

    let _ = bot
        .answer_callback_query(q.id.clone())
        .text("✅ ثبت‌نام شما با موفقیت انجام شد.")
        .await;

    let text = format!(
        r#"✅ <b>ثبت‌نام شما با موفقیت انجام شد!</b>

🆔 <b>کد شناسایی شما:</b> <code>{}</code>

از این پس می‌توانید حجم مصرفی و نوع اشتراک خود را از دکمه <b>«👤 حساب کاربری»</b> مشاهده نمایید."#,
        user.id
    );

    if let Some(msg) = &q.message {
        bot.send_message(msg.chat().id, text)
            .parse_mode(ParseMode::Html)
            .reply_markup(user_main_keyboard_for_user(true, is_admin))
            .await?;
    }

    Ok(())
}

/// Handle inline callback "auth_login_app": begins username + password sign-in for existing app accounts
pub async fn handle_app_login_start_callback(
    bot: &Bot,
    q: &CallbackQuery,
) -> anyhow::Result<()> {
    let tid = q.from.id.0 as i64;

    if is_login_rate_limited(tid).await {
        let _ = bot
            .answer_callback_query(q.id.clone())
            .text("⛔ به دلیل تلاش‌های ناموفق متعدد، لطفاً ۱۵ دقیقه دیگر دوباره تلاش کنید.")
            .show_alert(true)
            .await;
        return Ok(());
    }

    set_user_state(tid, UserState::AwaitingAppLoginUsername).await;
    let _ = bot.answer_callback_query(q.id.clone()).await;

    let text = r#"🔐 <b>ورود با حساب اپلیکیشن Sentra</b>

لطفاً <b>نام کاربری (Username)</b> یا <b>ایمیل</b> حساب خود در برنامه ویندوز/اندروید را ارسال نمایید:"#;

    if let Some(msg) = &q.message {
        bot.send_message(msg.chat().id, text)
            .parse_mode(ParseMode::Html)
            .reply_markup(back_to_main_inline_keyboard())
            .await?;
    }

    Ok(())
}

/// Step 1 of app credential login inside Telegram: capture username and ask for password
pub async fn handle_app_login_username_input(
    bot: &Bot,
    msg: &Message,
    raw_username: &str,
) -> anyhow::Result<()> {
    let telegram_user = match msg.from.as_ref() {
        Some(u) => u,
        None => return Ok(()),
    };
    let tid = telegram_user.id.0 as i64;

    let trimmed = raw_username.trim();
    if trimmed.is_empty() || trimmed.len() > 128 || trimmed.contains('\n') {
        bot.send_message(
            msg.chat.id,
            "⚠️ نام کاربری واردشده معتبر نیست. لطفاً نام کاربری یا ایمیل حساب برنامه خود را ارسال کنید:",
        )
        .reply_markup(back_to_main_inline_keyboard())
        .await?;
        return Ok(());
    }

    let clean_username = if trimmed.starts_with('@') && !trimmed[1..].contains('@') {
        trimmed[1..].to_string()
    } else {
        trimmed.to_string()
    };

    set_user_state(
        tid,
        UserState::AwaitingAppLoginPassword {
            username: clean_username.clone(),
        },
    )
    .await;

    let text = format!(
        r#"🔑 <b>ورود به حساب <code>{}</code></b>

لطفاً <b>رمز عبور (Password)</b> حساب خود را ارسال نمایید:

🛡 <i>پیام حاوی رمز عبور جهت حفظ امنیت بلافاصله پس از بررسی از چت حذف خواهد شد.</i>"#,
        escape_html(&clean_username)
    );

    bot.send_message(msg.chat.id, text)
        .parse_mode(ParseMode::Html)
        .reply_markup(back_to_main_inline_keyboard())
        .await?;

    Ok(())
}

/// Step 2 of app credential login inside Telegram: delete password message, verify via Argon2, and link account
pub async fn handle_app_login_password_input(
    bot: &Bot,
    msg: &Message,
    pool: &DbPool,
    admin_chat_id: i64,
    username: &str,
    raw_password: &str,
) -> anyhow::Result<()> {
    // Immediately delete the user's message containing plaintext password from Telegram chat
    let _ = bot.delete_message(msg.chat.id, msg.id).await;

    let telegram_user = match msg.from.as_ref() {
        Some(u) => u,
        None => return Ok(()),
    };
    let tid = telegram_user.id.0 as i64;
    let is_admin = crate::bot::admin_handlers::is_authorized_admin(tid, admin_chat_id);

    clear_user_state(tid).await;

    if is_login_rate_limited(tid).await {
        bot.send_message(
            msg.chat.id,
            "⛔ به دلیل تلاش‌های ناموفق متعدد، امکان ورود موقتاً به مدت ۱۵ دقیقه محدود شده است.",
        )
        .reply_markup(back_to_main_inline_keyboard())
        .await?;
        return Ok(());
    }

    if raw_password.trim().is_empty() || raw_password.len() > 256 {
        record_failed_login(tid).await;
        bot.send_message(
            msg.chat.id,
            "❌ نام کاربری یا رمز عبور اشتباه است.",
        )
        .reply_markup(auth_retry_inline_keyboard())
        .await?;
        return Ok(());
    }

    match Repository::login_and_link_telegram_account(
        pool,
        tid,
        username,
        raw_password,
        &telegram_user.first_name,
    )
    .await
    {
        Ok((user, sub)) => {
            clear_failed_logins(tid).await;
            let total_used_bytes = (sub.upload_bytes + sub.download_bytes).max(0);
            let used_gb = total_used_bytes as f64 / (1024.0 * 1024.0 * 1024.0);
            let limit_gb = sub.traffic_limit_bytes.max(0) as f64 / (1024.0 * 1024.0 * 1024.0);
            let rem_gb = (sub.traffic_limit_bytes - total_used_bytes).max(0) as f64 / (1024.0 * 1024.0 * 1024.0);
            let display_uname = user
                .username
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or(username);

            let text = format!(
                r#"✅ <b>ورود با حساب برنامه با موفقیت انجام شد!</b>

👤 <b>نام کاربری:</b> <code>@{}</code>
🆔 <b>کد شناسایی:</b> <code>{}</code>
💎 <b>نوع اشتراک:</b> <b>{}</b>
📊 <b>حجم مصرفی:</b> <b>{:.2} GB</b> مصرف‌شده / <b>{:.2} GB</b> باقیمانده (از {:.0} GB)

از این پس حساب شما در ربات تلگرام، ویندوز و اندروید کاملاً همگام است و می‌توانید از دکمه <b>«👤 حساب کاربری»</b> استفاده نمایید."#,
                escape_html(display_uname),
                user.id,
                escape_html(&sub.tier),
                used_gb,
                rem_gb,
                limit_gb
            );

            bot.send_message(msg.chat.id, text)
                .parse_mode(ParseMode::Html)
                .reply_markup(user_main_keyboard_for_user(true, is_admin))
                .await?;
        }
        Err(e) => {
            record_failed_login(tid).await;
            let err_msg = match e {
                crate::error::CoreError::AuthFailed(m) | crate::error::CoreError::AccountSuspended(m) => m,
                _ => "نام کاربری یا رمز عبور اشتباه است.".to_string(),
            };
            bot.send_message(
                msg.chat.id,
                format!("❌ <b>ورود ناموفق:</b>\n\n{}", escape_html(&err_msg)),
            )
            .parse_mode(ParseMode::Html)
            .reply_markup(auth_retry_inline_keyboard())
            .await?;
        }
    }

    Ok(())
}

/// Handle tapping the big "👤 حساب کاربری" button for registered users (shows consumed traffic & subscription type)
pub async fn handle_user_account_info(
    bot: &Bot,
    msg: &Message,
    pool: &DbPool,
    admin_chat_id: i64,
) -> anyhow::Result<()> {
    let telegram_user = match msg.from.as_ref() {
        Some(u) => u,
        None => return Ok(()),
    };
    let tid = telegram_user.id.0 as i64;
    let is_admin = crate::bot::admin_handlers::is_authorized_admin(tid, admin_chat_id);

    let Some(user) = Repository::get_user_by_telegram_id(pool, tid).await? else {
        return handle_register_menu(bot, msg, pool, admin_chat_id).await;
    };

    let mut sub = Repository::create_or_ensure_lite_subscription(pool, user.id).await?;
    let _ = Repository::check_and_reset_daily_quota(pool, &mut sub).await;
    let devices = Repository::get_user_devices(pool, user.id).await?;

    let is_pro = sub.tier != "Sentra Lite";
    let total_used_bytes = (sub.upload_bytes + sub.download_bytes).max(0);
    let total_used_gb = total_used_bytes as f64 / (1024.0 * 1024.0 * 1024.0);
    let total_limit_gb = sub.traffic_limit_bytes.max(0) as f64 / (1024.0 * 1024.0 * 1024.0);
    let total_rem_gb = (sub.traffic_limit_bytes - total_used_bytes).max(0) as f64 / (1024.0 * 1024.0 * 1024.0);

    let usage_percent = if sub.traffic_limit_bytes > 0 {
        ((total_used_bytes as f64 / sub.traffic_limit_bytes as f64) * 100.0).clamp(0.0, 100.0)
    } else {
        0.0
    };

    let mode_usage_block = if is_pro {
        let static_used_gb = sub.static_ip_used_mb as f64 / 1024.0;
        let static_rem_gb = (30.0 - static_used_gb).max(0.0);
        format!(
            "🌐 <b>وب‌گردی:</b> نامحدود\n📥 <b>دانلود:</b> نامحدود\n🔒 <b>آی‌پی ثابت:</b> {:.2} GB مصرف‌شده / {:.2} GB باقیمانده",
            static_used_gb, static_rem_gb
        )
    } else {
        let wb_used = sub.web_browsing_used_mb as f64 / 1024.0;
        let dl_used = sub.download_used_mb as f64 / 1024.0;
        format!(
            "🌐 <b>مصرف امروز وب‌گردی:</b> {:.2} GB از ۲.۰۰ GB\n📥 <b>مصرف امروز دانلود:</b> {:.2} GB از ۳.۰۰ GB",
            wb_used, dl_used
        )
    };

    let account_name = user
        .username
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .map(|u| format!("@{}", escape_html(u)))
        .unwrap_or_else(|| escape_html(&user.first_name));

    let text = format!(
        r#"👤 <b>حساب کاربری سنترا (Sentra)</b>

🆔 <b>کد شناسایی:</b> <code>{}</code>
👤 <b>نام کاربری:</b> <code>{}</code>
💎 <b>نوع اشتراک:</b> <b>{}</b> (<code>{}</code>)
📅 <b>اعتبار اشتراک:</b> <code>{}</code>

📊 <b>میزان مصرف حجم:</b>
• مصرف‌شده: <b>{:.2} GB</b> ({:.1}%)
• باقیمانده: <b>{:.2} GB</b> از <code>{:.0} GB</code>

{}

📱 <b>دستگاه‌های متصل:</b> <b>{} از {} دستگاه مجاز</b>"#,
        user.id,
        account_name,
        escape_html(&sub.tier),
        escape_html(&sub.status),
        sub.expires_at.format("%Y-%m-%d %H:%M UTC"),
        total_used_gb,
        usage_percent,
        total_rem_gb,
        total_limit_gb,
        mode_usage_block,
        devices.len(),
        sub.max_concurrent_devices.max(3)
    );

    bot.send_message(msg.chat.id, text)
        .parse_mode(ParseMode::Html)
        .reply_markup(user_account_inline_keyboard(devices.len()))
        .await?;

    // Keep persistent keyboard synced as registered
    let _ = is_admin;
    Ok(())
}

/// Inline callback from Account card: generate fresh 8-digit app login code
pub async fn handle_account_get_code_callback(
    bot: &Bot,
    q: &CallbackQuery,
    pool: &DbPool,
) -> anyhow::Result<()> {
    let tid = q.from.id.0 as i64;
    let Some(user) = Repository::get_user_by_telegram_id(pool, tid).await? else {
        let _ = bot
            .answer_callback_query(q.id.clone())
            .text("⚠️ لطفاً ابتدا ثبت‌نام یا ورود به حساب را انجام دهید.")
            .show_alert(true)
            .await;
        return Ok(());
    };

    let code = Repository::generate_auth_code(pool, user.id).await?;
    let _ = bot.answer_callback_query(q.id.clone()).text("✅ کد ورود صادر شد.").await;

    if let Some(msg) = &q.message {
        let text = format!(
            r#"🔑 <b>کد ۸ رقمی ورود به اپلیکیشن Sentra Connect:</b>

👉 <b><code>{}</code></b> 👈

🆔 <b>کد شناسایی شما:</b> <code>{}</code>"#,
            code, user.id
        );
        bot.send_message(msg.chat().id, text)
            .parse_mode(ParseMode::Html)
            .reply_markup(back_to_main_inline_keyboard())
            .await?;
    }

    Ok(())
}

/// Inline callback from Account card: open upgrade plans view
pub async fn handle_account_upgrade_callback(
    bot: &Bot,
    q: &CallbackQuery,
) -> anyhow::Result<()> {
    let _ = bot.answer_callback_query(q.id.clone()).await;
    if let Some(msg) = &q.message {
        let text = r#"⚡ <b>تعرفه‌ها و پلن‌های ضدسانسور سنترا:</b>

۱. <b>Sentra Lite (رایگان):</b>
• ۱۰ گیگابایت ماهیانه | ۱ دستگاه همزمان | سرعت ۱۰ مگابیت

۲. <b>Sentra Pro (حرفه‌ای):</b>
• ۱۵۰ گیگابایت ماهیانه | ۳ دستگاه همزمان | سرعت ۱۰۰ مگابیت+
• دسترسی به نودهای Shadow و Pulse

۳. <b>Sentra Flow+ (اختصاصی هوش مصنوعی):</b>
• حجم نامحدود (سقف منصفانه ۱ ترابایت) | ۱۰ دستگاه همزمان | سرعت گیگابیتی
• <b>مجهز به IP مسکونی ثابت آمریکا (US Residential IP)</b>
• ۱۰۰٪ تضمین‌شده برای کار بدون خطای ریجن با <b>Google Flow</b>، <b>Gemini</b> و <b>Claude</b>"#;

        bot.send_message(msg.chat().id, text)
            .parse_mode(ParseMode::Html)
            .reply_markup(upgrade_plans_inline_keyboard())
            .await?;
    }
    Ok(())
}

pub async fn handle_upgrade_prompt(bot: &Bot, msg: &Message) -> anyhow::Result<()> {
    let text = r#"⚡ <b>تعرفه‌ها و پلن‌های ضدسانسور سنترا:</b>

۱. <b>Sentra Lite (رایگان):</b>
• ۱۰ گیگابایت ماهیانه | ۱ دستگاه همزمان | سرعت ۱۰ مگابیت

۲. <b>Sentra Pro (حرفه‌ای):</b>
• ۱۵۰ گیگابایت ماهیانه | ۳ دستگاه همزمان | سرعت ۱۰۰ مگابیت+
• دسترسی به نودهای Shadow و Pulse

۳. <b>Sentra Flow+ (اختصاصی هوش مصنوعی):</b>
• حجم نامحدود (سقف منصفانه ۱ ترابایت) | ۱۰ دستگاه همزمان | سرعت گیگابیتی
• <b>مجهز به IP مسکونی ثابت آمریکا (US Residential IP)</b>
• ۱۰۰٪ تضمین‌شده برای کار بدون خطای ریجن با <b>Google Flow</b>، <b>Gemini</b> و <b>Claude</b>

🧪 <i>جهت تست توسعه در محیط لوکال، روی دکمه شبیه‌ساز پرداخت زیر کلیک کنید:</i>"#;

    bot.send_message(msg.chat.id, text)
        .parse_mode(ParseMode::Html)
        .reply_markup(upgrade_plans_inline_keyboard())
        .await?;

    Ok(())
}

pub async fn handle_payment_simulation(
    bot: &Bot,
    q: &CallbackQuery,
    pool: &DbPool,
) -> anyhow::Result<()> {
    let telegram_id = q.from.id.0 as i64;

    let user = Repository::get_or_create_user(
        pool,
        telegram_id,
        q.from.username.as_deref(),
        &q.from.first_name,
        q.from.last_name.as_deref(),
    )
    .await?;

    let sub = Repository::upgrade_user_subscription(pool, user.id, "Sentra Flow+").await?;

    bot.answer_callback_query(q.id.clone())
        .text("✅ شبیه‌ساز پرداخت موفق! حساب شما به Sentra Flow+ ارتقا یافت.")
        .await?;

    let confirmation_text = format!(
        r#"🎉 <b>تراکنش تستی با موفقیت تایید شد!</b>

👑 <b>اشتراک شما به پلن ویژه {} ارتقا یافت.</b>
• توکن اشتراک: <code>{}</code>
• سقف حجم جدید: <b>۱ ترابایت (نامحدود)</b>
• سقف دستگاه همزمان: <b>۱۰ دستگاه</b>
• آی‌پی اختصاصی: <b>US Residential Static IP (آمریکا)</b>
• تاریخ انقضای جدید: <code>{}</code>

اکنون نرم‌افزار Sentra Connect و لینک‌های سابسکریپشن شما به بالاترین پهنای باند و تمام پروتکل‌ها دسترسی دارند."#,
        sub.tier,
        sub.token,
        sub.expires_at.format("%Y-%m-%d %H:%M UTC")
    );

    if let Some(msg) = &q.message {
        bot.send_message(msg.chat().id, confirmation_text)
            .parse_mode(ParseMode::Html)
            .reply_markup(back_to_main_inline_keyboard())
            .await?;
    }

    Ok(())
}

pub async fn handle_get_config_and_links(
    bot: &Bot,
    msg: &Message,
    pool: &DbPool,
    base_url: &str,
) -> anyhow::Result<()> {
    let telegram_user = match msg.from.as_ref() {
        Some(u) => u,
        None => return Ok(()),
    };

    let Some(user) = Repository::get_user_by_telegram_id(pool, telegram_user.id.0 as i64).await? else {
        return prompt_registration_required(bot, msg.chat.id).await;
    };

    let sub = Repository::create_or_ensure_lite_subscription(pool, user.id).await?;
    let code = Repository::generate_auth_code(pool, user.id).await?;

    let sub_url = format!("{}/api/v1/sub/{}", base_url, sub.token);

    // Output 1 & 2: Text with 8-digit App Login Code and V2Ray subscription URL
    let text = format!(
        r#"🔑 <b>اطلاعات ورود و اتصال ۳ گانه شما:</b>

۱️⃣ <b>کد ۸ رقمی ورود به اپلیکیشن Sentra Connect:</b>
👉 <b><code>{}</code></b> 👈
<i>(کد را داخل برنامه ویندوز یا اندروید وارد کنید تا نرم‌افزار بدون تنظیم دستی متصل شود).</i>

۲️⃣ <b>لینک سابسکریپشن هوشمند V2Ray / Sing-box / Clash:</b>
<code>{}</code>

۳️⃣ <b>فایل پیکربندی OpenVPN (.ovpn):</b>
<i>فایل پروفایل اختصاصی OpenVPN شما پیوست شد 👇</i>"#,
        code, sub_url
    );

    bot.send_message(msg.chat.id, text)
        .parse_mode(ParseMode::Html)
        .reply_markup(back_to_main_inline_keyboard())
        .await?;

    // Output 3: Generate and send the actual test .ovpn file as document
    let ovpn_content = compiler::generate_ovpn_profile(&sub, Some("web_browsing"));
    let ovpn_file = InputFile::memory(ovpn_content.into_bytes())
        .file_name(format!("sentra-{}.ovpn", &sub.token[..8]));

    bot.send_document(msg.chat.id, ovpn_file)
        .caption("🛡 پروفایل OpenVPN سنترا (رمزنگاری AES-256-GCM و tls-crypt)")
        .reply_markup(back_to_main_inline_keyboard())
        .await?;

    Ok(())
}

pub async fn handle_subscription_status(
    bot: &Bot,
    msg: &Message,
    pool: &DbPool,
) -> anyhow::Result<()> {
    let telegram_user = match msg.from.as_ref() {
        Some(u) => u,
        None => return Ok(()),
    };

    let Some(user) = Repository::get_user_by_telegram_id(pool, telegram_user.id.0 as i64).await? else {
        return prompt_registration_required(bot, msg.chat.id).await;
    };

    let mut sub = Repository::create_or_ensure_lite_subscription(pool, user.id).await?;
    let _ = Repository::check_and_reset_daily_quota(pool, &mut sub).await;
    let devices = Repository::get_user_devices(pool, user.id).await?;

    let synced_configs_count: usize = sqlx::query_scalar::<_, String>(
        "SELECT personal_configs_json FROM user_client_state WHERE user_id = ? LIMIT 1"
    )
    .bind(user.id)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten()
    .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
    .and_then(|v| v.as_array().map(|a| a.len()))
    .unwrap_or(0);

    let is_pro = sub.tier != "Sentra Lite";
    let total_used_bytes = (sub.upload_bytes + sub.download_bytes).max(0);
    let total_used_gb = total_used_bytes as f64 / (1024.0 * 1024.0 * 1024.0);
    let total_limit_gb = sub.traffic_limit_bytes.max(0) as f64 / (1024.0 * 1024.0 * 1024.0);
    let total_rem_gb = (sub.traffic_limit_bytes - total_used_bytes).max(0) as f64 / (1024.0 * 1024.0 * 1024.0);

    let static_limit_gb = 30.0;
    let static_used_gb = sub.static_ip_used_mb as f64 / 1024.0;
    let static_rem_gb = (static_limit_gb - static_used_gb).max(0.0);

    let quota_details = if is_pro {
        format!(
            r#"🌐 <b>سهمیه وب‌گردی:</b> <code>نامحدود (Unlimited)</code>
📥 <b>سهمیه دانلود:</b> <code>نامحدود (Unlimited)</code>
🔒 <b>سهمیه آی‌پی ثابت (ترید/جمنای):</b> <b>{:.1} GB باقیمانده از ۳۰ GB</b> (مصرف‌شده: {:.1} GB)"#,
            static_rem_gb, static_used_gb
        )
    } else {
        let wb_rem = (2048 - sub.web_browsing_used_mb).max(0) as f64 / 1024.0;
        let dl_rem = (3072 - sub.download_used_mb).max(0) as f64 / 1024.0;
        format!(
            r#"🌐 <b>وب‌گردی روزانه:</b> {:.2} GB باقیمانده از ۲ GB
📥 <b>دانلود روزانه:</b> {:.2} GB باقیمانده از ۳ GB
🔒 <b>آی‌پی ثابت:</b> 🔒 قفل (نیازمند ارتقا به اشتراک Pro)"#,
            wb_rem, dl_rem
        )
    };

    let platforms_summary = if devices.is_empty() {
        "بدون دستگاه ثبت‌شده".to_string()
    } else {
        devices
            .iter()
            .map(|d| format!("{} ({})", d.device_name, d.platform))
            .collect::<Vec<_>>()
            .join("، ")
    };

    let account_label = user
        .username
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .map(|u| format!("@{}", u))
        .unwrap_or_else(|| user.first_name.clone());

    let text = format!(
        r#"📊 <b>گزارش مصرف و وضعیت همگام‌شده حساب (ویندوز / اندروید / تلگرام):</b>

• حساب کاربری: <code>{}</code>
• سطح اشتراک: <b>{}</b>
• وضعیت سرویس: <code>{}</code>
• مصرف کل بسته: <b>{:.2} GB</b> مصرف‌شده / <b>{:.2} GB</b> باقیمانده (از {:.0} GB)
• دستگاه‌های متصل: <b>{} از {} دستگاه مجاز</b>
• پلتفرم‌های فعال: <i>{}</i>
• کانفیگ‌های شخصی همگام‌شده: <code>{}</code> مورد
• تاریخ اعتبار: <code>{}</code>

{}

💬 <i>تمام تغییرات اشتراک، مصرف و دستگاه‌ها به صورت لحظه‌ای با برنامه‌های ویندوز و اندروید همگام است.</i>"#,
        account_label,
        sub.tier,
        sub.status,
        total_used_gb,
        total_rem_gb,
        total_limit_gb,
        devices.len(),
        sub.max_concurrent_devices.max(3),
        platforms_summary,
        synced_configs_count,
        sub.expires_at.format("%Y-%m-%d %H:%M UTC"),
        quota_details
    );

    bot.send_message(msg.chat.id, text)
        .parse_mode(ParseMode::Html)
        .reply_markup(subscription_status_inline_keyboard(devices.len()))
        .await?;

    Ok(())
}

pub async fn handle_ticket_callback(
    bot: &Bot,
    q: &CallbackQuery,
    pool: &DbPool,
    category: &str,
) -> anyhow::Result<()> {
    let telegram_id = q.from.id.0 as i64;
    let user = Repository::get_or_create_user(
        pool,
        telegram_id,
        q.from.username.as_deref(),
        &q.from.first_name,
        q.from.last_name.as_deref(),
    )
    .await?;

    let (cat_title, desc) = match category {
        "speed" => ("افت سرعت", "کاربر گزارش افت سرعت یا کندی دانلود ثبت کرد."),
        "disconnect" => ("قطعی اتصال", "کاربر گزارش قطع مکرر ارتباط تانل ثبت کرد."),
        "ai" => ("هوش مصنوعی", "کاربر درخواست راهنمایی رفع خطای ریجن Google Flow / Gemini ثبت کرد."),
        _ => ("عمومی", "پیام پشتیبانی عمومی از ربات تلگرام."),
    };

    let ticket_num = Repository::create_support_ticket(
        pool,
        user.id,
        category,
        cat_title,
        desc,
    )
    .await?;

    bot.answer_callback_query(q.id.clone())
        .text("✅ تیکت پشتیبانی شما با موفقیت ثبت شد.")
        .await?;

    let reply = format!(
        r#"📨 <b>تیکت پشتیبانی شما ثبت گردید:</b>

• شماره تیکت: <code>{}</code>
• موضوع: <b>{}</b>
• وضعیت: <b>در صف رسیدگی کارشناس کشیک</b>

پاسخ کارشناسان سنترا مستقیماً از طریق همین ربات برای شما ارسال خواهد شد."#,
        ticket_num, cat_title
    );

    if let Some(msg) = &q.message {
        bot.send_message(msg.chat().id, reply)
            .parse_mode(ParseMode::Html)
            .reply_markup(back_to_main_inline_keyboard())
            .await?;
    }

    Ok(())
}

/// Builds smart entitlement-aware description text for the iOS config menu.
fn build_ios_menu_text(tier: &str, gaming_enabled: bool) -> String {
    let has_gaming = compiler::tier_has_gaming(tier);
    let has_static = compiler::tier_has_static_ip(tier);

    let mut lines = vec![
        "🍏 <b>دریافت کانفیگ اختصاصی iOS و مک</b>".to_string(),
        String::new(),
        format!("سطح اشتراک فعلی شما: <b>{}</b>", tier),
        String::new(),
        "کانفیگ‌های قابل مشاهده برای حساب شما:".to_string(),
        "🌐 <b>وب‌گردی روزمره (رایگان):</b> ۲ گیگابایت سهمیه روزانه (IKEv2 / OpenVPN)".to_string(),
        "⚡ <b>دانلود پرسرعت (رایگان):</b> ۳ گیگابایت سهمیه روزانه (IKEv2 / OpenVPN)".to_string(),
    ];

    if !gaming_enabled {
        lines.push(
            "🎮 <b>گیمینگ کم‌پینگ (به‌زودی):</b> این بخش به‌زودی با سرورهای کم‌پینگ و پروتکل <b>WireGuard</b> اضافه می‌شود.".to_string(),
        );
    } else if has_gaming {
        lines.push(
            "🎮 <b>گیمینگ کم‌پینگ (فعال):</b> تحویل مستقیم با پروتکل <b>WireGuard</b> برای کمترین پینگ و بدون جیتر".to_string(),
        );
    }
    if has_static {
        lines.push(
            "💎 <b>آی‌پی ثابت اختصاصی (فعال):</b> آی‌پی تمیز مسکونی آمریکا مناسب ترید و سرویس‌های بانکی/AI".to_string(),
        );
    }

    if !has_static && (!gaming_enabled || !has_gaming) {
        lines.push(String::new());
        lines.push(
            "💡 <i>کاربران رایگان به کانفیگ‌های رایگان دسترسی دارند. در صورت خرید اشتراک ویژه، گزینه‌های مربوطه به‌صورت هوشمند در همین منو فعال می‌شوند.</i>".to_string(),
        );
    }

    lines.push(String::new());
    lines.push("👇 <b>لطفاً کانفیگ مورد نظر خود را انتخاب نمایید:</b>".to_string());
    lines.join("\n")
}

/// Prompt iOS user with smart entitlement-aware config options
pub async fn handle_ios_subscription_prompt(
    bot: &Bot,
    msg: &Message,
    pool: &DbPool,
) -> anyhow::Result<()> {
    let telegram_user = match msg.from.as_ref() {
        Some(u) => u,
        None => return Ok(()),
    };

    let Some(user) = Repository::get_user_by_telegram_id(pool, telegram_user.id.0 as i64).await? else {
        return prompt_registration_required(bot, msg.chat.id).await;
    };

    let sub = match Repository::get_subscription_by_user_id(pool, user.id).await? {
        Some(s) => s,
        None => Repository::create_or_ensure_lite_subscription(pool, user.id).await?,
    };

    let gaming_enabled = Repository::has_active_gaming_outbounds(pool).await;
    let text = build_ios_menu_text(&sub.tier, gaming_enabled);

    bot.send_message(msg.chat.id, text)
        .parse_mode(ParseMode::Html)
        .reply_markup(ios_modes_inline_keyboard(&sub.tier, gaming_enabled))
        .await?;

    Ok(())
}

/// Handle selection of an iOS connection mode callback:
/// - Gaming shows "Coming Soon" until at least one active Gaming outbound exists in DB;
///   once enabled, it immediately issues an iOS WireGuard (.conf) profile for entitled users.
/// - Web Browsing / Download / Static IP show IKEv2 & OpenVPN protocol choices
pub async fn handle_ios_mode_selection(
    bot: &Bot,
    q: &CallbackQuery,
    pool: &DbPool,
    mode: &str,
    base_url: &str,
) -> anyhow::Result<()> {
    let telegram_user = &q.from;
    let user = Repository::get_or_create_user(
        pool,
        telegram_user.id.0 as i64,
        telegram_user.username.as_deref(),
        &telegram_user.first_name,
        telegram_user.last_name.as_deref(),
    )
    .await?;

    let mut sub = match Repository::get_subscription_by_user_id(pool, user.id).await? {
        Some(s) => s,
        None => Repository::create_or_ensure_lite_subscription(pool, user.id).await?,
    };

    // 1. Gaming mode: show Coming Soon alert until admin adds an active Gaming outbound
    if mode == "gaming" {
        if !Repository::has_active_gaming_outbounds(pool).await {
            bot.answer_callback_query(q.id.clone())
                .text("🎮 بخش گیمینگ به زودی اضافه می‌شود! به محض فعال‌سازی سرورهای گیمینگ، این بخش در کل اکوسیستم در دسترس خواهد بود.")
                .show_alert(true)
                .await?;
            return Ok(());
        }
        if !compiler::tier_has_gaming(&sub.tier) {
            bot.answer_callback_query(q.id.clone())
                .text("🔒 دسترسی به کانفیگ گیمینگ WireGuard مختص کاربران دارای اشتراک گیمینگ / Pro / Flow+ است.")
                .show_alert(true)
                .await?;
            return Ok(());
        }
        return handle_ios_send_wireguard(bot, q, pool, base_url).await;
    }

    // 2. Static IP is strictly enforced by tier entitlement
    if mode == "static_ip" && !compiler::tier_has_static_ip(&sub.tier) {
        bot.answer_callback_query(q.id.clone())
            .text("🔒 دسترسی به آی‌پی ثابت تمیز مسکونی آمریکا مختص کاربران دارای اشتراک آی‌پی ثابت / Pro / Flow+ است.")
            .show_alert(true)
            .await?;
        return Ok(());
    }

    // 3. Daily quota check & reset
    Repository::check_and_reset_daily_quota(pool, &mut sub).await?;
    if sub.tier == "Sentra Lite" {
        if mode == "web_browsing" && sub.web_browsing_used_mb >= 2048 {
            bot.answer_callback_query(q.id.clone())
                .text(format!(
                    "⚠️ سقف حجم ۲ گیگابایت روزانه وب‌گردی شما به پایان رسیده است ({}/2048 MB). سهمیه روزانه هر ۲۴ ساعت خودکار ریست می‌شود.",
                    sub.web_browsing_used_mb
                ))
                .show_alert(true)
                .await?;
            return Ok(());
        } else if mode == "download" && sub.download_used_mb >= 3072 {
            bot.answer_callback_query(q.id.clone())
                .text(format!(
                    "⚠️ سقف حجم ۳ گیگابایت روزانه دانلود شما به پایان رسیده است ({}/3072 MB). سهمیه روزانه هر ۲۴ ساعت خودکار ریست می‌شود.",
                    sub.download_used_mb
                ))
                .show_alert(true)
                .await?;
            return Ok(());
        }
    }

    let mode_fa = match mode {
        "download" => "⚡ دانلود (پایداری و سرعت بالا)",
        "static_ip" => "💎 آی‌پی ثابت مسکونی آمریکا (ترید و جمنای)",
        _ => "🌐 وب‌گردی روزمره (سهمیه ۲ گیگ)",
    };

    let text = format!(
        r#"🍏 <b>انتخاب پروتکل اتصال در iOS</b>

🔹 حالت انتخاب‌شده: <b>{}</b>

لطفاً پروتکل مورد نظر خود را برای اتصال انتخاب فرمایید:
• <b>⚡️ IKEv2 (پیشنهادی):</b> بدون نیاز به نصب هیچ برنامه‌ای! پروفایل را دانلود و با ۱ کلیک در تنظیمات آیفون فعال کنید.
• <b>🛡 OpenVPN:</b> اتصال از طریق نرم‌افزار رسمی OpenVPN Connect با پروتکل‌های UDP یا TCP."#,
        mode_fa
    );

    bot.answer_callback_query(q.id.clone()).await?;

    if let Some(msg) = &q.message {
        let _ = bot.edit_message_text(msg.chat().id, msg.id(), text)
            .parse_mode(ParseMode::Html)
            .reply_markup(ios_protocol_choice_keyboard(mode))
            .await;
    }

    Ok(())
}

/// Sends an ultra-low-latency WireGuard (.conf) gaming profile directly for iOS WireGuard app
pub async fn handle_ios_send_wireguard(
    bot: &Bot,
    q: &CallbackQuery,
    pool: &DbPool,
    base_url: &str,
) -> anyhow::Result<()> {
    let telegram_user = &q.from;
    let user = Repository::get_or_create_user(
        pool,
        telegram_user.id.0 as i64,
        telegram_user.username.as_deref(),
        &telegram_user.first_name,
        telegram_user.last_name.as_deref(),
    )
    .await?;

    let sub = match Repository::get_subscription_by_user_id(pool, user.id).await? {
        Some(s) => s,
        None => Repository::create_or_ensure_lite_subscription(pool, user.id).await?,
    };

    if user.status == "suspended" || user.status == "banned" || sub.status == "suspended" || sub.status == "disabled" {
        bot.answer_callback_query(q.id.clone())
            .text("⛔ حساب کاربری شما در حال حاضر غیرفعال است.")
            .show_alert(true)
            .await?;
        return Ok(());
    }

    if !Repository::has_active_gaming_outbounds(pool).await {
        bot.answer_callback_query(q.id.clone())
            .text("🎮 بخش گیمینگ به زودی اضافه می‌شود! به محض فعال‌سازی سرورهای گیمینگ، این بخش در کل اکوسیستم در دسترس خواهد بود.")
            .show_alert(true)
            .await?;
        return Ok(());
    }

    if !compiler::tier_has_gaming(&sub.tier) {
        bot.answer_callback_query(q.id.clone())
            .text("🔒 دسترسی به کانفیگ گیمینگ WireGuard نیازمند اشتراک گیمینگ، Pro یا Flow+ است.")
            .show_alert(true)
            .await?;
        return Ok(());
    }

    bot.answer_callback_query(q.id.clone())
        .text("🎮 در حال صدور کانفیگ اختصاصی WireGuard گیمینگ برای iOS...")
        .await?;

    let server_host = url::Url::parse(base_url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .unwrap_or_else(|| "127.0.0.1".to_string());

    let (wg_conf, _client_pub, client_addr) =
        compiler::generate_wireguard_gaming_profile(&sub, &server_host);
    let token_prefix: String = sub.token.chars().take(8).collect();
    let wg_file = InputFile::memory(wg_conf.into_bytes())
        .file_name(format!("sentra-gaming-wg-{}.conf", token_prefix));

    let caption = format!(
        r#"🎮 <b>کانفیگ اختصاصی گیمینگ سنترا برای iOS (پروتکل WireGuard)</b>

🔹 <b>پروتکل:</b> WireGuard (بهینه‌سازی شده با MTU 1280 و کمترین پینگ/جیتر)
🔹 <b>آی‌پی تانل اختصاصی:</b> <code>{}</code>
🔹 <b>پلن اشتراک:</b> {}
🔹 <b>اعتبار:</b> {}

📋 <b>راهنمای اتصال سریع در آیفون/آیپد:</b>
۱. اپلیکیشن رسمی <b>WireGuard</b> را از App Store دانلود و نصب کنید.
۲. فایل پیوست بالا (<code>sentra-gaming-wg-{}.conf</code>) را لمس کرده و دکمه <b>Share (اشتراک‌گذاری)</b> را بزنید.
۳. از لیست برنامه‌ها، <b>WireGuard</b> را انتخاب کنید تا تانل به‌صورت خودکار وارد شود.
۴. سوئیچ اتصال را روشن کنید و از بازی آنلاین بدون لگ و پکت‌لاس لذت ببرید!"#,
        client_addr,
        sub.tier,
        sub.expires_at.format("%Y-%m-%d"),
        token_prefix
    );

    if let Some(msg) = &q.message {
        bot.send_document(msg.chat().id, wg_file)
            .caption(caption)
            .parse_mode(ParseMode::Html)
            .reply_markup(cancel_and_back_inline_keyboard("ios_sub_back_to_modes"))
            .await?;
    }

    Ok(())
}

/// Sends Apple .mobileconfig profile for one-click IKEv2 installation on iOS
pub async fn handle_ios_send_ikev2(
    bot: &Bot,
    q: &CallbackQuery,
    pool: &DbPool,
    mode: &str,
    base_url: &str,
) -> anyhow::Result<()> {
    let telegram_user = &q.from;
    let user = Repository::get_or_create_user(
        pool,
        telegram_user.id.0 as i64,
        telegram_user.username.as_deref(),
        &telegram_user.first_name,
        telegram_user.last_name.as_deref(),
    )
    .await?;

    let sub = match Repository::get_subscription_by_user_id(pool, user.id).await? {
        Some(s) => s,
        None => Repository::create_or_ensure_lite_subscription(pool, user.id).await?,
    };

    if mode == "static_ip" && !compiler::tier_has_static_ip(&sub.tier) {
        bot.answer_callback_query(q.id.clone())
            .text("🔒 دسترسی به آی‌پی ثابت مختص اشتراک‌های دارای آی‌پی ثابت است.")
            .show_alert(true)
            .await?;
        return Ok(());
    }
    if mode == "gaming" {
        return handle_ios_send_wireguard(bot, q, pool, base_url).await;
    }

    bot.answer_callback_query(q.id.clone())
        .text("✅ در حال صدور پروفایل بومی IKEv2 برای آیفون...")
        .await?;

    let server_host = url::Url::parse(base_url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .unwrap_or_else(|| "127.0.0.1".to_string());

    let mobileconfig_xml = compiler::generate_mobileconfig_profile(&sub, mode, &server_host);
    let config_file = InputFile::memory(mobileconfig_xml.into_bytes())
        .file_name(format!("sentra-{}-{}.mobileconfig", mode, &sub.token[..8]));

    let mode_fa = match mode {
        "download" => "دانلود",
        "static_ip" => "آی‌پی ثابت مسکونی",
        _ => "وب‌گردی",
    };

    let caption = format!(
        r#"🍏 <b>پروفایل اختصاصی IKEv2 سنترا (بدون نیاز به برنامه)</b>

🔹 <b>حالت:</b> {}
🔹 <b>پلن اشتراک:</b> {}
🔹 <b>تاریخ انقضا:</b> {}

📱 <b>راهنمای نصب خودکار در آیفون/آیپد:</b>
۱. فایل پیوست بالا (<code>sentra-{}.mobileconfig</code>) را لمس کرده و در پنجره مرورگر دکمه <b>Allow</b> را بزنید.
۲. وارد <b>Settings (تنظیمات)</b> آیفون شوید. در بالای لیست، گزینه <b>Profile Downloaded</b> ظاهر شده است، آن را لمس کنید.
۳. در گوشه بالا دکمه <b>Install</b> را بزنید و رمز عبور گوشی را وارد فرمایید تا نصب تکمیل گردد.
۴. اکنون وی‌پی‌ان Sentra به صورت بومی در تنظیمات شبکه آیفون شما فعال است!

🔑 <b>مشخصات اتصال دستی:</b>
• سرور: <code>{}</code>
• شناسه (Remote ID): <code>{}</code>
• نام کاربری: <code>{}</code>
• رمز عبور: <code>{}</code>"#,
        mode_fa,
        sub.tier,
        sub.expires_at.format("%Y-%m-%d"),
        mode,
        server_host,
        server_host,
        sub.token,
        sub.token
    );

    if let Some(msg) = &q.message {
        bot.send_document(msg.chat().id, config_file)
            .caption(caption)
            .parse_mode(ParseMode::Html)
            .reply_markup(cancel_and_back_inline_keyboard("ios_sub_back_to_modes"))
            .await?;
    }

    Ok(())
}

/// Sends OpenVPN .ovpn profile (UDP or TCP) for iOS OpenVPN Connect
pub async fn handle_ios_send_openvpn(
    bot: &Bot,
    q: &CallbackQuery,
    pool: &DbPool,
    mode: &str,
    protocol: &str,
    base_url: &str,
) -> anyhow::Result<()> {
    let telegram_user = &q.from;
    let user = Repository::get_or_create_user(
        pool,
        telegram_user.id.0 as i64,
        telegram_user.username.as_deref(),
        &telegram_user.first_name,
        telegram_user.last_name.as_deref(),
    )
    .await?;

    let sub = match Repository::get_subscription_by_user_id(pool, user.id).await? {
        Some(s) => s,
        None => Repository::create_or_ensure_lite_subscription(pool, user.id).await?,
    };

    if mode == "static_ip" && !compiler::tier_has_static_ip(&sub.tier) {
        bot.answer_callback_query(q.id.clone())
            .text("🔒 دسترسی به آی‌پی ثابت مختص اشتراک‌های دارای آی‌پی ثابت است.")
            .show_alert(true)
            .await?;
        return Ok(());
    }
    if mode == "gaming" {
        return handle_ios_send_wireguard(bot, q, pool, base_url).await;
    }

    bot.answer_callback_query(q.id.clone())
        .text(format!("✅ در حال صدور کانفیگ OpenVPN ({})...", protocol))
        .await?;

    let server_host = url::Url::parse(base_url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .unwrap_or_else(|| "127.0.0.1".to_string());

    let ovpn_content = compiler::generate_ovpn_profile_ext(&sub, Some(mode), protocol, &server_host);
    let ovpn_file = InputFile::memory(ovpn_content.into_bytes())
        .file_name(format!("sentra-{}-{}-{}.ovpn", mode, protocol, &sub.token[..8]));

    let (mode_fa, mode_desc) = match mode {
        "download" => ("دانلود فوق‌سریع", "بهینه‌سازی شده برای انتقال حجم و فایل با پایداری حداکثری"),
        "static_ip" => ("آی‌پی ثابت مسکونی آمریکا", "مسیریابی با IP تمیز اختصاصی ترید در صرافی‌ها و سرویس‌های هوش مصنوعی (Google Gemini)"),
        _ => ("وب‌گردی روزمره", "سهمیه ۲ گیگابایت روزانه مناسب مرور سریع سایت‌ها و شبکه‌های اجتماعی"),
    };

    let proto_title = if protocol.contains("tcp") {
        "OpenVPN TCP (پورت 443 - پایداری در اختلالات شدید)"
    } else {
        "OpenVPN UDP (پروتکل استاندارد پرسرعت)"
    };

    let caption = format!(
        r#"🍏 <b>کانفیگ اختصاصی OpenVPN سنترا (iOS)</b>

🔹 <b>پروتکل:</b> {}
🔹 <b>حالت:</b> {}
🔹 <b>توضیح فنی:</b> {}
🔹 <b>پلن اشتراک:</b> {}
🔹 <b>اعتبار:</b> {}

📋 <b>راهنمای اتصال سریع در آیفون/آیپد:</b>
۱. نرم‌افزار رسمی <b>OpenVPN Connect</b> را از App Store دانلود و نصب کنید.
۲. فایل پیوست بالا را لمس کرده و دکمه Share (اشتراک‌گذاری) را بزنید.
۳. از لیست برنامه‌ها، <b>OpenVPN</b> را انتخاب کنید تا فایل درون آن ایمپورت شود.
۴. در برنامه OpenVPN، دکمه <b>ADD</b> را زده و سوئیچ اتصال را روشن کنید."#,
        proto_title,
        mode_fa,
        mode_desc,
        sub.tier,
        sub.expires_at.format("%Y-%m-%d")
    );

    if let Some(msg) = &q.message {
        bot.send_document(msg.chat().id, ovpn_file)
            .caption(caption)
            .parse_mode(ParseMode::Html)
            .reply_markup(cancel_and_back_inline_keyboard("ios_sub_back_to_modes"))
            .await?;
    }

    Ok(())
}

/// Returns iOS user back to the smart entitlement-aware connection modes selection
pub async fn handle_ios_back_to_modes(
    bot: &Bot,
    q: &CallbackQuery,
    pool: &DbPool,
) -> anyhow::Result<()> {
    let telegram_user = &q.from;
    let user = Repository::get_or_create_user(
        pool,
        telegram_user.id.0 as i64,
        telegram_user.username.as_deref(),
        &telegram_user.first_name,
        telegram_user.last_name.as_deref(),
    )
    .await?;

    let sub = match Repository::get_subscription_by_user_id(pool, user.id).await? {
        Some(s) => s,
        None => Repository::create_or_ensure_lite_subscription(pool, user.id).await?,
    };

    let gaming_enabled = Repository::has_active_gaming_outbounds(pool).await;
    let prompt = build_ios_menu_text(&sub.tier, gaming_enabled);

    bot.answer_callback_query(q.id.clone()).await?;

    if let Some(msg) = &q.message {
        if bot
            .edit_message_text(msg.chat().id, msg.id(), prompt.clone())
            .parse_mode(ParseMode::Html)
            .reply_markup(ios_modes_inline_keyboard(&sub.tier, gaming_enabled))
            .await
            .is_err()
        {
            let _ = bot
                .send_message(msg.chat().id, prompt)
                .parse_mode(ParseMode::Html)
                .reply_markup(ios_modes_inline_keyboard(&sub.tier, gaming_enabled))
                .await;
        }
    }

    Ok(())
}

/// Manage connected devices callback (Max 3 Devices)
pub async fn handle_manage_devices_callback(
    bot: &Bot,
    q: &CallbackQuery,
    pool: &DbPool,
) -> anyhow::Result<()> {
    let telegram_user = &q.from;
    let user = Repository::get_or_create_user(
        pool,
        telegram_user.id.0 as i64,
        telegram_user.username.as_deref(),
        &telegram_user.first_name,
        telegram_user.last_name.as_deref(),
    )
    .await?;

    let devices = Repository::get_user_devices(pool, user.id).await?;

    let text = format!(
        r#"📱 <b>مدیریت دستگاه‌های متصل به حساب سنترا:</b>

• تعداد دستگاه‌های فعال: <b>{} از ۳ دستگاه مجاز</b>
• وضعیت سقف: <b>{}</b>

💡 <i>سقف مجاز هر حساب حداکثر ۳ دستگاه فعال همزمان است. در صورت نیاز به افزودن دستگاه جدید، می‌توانید دستگاه‌های قبلی را با زدن دکمه ❌ حذف کنید:</i>"#,
        devices.len(),
        if devices.len() >= 3 { "🔴 تکمیل شده (نیاز به آزادسازی)" } else { "🟢 فضا برای دستگاه جدید موجود است" }
    );

    if let Some(msg) = &q.message {
        bot.edit_message_text(msg.chat().id, msg.id(), text)
            .parse_mode(ParseMode::Html)
            .reply_markup(user_devices_inline_keyboard(&devices))
            .await?;
    }

    let _ = bot.answer_callback_query(q.id.clone()).await;
    Ok(())
}

/// Delete a device callback
pub async fn handle_delete_device_callback(
    bot: &Bot,
    q: &CallbackQuery,
    pool: &DbPool,
    device_id_str: &str,
) -> anyhow::Result<()> {
    let telegram_user = &q.from;
    let user = Repository::get_or_create_user(
        pool,
        telegram_user.id.0 as i64,
        telegram_user.username.as_deref(),
        &telegram_user.first_name,
        telegram_user.last_name.as_deref(),
    )
    .await?;

    let deleted = Repository::delete_user_device(pool, user.id, device_id_str).await?;

    if deleted {
        bot.answer_callback_query(q.id.clone())
            .text("✅ دستگاه با موفقیت از حساب شما حذف شد و فضا آزاد گردید.")
            .show_alert(false)
            .await?;
    } else {
        bot.answer_callback_query(q.id.clone())
            .text("⚠️ دستگاه مورد نظر یافت نشد یا قبلاً حذف شده است.")
            .await?;
    }

    // Refresh devices view
    let devices = Repository::get_user_devices(pool, user.id).await?;
    let text = format!(
        r#"📱 <b>مدیریت دستگاه‌های متصل به حساب سنترا:</b>

• تعداد دستگاه‌های فعال: <b>{} از ۳ دستگاه مجاز</b>
• وضعیت سقف: <b>{}</b>

💡 <i>دستگاه انتخابی با موفقیت حذف گردید. اکنون می‌توانید با دستگاه جدید خود وارد شوید:</i>"#,
        devices.len(),
        if devices.len() >= 3 { "🔴 تکمیل شده (نیاز به آزادسازی)" } else { "🟢 فضا برای دستگاه جدید موجود است" }
    );

    if let Some(msg) = &q.message {
        bot.edit_message_text(msg.chat().id, msg.id(), text)
            .parse_mode(ParseMode::Html)
            .reply_markup(user_devices_inline_keyboard(&devices))
            .await?;
    }

    Ok(())
}

/// Prompt explaining Community Outbound Donation
pub async fn handle_donation_prompt(bot: &Bot, msg: &Message) -> anyhow::Result<()> {
    if let Some(u) = msg.from.as_ref() {
        set_user_state(u.id.0 as i64, UserState::AwaitingDonationLink).await;
    }

    let text = r#"🤝 <b>سامانه اهدای اوتباند و مشارکت در شبکه ضدسانسور Sentra:</b>

سنترا یک اکوسیستم غیرمتمرکز است که به جامعه کاربران خود متکی است. اگر یک سرور شخصی، کانفیگ اختصاصی یا پروتکل ضدفیلتر پایدار دارید، می‌توانید آن را به شبکه اهدا کنید تا در استخر عمومی جهت وب‌گردی و دور زدن سانسور استفاده شود.

🛡 <b>قوانین امنیتی و بنچمارک:</b>
• تمامی لینک‌ها توسط لایه ضد-SSRF اسکن شده و رنج آی‌پی‌های محلی یا ناامن مسدود می‌شوند.
• سرور با بنچمارک بلادرنگ سنجیده شده و در صورت پینگ زیر ۲۵۰۰ms و پهنای باند مناسب تایید می‌گردد.
• سرورهای پرسرعت در استخر دانلود و سرورهای معمولی در استخر وب‌گردی قرار می‌گیرند.

🎁 <b>قانون پاداش ویژه اشتراک ماهانه (بالای ۲۰۰ گیگابایت):</b>
اگر اوتباند اهدایی دارای <b>ظرفیت بالای ۲۰۰ گیگابایت</b> باشد، به محض اینکه وارد چرخه استفاده کاربران رایگان شد و <b>اولین ترافیک واقعی</b> از آن عبور کرد، سیستم به صورت خودکار <b>۳۰ روز اشتراک ویژه Sentra Pro هدیه</b> روی حساب شما فعال خواهد کرد!

📥 <b>نحوه اهدا:</b>
لینک کانفیگ خود را به همراه حجم آن در این چت ارسال نمایید (مثال: <code>vless://... 250GB</code> یا ارسال لینک و در ادامه نوشتن عدد حجم)."#;

    bot.send_message(msg.chat.id, text)
        .parse_mode(ParseMode::Html)
        .reply_markup(back_to_main_inline_keyboard())
        .await?;
    Ok(())
}

/// Prompt explaining Financial Support / Donation
pub async fn handle_financial_donation_prompt(
    bot: &Bot,
    msg: &Message,
    pro_price: i64,
) -> anyhow::Result<()> {
    if let Some(u) = msg.from.as_ref() {
        set_user_state(u.id.0 as i64, UserState::AwaitingReceiptPhoto).await;
    }

    let double_price = pro_price * 2;
    let text = format!(
        r#"💖 <b>حمایت مالی از توسعه و پایداری شبکه سنترا (Sentra):</b>

تمام حمایت‌های مالی شما مستقیماً صرف توسعه بهتر برنامه، افزایش پایداری و بهبود کیفیت سرویس خواهد شد.

پلتفرم سنترا با هدف دسترسی آزاد، امن و پایدار به اینترنت بین‌المللی برای عموم هم‌وطنان توسعه یافته است. همراهی مالی شما ما را در تامین سرورهای ضدفیلتر قوی‌تر، خرید ترافیک تمیز و بهینه‌سازی کلاینت‌ها یاری می‌رساند.

💳 <b>اطلاعات واریز حمایت مالی:</b>
• <b>شماره کارت (بانک ملی/سامان):</b>
<code>6037-9979-1234-5678</code>
(به نام مهندسی زیرساخت شبکه سنترا)
• <b>آدرس تتر (USDT - شبکه TRC20):</b>
<code>TLyVwN1xG4uQ9E7sJ6H5K4L3M2N1P0QRS</code>
• <b>آدرس تون‌کوین (TON):</b>
<code>UQDxSentraDonationWalletAddressOfficialNode</code>

🎁 <b>قانون پاداش و قدردانی سنترا:</b>
هزینه ماهانه اشتراک Pro معادل <b>{} تومان</b> است.
در صورتی که مبلغ حمایت مالی شما <b>بیشتر از ۲ برابر هزینه اشتراک ماهانه (بیش از {} تومان)</b> باشد، پس از بررسی و تایید فیش توسط ادمین، یک <b>اشتراک ویژه ۳۰ روزه Sentra Pro</b> نیز به عنوان قدردانی روی حساب شما فعال خواهد شد!

📤 <b>نحوه ارسال رسید:</b>
لطفاً پس از واریز، <b>تصویر فیش/رسید</b> را همراه با <b>مبلغ واریزی در کپشن عکس</b> (مثلاً <code>350,000</code> یا <code>400000</code>) در همین چت ارسال نمایید."#,
        pro_price, double_price
    );

    bot.send_message(msg.chat.id, text)
        .parse_mode(ParseMode::Html)
        .reply_markup(back_to_main_inline_keyboard())
        .await?;

    Ok(())
}

/// Handle incoming proxy link or JSON donation submission
pub async fn handle_donation_submission(
    bot: &Bot,
    msg: &Message,
    pool: &DbPool,
    raw_text: &str,
) -> anyhow::Result<()> {
    let telegram_user = match msg.from.as_ref() {
        Some(u) => u,
        None => return Ok(()),
    };

    clear_user_state(telegram_user.id.0 as i64).await;

    let user = Repository::get_or_create_user(
        pool,
        telegram_user.id.0 as i64,
        telegram_user.username.as_deref(),
        &telegram_user.first_name,
        telegram_user.last_name.as_deref(),
    )
    .await?;

    let queue_msg = r#"⏳ <b>در حال ارزیابی و بنچمارک هوشمند سرور اهدایی...</b>

سرور شما در صف بررسی امنیتی (Anti-SSRF)، تست تاخیر اتصال (Handshake Latency) و بنچمارک سرعت قرار گرفت.
نتیجه ارزیابی و پاداش اشتراک ظرف چند ثانیه آینده ارسال خواهد شد."#;

    bot.send_message(msg.chat.id, queue_msg)
        .parse_mode(ParseMode::Html)
        .reply_markup(back_to_main_inline_keyboard())
        .await?;

    let pool_clone = pool.clone();
    let bot_clone = bot.clone();
    let raw_clone = raw_text.to_string();
    let user_id = user.id;
    let tid = telegram_user.id.0 as i64;

    tokio::spawn(async move {
        crate::outbound_analyzer::OutboundAnalyzer::process_donation(
            pool_clone,
            bot_clone,
            Some(user_id),
            Some(tid),
            raw_clone,
        )
        .await;
    });

    Ok(())
}

/// Prompt explaining Account Linking
pub async fn handle_link_account_prompt(
    bot: &Bot,
    msg: &Message,
    pool: &DbPool,
) -> anyhow::Result<()> {
    let telegram_user = match msg.from.as_ref() {
        Some(u) => u,
        None => return Ok(()),
    };

    let user = Repository::get_or_create_user(
        pool,
        telegram_user.id.0 as i64,
        telegram_user.username.as_deref(),
        &telegram_user.first_name,
        telegram_user.last_name.as_deref(),
    )
    .await?;

    set_user_state(telegram_user.id.0 as i64, UserState::AwaitingLinkCode).await;

    let code = Repository::generate_link_code(pool, user.id).await?;

    let text = format!(
        r#"🔗 <b>یکپارچه‌سازی و اتصال حساب کاربری Sentra:</b>

با اتصال حساب، اشتراک و سهمیه‌های شما در ربات تلگرام، اپلیکیشن ویندوز و کلاینت اندروید همگام می‌شوند.

🔹 <b>روش اول: اگر در اپلیکیشن ویندوز/اندروید ثبت‌نام کرده‌اید:</b>
کد ۶ رقمی اتصال را از اپلیکیشن دریافت کرده و مستقیماً همینجا ارسال کنید یا از دستور زیر استفاده کنید:
<code>/link 123456</code> (کد ۶ رقمی دریافتی از اپلیکیشن)

🔹 <b>روش دوم: تعیین نام کاربری و پسورد برای همین اکانت تلگرام:</b>
می‌توانید برای ورود مستقیم در اپلیکیشن، مشخصات خود را با دستور زیر تنظیم کنید:
<code>/setpassword myusername mypassword</code>

🔹 <b>روش سوم: اتصال با کد تلگرام:</b>
کد اتصال ۶ رقمی این اکانت تلگرام شما:
کد موقت: <b><code>{}</code></b> (معتبر به مدت ۵ دقیقه)"#,
        code
    );

    bot.send_message(msg.chat.id, text)
        .parse_mode(ParseMode::Html)
        .reply_markup(back_to_main_inline_keyboard())
        .await?;

    Ok(())
}

/// Handle /link command with or without 6-digit code
pub async fn handle_link_command(
    bot: &Bot,
    msg: &Message,
    pool: &DbPool,
    args: &str,
) -> anyhow::Result<()> {
    let telegram_user = match msg.from.as_ref() {
        Some(u) => u,
        None => return Ok(()),
    };

    let tid = telegram_user.id.0 as i64;
    let trimmed = args.trim();

    if trimmed.is_empty() {
        // Issue new link code for this user
        let user = Repository::get_or_create_user(
            pool,
            tid,
            telegram_user.username.as_deref(),
            &telegram_user.first_name,
            telegram_user.last_name.as_deref(),
        )
        .await?;
        let code = Repository::generate_link_code(pool, user.id).await?;

        let text = format!(
            r#"🔗 <b>کد موقت اتصال حساب شما:</b>

کد ۶ رقمی: <b><code>{}</code></b>
⏳ این کد به مدت <b>۵ دقیقه</b> معتبر است.

می‌توانید این کد را در بخش اتصال اپلیکیشن وارد کنید تا دستگاه شما به این حساب تلگرام متصل گردد."#,
            code
        );
        bot.send_message(msg.chat.id, text)
            .parse_mode(ParseMode::Html)
            .reply_markup(back_to_main_inline_keyboard())
            .await?;
        return Ok(());
    }

    if trimmed.len() != 6 || !trimmed.chars().all(|c| c.is_ascii_digit()) {
        bot.send_message(
            msg.chat.id,
            "⚠️ کد اتصال باید یک عدد ۶ رقمی باشد. مثال: <code>/link 123456</code>",
        )
        .parse_mode(ParseMode::Html)
        .reply_markup(back_to_main_inline_keyboard())
        .await?;
        return Ok(());
    }

    match Repository::link_telegram_account_by_code(
        pool,
        tid,
        trimmed,
        &telegram_user.first_name,
        telegram_user.username.as_deref(),
    )
    .await {
        Ok(user) => {
            clear_user_state(tid).await;
            let text = format!(
                r#"🎉 <b>حساب کاربری با موفقیت متصل شد!</b>

• نام کاربری: <code>{}</code>
• شناسه یکپارچه: <code>{}</code>

اکنون حساب اپلیکیشن شما با این اکانت تلگرام یکپارچه شد. تمام دستگاه‌ها و اشتراک فعال شما به این حساب واحد پیوند داده شدند."#,
                user.username.as_deref().unwrap_or("کاربر سنترا"),
                user.user_uuid
            );
            bot.send_message(msg.chat.id, text)
                .parse_mode(ParseMode::Html)
                .reply_markup(back_to_main_inline_keyboard())
                .await?;
        }
        Err(e) => {
            let err_msg = match e {
                crate::error::CoreError::AuthFailed(msg) => msg,
                _ => "کد اتصال نامعتبر است یا منقضی شده است.".to_string(),
            };
            let text = format!("❌ <b>خطا در اتصال حساب:</b>\n\n{}", err_msg);
            bot.send_message(msg.chat.id, text)
                .parse_mode(ParseMode::Html)
                .reply_markup(back_to_main_inline_keyboard())
                .await?;
        }
    }

    Ok(())
}

/// Handle /setpassword <username> <password> command
pub async fn handle_setpassword_command(
    bot: &Bot,
    msg: &Message,
    pool: &DbPool,
    args: &str,
) -> anyhow::Result<()> {
    let telegram_user = match msg.from.as_ref() {
        Some(u) => u,
        None => return Ok(()),
    };

    let tid = telegram_user.id.0 as i64;
    let parts: Vec<&str> = args.split_whitespace().collect();

    if parts.len() != 2 {
        bot.send_message(
            msg.chat.id,
            "⚠️ فرمت دستور نادرست است.\nفرمت صحیح: <code>/setpassword username password</code>\nمثال: <code>/setpassword ali_reza 12345678</code>",
        )
        .parse_mode(ParseMode::Html)
        .reply_markup(back_to_main_inline_keyboard())
        .await?;
        return Ok(());
    }

    let username = parts[0].trim().to_lowercase();
    let password = parts[1].trim();

    if username.len() < 3 || username.len() > 32 || !username.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        bot.send_message(
            msg.chat.id,
            "⚠️ نام کاربری باید بین ۳ تا ۳۲ کاراکتر و فقط شامل حروف انگلیسی، اعداد و زیرخط (_) باشد.",
        )
        .reply_markup(back_to_main_inline_keyboard())
        .await?;
        return Ok(());
    }

    if password.len() < 6 {
        bot.send_message(
            msg.chat.id,
            "⚠️ رمز عبور باید حداقل ۶ کاراکتر باشد.",
        )
        .reply_markup(back_to_main_inline_keyboard())
        .await?;
        return Ok(());
    }

    let user = Repository::get_or_create_user(
        pool,
        tid,
        telegram_user.username.as_deref(),
        &telegram_user.first_name,
        telegram_user.last_name.as_deref(),
    )
    .await?;

    match Repository::set_credentials_for_user(pool, user.id, &username, password).await {
        Ok(_) => {
            let text = format!(
                r#"✅ <b>اطلاعات ورود اپلیکیشن با موفقیت تنظیم شد!</b>

👤 <b>نام کاربری:</b> <code>{}</code>
🔑 <b>رمز عبور:</b> <code>{}</code>

اکنون می‌توانید در اپلیکیشن کلاینت ویندوز و اندروید از تب <b>«ورود با حساب کاربری»</b> استفاده نمایید."#,
                username, password
            );
            bot.send_message(msg.chat.id, text)
                .parse_mode(ParseMode::Html)
                .reply_markup(back_to_main_inline_keyboard())
                .await?;
        }
        Err(e) => {
            let text = format!("❌ خطا در تنظیم مشخصات: {}", e);
            bot.send_message(msg.chat.id, text)
                .reply_markup(back_to_main_inline_keyboard())
                .await?;
        }
    }

    Ok(())
}

/// Show app download menu with OS selection buttons
pub async fn handle_download_app_menu(
    bot: &Bot,
    msg: &Message,
) -> anyhow::Result<()> {
    let text = r#"📥 <b>دانلود اپلیکیشن اختصاصی Sentra Connect</b>

نرم‌افزار هوشمند سنترا کانکت مجهز به سیستم سوییچ خودکار پروتکل و ضدفیلترینگ هوشمند:
• اتصال تک‌کلیک و بدون قطعی
• حالت‌های هوشمند اتصال (وب‌گردی، دانلود پرسرعت و آی‌پی ثابت)
• محافظت نشت DNS و Kill Switch داخلی

👇 <b>لطفاً سیستم‌عامل دستگاه خود را جهت دانلود انتخاب نمایید:</b>"#;

    bot.send_message(msg.chat.id, text)
        .parse_mode(ParseMode::Html)
        .reply_markup(download_app_inline_keyboard())
        .await?;

    Ok(())
}

/// Handle download for Windows or Android directly via Telegram file_id
pub async fn handle_download_platform_callback(
    bot: &Bot,
    q: &CallbackQuery,
    pool: &DbPool,
    platform: &str,
) -> anyhow::Result<()> {
    let release_opt = Repository::get_app_release_by_platform(pool, platform).await?;

    match release_opt {
        Some(release) => {
            let platform_fa = if release.platform == "windows" {
                "ویندوز (Windows 10/11)"
            } else {
                "اندروید (Android)"
            };

            let caption = format!(
                r#"🚀 <b>اپلیکیشن اختصاصی Sentra Connect برای {}</b>

🔹 <b>نسخه:</b> <code>{}</code>
📦 <b>حجم فایل:</b> <b>{:.2} مگابایت</b>
📝 <b>تغییرات این نسخه:</b>
{}

💡 <b>راهنمای ورود و استفاده:</b>
۱. فایل را دانلود و نصب نمایید.
۲. می‌توانید مستقیماً داخل برنامه حساب کاربری جدید ایجاد کنید، یا
۳. از دکمه «🔗 اتصال حساب اپلیکیشن» در ربات، کد یکبارمصرف یا لینک سریع دریافت کرده و در برنامه وارد نمایید."#,
                platform_fa,
                release.version,
                release.file_size_mb,
                if release.changelog.is_empty() {
                    "نسخه رسمی با قابلیت سوییچ هوشمند پروتکل‌ها و ضد فیلترینگ"
                } else {
                    &release.changelog
                }
            );

            // Send document directly via Telegram file_id (instant delivery, 0 server bandwidth)
            if let Some(msg) = &q.message {
                bot.send_document(msg.chat().id, InputFile::file_id(release.telegram_file_id))
                    .caption(caption)
                    .parse_mode(ParseMode::Html)
                    .reply_markup(back_to_main_inline_keyboard())
                    .await?;
            }
            bot.answer_callback_query(q.id.clone())
                .text(format!("فایل نصبی {} ارسال شد.", platform_fa))
                .await?;
        }
        None => {
            let msg_text = if platform == "android" {
                "⏳ نسخه اندروید در حال آماده‌سازی نهایی است و به‌زودی از همین بخش منتشر می‌شود."
            } else {
                "⏳ نسخه ویندوز در حال آماده‌سازی نهایی است و به‌زودی از همین بخش منتشر می‌شود."
            };

            if let Some(msg) = &q.message {
                bot.send_message(msg.chat().id, msg_text)
                    .reply_markup(back_to_main_inline_keyboard())
                    .await?;
            }
            bot.answer_callback_query(q.id.clone())
                .text(msg_text)
                .show_alert(true)
                .await?;
        }
    }

    Ok(())
}

/// Handle iOS selection from download menu (connects to OpenVPN iOS guide)
pub async fn handle_ios_download_callback(
    bot: &Bot,
    q: &CallbackQuery,
    pool: &DbPool,
) -> anyhow::Result<()> {
    let telegram_user = &q.from;
    let user = match Repository::get_user_by_telegram_id(pool, telegram_user.id.0 as i64).await? {
        Some(u) => u,
        None => {
            if let Some(msg) = &q.message {
                bot.send_message(
                    msg.chat().id,
                    "📝 <b>ابتدا ثبت نام یا وارد حساب کاربری شوید</b>\n\nبرای دریافت کانفیگ iOS ابتدا باید ثبت نام کنید یا با حساب برنامه خود وارد شوید:",
                )
                .parse_mode(ParseMode::Html)
                .reply_markup(auth_choice_inline_keyboard())
                .await?;
            }
            bot.answer_callback_query(q.id.clone()).await?;
            return Ok(());
        }
    };

    let sub = match Repository::get_subscription_by_user_id(pool, user.id).await? {
        Some(s) => s,
        None => Repository::create_or_ensure_lite_subscription(pool, user.id).await?,
    };

    let gaming_enabled = Repository::has_active_gaming_outbounds(pool).await;
    let text = build_ios_menu_text(&sub.tier, gaming_enabled);

    if let Some(msg) = &q.message {
        bot.send_message(msg.chat().id, text)
            .parse_mode(ParseMode::Html)
            .reply_markup(ios_modes_inline_keyboard(&sub.tier, gaming_enabled))
            .await?;
    }
    bot.answer_callback_query(q.id.clone()).await?;
    Ok(())
}
