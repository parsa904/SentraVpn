use crate::bot::keyboards::{
    download_app_inline_keyboard, ios_modes_inline_keyboard, ios_protocol_choice_keyboard,
    subscription_status_inline_keyboard, upgrade_plans_inline_keyboard,
    user_devices_inline_keyboard, user_main_keyboard, user_main_keyboard_with_admin,
};
use crate::compiler;
use crate::db::{DbPool, Repository};
use std::collections::HashMap;
use std::sync::OnceLock;
use teloxide::prelude::*;
use teloxide::types::{InputFile, ParseMode};
use tokio::sync::RwLock;

#[derive(Debug, Clone)]
pub enum UserState {
    AwaitingVerifyCode,
    AwaitingDonationConfig,
    AwaitingNewPasswordReset,
}

static USER_STATES: OnceLock<RwLock<HashMap<i64, UserState>>> = OnceLock::new();

fn user_states_map() -> &'static RwLock<HashMap<i64, UserState>> {
    USER_STATES.get_or_init(|| RwLock::new(HashMap::new()))
}

pub async fn set_user_state(user_id: i64, state: UserState) {
    let mut map = user_states_map().write().await;
    map.insert(user_id, state);
}

pub async fn get_user_state(user_id: i64) -> Option<UserState> {
    let map = user_states_map().read().await;
    map.get(&user_id).cloned()
}

pub async fn clear_user_state(user_id: i64) {
    let mut map = user_states_map().write().await;
    map.remove(&user_id);
}

pub async fn handle_start(
    bot: &Bot,
    msg: &Message,
    pool: &DbPool,
    admin_chat_id: i64,
    start_payload: Option<&str>,
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

    let sub = Repository::create_or_ensure_lite_subscription(pool, user.id).await?;
    let is_admin_user = admin_chat_id != 0 && (telegram_user.id.0 as i64 == admin_chat_id);

    // Deep link handler for verification: /start verify_<CODE> or /start reset_password
    if let Some(payload) = start_payload {
        if let Some(code) = payload.strip_prefix("verify_") {
            return handle_verify_code_input(bot, msg, pool, admin_chat_id, code).await;
        }
        if payload == "reset_password" {
            return crate::bot::password_reset::handle_password_reset_menu(bot, msg, pool, admin_chat_id).await;
        }
    }

    let is_verified = user.telegram_verified != 0;
    let verify_status_str = if is_verified {
        "🟢 تایید شده (بخش دانلود باز است)"
    } else {
        "🔒 تایید نشده (بخش دانلود قفل است)"
    };

    let mut text = format!(
        r#"👋 درود <b>{}</b> گرامی، به ربات هوشمند <b>سنترا (Sentra)</b> خوش آمدید!

🛡 <b>مشخصات حساب کاربری شما:</b>
• وضعیت تایید تلگرام: <b>{}</b>
• سطح اشتراک: <code>{}</code>
• پروتکل پیش‌فرض: <code>Sing-box v1.10+ (TUN / SysProxy)</code>
• وضعیت شبکه: <b>🟢 پایدار و فعال</b>

👇 <i>از منوی دکمه‌ای زیر می‌توانید تمامی بخش‌ها را مدیریت فرمایید:</i>"#,
        user.first_name, verify_status_str, sub.tier
    );

    if is_admin_user {
        text.push_str("\n\n👑 <i>دسترسی مدیر کل سیستم فعال است. از دکمه «🛠 پنل مدیریت (ادمین)» استفاده فرمایید.</i>");
    }

    bot.send_message(msg.chat.id, text)
        .parse_mode(ParseMode::Html)
        .reply_markup(user_main_keyboard_with_admin(is_admin_user))
        .await?;

    Ok(())
}

/// Prompt user to send 6-digit Telegram verification code from app
pub async fn handle_request_verify_code_prompt(
    bot: &Bot,
    msg: &Message,
) -> anyhow::Result<()> {
    let text = r#"🔗 <b>تایید حساب و باز کردن بخش دانلود</b>

برای تایید حساب، لطفاً کد ۶ رقمی تولیدشده در اپلیکیشن <b>Sentra Connect</b> را در پاسخ به این پیام ارسال نمایید.

💡 <i>راهنما: در صفحه داشبورد نرم‌افزار، روی کارت «دانلود» کلیک کرده و دکمه «🔗 تایید حساب در تلگرام» را بزنید.</i>"#;

    bot.send_message(msg.chat.id, text)
        .parse_mode(ParseMode::Html)
        .reply_markup(crate::bot::keyboards::cancel_inline_keyboard())
        .await?;

    Ok(())
}

/// Process verification code received from user
pub async fn handle_verify_code_input(
    bot: &Bot,
    msg: &Message,
    pool: &DbPool,
    admin_chat_id: i64,
    code: &str,
) -> anyhow::Result<()> {
    let telegram_user_id = msg.from.as_ref().map(|u| u.id.0 as i64).unwrap_or(0);
    let is_admin_user = admin_chat_id != 0 && (telegram_user_id == admin_chat_id);

    let verify_result = Repository::verify_telegram_code(pool, telegram_user_id, code.trim()).await?;

    match verify_result {
        Some(user) => {
            let user_email = user.email.unwrap_or_else(|| "حساب کاربری".to_string());
            let success_text = format!(
                r#"🎉 <b>تبریک! حساب کاربری شما با موفقیت تایید شد.</b>

👤 <b>ایمیل حساب:</b> <code>{}</code>
🔗 <b>شناسه تلگرام متصل‌شده:</b> <code>{}</code>

✅ <b>بخش دانلود پرسرعت (Download) هم‌اکنون برای شما باز و فعال شد!</b>
می‌توانید به نرم‌افزار Sentra Connect بازگشته، دکمه «بررسی مجدد وضعیت» را بزنید و از حالت دانلود پرسرعت بدون محدودیت استفاده فرمایید."#,
                user_email, telegram_user_id
            );

            bot.send_message(msg.chat.id, success_text)
                .parse_mode(ParseMode::Html)
                .reply_markup(user_main_keyboard_with_admin(is_admin_user))
                .await?;
        }
        None => {
            let error_text = r#"❌ <b>کد تایید وارد شده نامعتبر است یا منقضی شده است.</b>

⏳ مهلت اعتبار هر کد تایید <b>۱۵ دقیقه</b> می‌باشد.
لطفاً در اپلیکیشن Sentra Connect مجدداً روی کارت دانلود کلیک کرده و کد جدید دریافت نمایید."#;

            bot.send_message(msg.chat.id, error_text)
                .parse_mode(ParseMode::Html)
                .reply_markup(user_main_keyboard_with_admin(is_admin_user))
                .await?;
        }
    }

    Ok(())
}

/// Show comprehensive support guide
pub async fn handle_support_guide(
    bot: &Bot,
    msg: &Message,
) -> anyhow::Result<()> {
    let text = r#"💬 <b>پشتیبانی و راهنمای جامع Sentra Connect</b>

🔹 <b>نحوه اتصال و استفاده:</b>
۱. ابتدا کلاینت را از دکمه «📥 دانلود اپلیکیشن» دانلود و نصب فرمایید.
۲. با ایمیل و رمز عبور خود در اپلیکیشن ثبت‌نام کنید.
۳. برای استفاده از بخش دانلود، حساب تلگرام خود را با دکمه «🔗 تایید حساب» متصل کنید.

🔹 <b>رفع خطاهای رایج:</b>
• <b>کندی سرعت:</b> از بخش تنظیمات اپلیکیشن پروتکل یا لوکیشن را تغییر دهید.
• <b>خطای قطع اتصال:</b> مطمئن شوید حالت TUN با دسترسی Administrator اجرا می‌شود یا حالت System Proxy را انتخاب کنید.
• <b>ترید و صرافی‌ها:</b> از حالت «آی‌پی ثابت (Static IP)» استفاده نمایید.

📩 جهت ارتباط با کارشناسان فنی یا ثبت تیکت، می‌توانید از دکمه‌های زیر استفاده فرمایید:"#;

    bot.send_message(msg.chat.id, text)
        .parse_mode(ParseMode::Html)
        .reply_markup(crate::bot::keyboards::support_ticket_inline_keyboard())
        .await?;

    Ok(())
}

#[allow(dead_code)]
pub async fn handle_free_account(bot: &Bot, msg: &Message, pool: &DbPool) -> anyhow::Result<()> {
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

    let sub = Repository::create_or_ensure_lite_subscription(pool, user.id).await?;
    let code = Repository::generate_auth_code(pool, user.id).await?;

    let remaining_gb = ((sub.traffic_limit_bytes - (sub.upload_bytes + sub.download_bytes)).max(0)) as f64
        / (1024.0 * 1024.0 * 1024.0);

    let text = format!(
        r#"🎁 <b>اشتراک رایگان Sentra Lite شما صادر شد:</b>

• شناسه کاربر: <code>{}</code>
• توکن اتصال: <code>{}</code>
• حجم باقیمانده: <b>{:.2} گیگابایت</b>
• سقف سرعت: <code>10 Mbps</code>
• کد ۸ رقمی اپلیکیشن: <b><code>{}</code></b>
• تاریخ انقضا: <code>{}</code>

💡 <i>کد بالا را داخل نرم‌افزار Sentra Connect وارد کنید تا تانل ایمن فوراً فعال شود.</i>"#,
        user.id,
        sub.token,
        remaining_gb,
        code,
        sub.expires_at.format("%Y-%m-%d %H:%M UTC")
    );

    bot.send_message(msg.chat.id, text)
        .parse_mode(ParseMode::Html)
        .reply_markup(user_main_keyboard())
        .await?;

    Ok(())
}

#[allow(dead_code)]
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
            .reply_markup(user_main_keyboard())
            .await?;
    }

    Ok(())
}

#[allow(dead_code)]
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

    let user = Repository::get_or_create_user(
        pool,
        telegram_user.id.0 as i64,
        telegram_user.username.as_deref(),
        &telegram_user.first_name,
        telegram_user.last_name.as_deref(),
    )
    .await?;

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
        .reply_markup(user_main_keyboard())
        .await?;

    // Output 3: Generate and send the actual test .ovpn file as document
    let ovpn_content = compiler::generate_ovpn_profile(&sub, Some("web_browsing"));
    let ovpn_file = InputFile::memory(ovpn_content.into_bytes())
        .file_name(format!("sentra-{}.ovpn", &sub.token[..8]));

    bot.send_document(msg.chat.id, ovpn_file)
        .caption("🛡 پروفایل OpenVPN سنترا (رمزنگاری AES-256-GCM و tls-crypt)")
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

    let user = Repository::get_or_create_user(
        pool,
        telegram_user.id.0 as i64,
        telegram_user.username.as_deref(),
        &telegram_user.first_name,
        telegram_user.last_name.as_deref(),
    )
    .await?;

    let mut sub = Repository::create_or_ensure_lite_subscription(pool, user.id).await?;
    let _ = Repository::check_and_reset_daily_quota(pool, &mut sub).await;
    let devices = Repository::get_user_devices(pool, user.id).await?;

    let is_pro = sub.tier != "Sentra Lite";
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

    let text = format!(
        r#"📊 <b>گزارش مصرف و وضعیت ترافیک حساب:</b>

• سطح اشتراک: <b>{}</b>
• وضعیت سرویس: <code>{}</code>
• دستگاه‌های متصل: <b>{} از ۳ دستگاه مجاز</b>
• تاریخ اعتبار: <code>{}</code>

{}

💬 <i>جهت مدیریت دستگاه‌های متصل، ثبت تیکت پشتیبانی یا ارتقا، از گزینه‌های زیر استفاده نمایید:</i>"#,
        sub.tier,
        sub.status,
        devices.len(),
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
            .reply_markup(user_main_keyboard())
            .await?;
    }

    Ok(())
}

/// Prompt iOS user to pick one of the 4 connection modes for OpenVPN
#[allow(dead_code)]
pub async fn handle_ios_subscription_prompt(
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

    let sub = match Repository::get_subscription_by_user_id(pool, user.id).await? {
        Some(s) => s,
        None => Repository::create_or_ensure_lite_subscription(pool, user.id).await?,
    };

    let text = format!(
        r#"🍏 <b>اشتراک اختصاصی iOS و مک (پروتکل OpenVPN)</b>

سطح اشتراک فعلی شما: <b>{}</b>

برای دریافت فایل کانفیگ سازگار با اپلیکیشن <b>OpenVPN Connect</b> روی آیفون، آیپد یا سیستم‌عامل مک، یکی از حالت‌های اتصال زیر را انتخاب کنید:

🌐 <b>۱. وب‌گردی (Web Browsing):</b> ۲ گیگابایت سهمیه روزانه رایگان، مناسب گشت‌وگذار روزمره
⚡ <b>۲. دانلود (Download):</b> ۳ گیگابایت سهمیه روزانه رایگان، بهینه‌سازی سرعت بالا
🎮 <b>۳. گیمینگ (Gaming):</b> کاهش پینگ و جیتر (به‌زودی اضافه می‌شود)
🔒 <b>۴. آی‌پی ثابت ترید/جمنای (Static IP):</b> آی‌پی ثابت تمیز مسکونی آمریکا (ویژه کاربران Pro و Flow+)

👇 <b>لطفاً حالت اتصال مورد نظر خود را انتخاب نمایید:</b>"#,
        sub.tier
    );

    bot.send_message(msg.chat.id, text)
        .parse_mode(ParseMode::Html)
        .reply_markup(ios_modes_inline_keyboard(&sub.tier))
        .await?;

    Ok(())
}

/// Handle selection of an iOS connection mode callback - shows protocol choices (IKEv2 vs OpenVPN)
pub async fn handle_ios_mode_selection(
    bot: &Bot,
    q: &CallbackQuery,
    pool: &DbPool,
    mode: &str,
    _base_url: &str,
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

    // 1. Gaming is coming soon
    if mode == "gaming" {
        bot.answer_callback_query(q.id.clone())
            .text("🎮 حالت گیمینگ (کاهش پینگ و جیتر) در حال حاضر غیرفعال است و به‌زودی اضافه می‌شود.")
            .show_alert(true)
            .await?;
        return Ok(());
    }

    // 2. Static IP is locked for Lite tier
    if mode == "static_ip" && sub.tier == "Sentra Lite" {
        bot.answer_callback_query(q.id.clone())
            .text("🔒 دسترسی به آی‌پی ثابت تمیز مسکونی آمریکا مختص پلن‌های ویژه (Pro / Flow+) است. لطفاً اشتراک خود را ارتقا دهید.")
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
        "static_ip" => "🔒 آی‌پی ثابت مسکونی آمریکا (ترید و جمنای)",
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

    let direct_url = format!("{}/api/v1/mobileconfig/{}?mode={}", base_url, sub.token, mode);

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
• رمز عبور: <code>{}</code>

🔗 <b>لینک مستقیم نصب در سافاری:</b>
<code>{}</code>"#,
        mode_fa,
        sub.tier,
        sub.expires_at.format("%Y-%m-%d"),
        mode,
        server_host,
        server_host,
        sub.token,
        sub.token,
        direct_url
    );

    if let Some(msg) = &q.message {
        bot.send_document(msg.chat().id, config_file)
            .caption(caption)
            .parse_mode(ParseMode::Html)
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

    let direct_url = format!("{}/api/v1/ovpn/{}?mode={}&protocol={}", base_url, sub.token, mode, protocol);

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
۴. در برنامه OpenVPN، دکمه <b>ADD</b> را زده و سوئیچ اتصال را روشن کنید.

🔗 <b>لینک مستقیم دانلود فایل:</b>
<code>{}</code>"#,
        proto_title,
        mode_fa,
        mode_desc,
        sub.tier,
        sub.expires_at.format("%Y-%m-%d"),
        direct_url
    );

    if let Some(msg) = &q.message {
        bot.send_document(msg.chat().id, ovpn_file)
            .caption(caption)
            .parse_mode(ParseMode::Html)
            .await?;
    }

    Ok(())
}

/// Returns iOS user back to the 4 connection modes selection
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

    let prompt = r#"🍏 <b>اشتراک اختصاصی iOS و مک (پروتکل‌های ایمن)</b>

به دلیل محدودیت‌های سیستم‌عامل iOS در نصب هسته‌های جانبی، اتصال در آیفون از طریق <b>IKEv2 بومی</b> یا <b>OpenVPN</b> برقرار می‌شود.

📌 لطفاً یکی از ۴ حالت اتصال زیر را متناسب با نیاز خود انتخاب فرمایید:"#;

    bot.answer_callback_query(q.id.clone()).await?;

    if let Some(msg) = &q.message {
        let _ = bot.edit_message_text(msg.chat().id, msg.id(), prompt)
            .parse_mode(ParseMode::Html)
            .reply_markup(ios_modes_inline_keyboard(&sub.tier))
            .await;
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
        .await?;
    Ok(())
}

/// Prompt explaining Financial Support / Donation
#[allow(dead_code)]
pub async fn handle_financial_donation_prompt(
    bot: &Bot,
    msg: &Message,
    pro_price: i64,
) -> anyhow::Result<()> {
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
#[allow(dead_code)]
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

    let code = Repository::generate_link_code(pool, user.id).await?;

    let text = format!(
        r#"🔗 <b>یکپارچه‌سازی و اتصال حساب کاربری Sentra:</b>

با اتصال حساب، اشتراک و سهمیه‌های شما در ربات تلگرام، اپلیکیشن ویندوز و کلاینت اندروید همگام می‌شوند.

🔹 <b>روش اول: اگر در اپلیکیشن ویندوز/اندروید ثبت‌نام کرده‌اید:</b>
کد ۶ رقمی اتصال را از اپلیکیشن دریافت کرده و با دستور زیر ارسال کنید:
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
        .await?;

    Ok(())
}

/// Handle /link command with or without 6-digit code
#[allow(dead_code)]
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
        bot.send_message(msg.chat.id, text).parse_mode(ParseMode::Html).await?;
        return Ok(());
    }

    if trimmed.len() != 6 || !trimmed.chars().all(|c| c.is_ascii_digit()) {
        bot.send_message(
            msg.chat.id,
            "⚠️ کد اتصال باید یک عدد ۶ رقمی باشد. مثال: <code>/link 123456</code>",
        )
        .parse_mode(ParseMode::Html)
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
            let text = format!(
                r#"🎉 <b>حساب کاربری با موفقیت متصل شد!</b>

• نام کاربری: <code>{}</code>
• شناسه یکپارچه: <code>{}</code>

اکنون حساب اپلیکیشن شما با این اکانت تلگرام یکپارچه شد. تمام دستگاه‌ها و اشتراک فعال شما به این حساب واحد پیوند داده شدند."#,
                user.username.as_deref().unwrap_or("کاربر سنترا"),
                user.user_uuid
            );
            bot.send_message(msg.chat.id, text).parse_mode(ParseMode::Html).await?;
        }
        Err(e) => {
            let err_msg = match e {
                crate::error::CoreError::AuthFailed(msg) => msg,
                _ => "کد اتصال نامعتبر است یا منقضی شده است.".to_string(),
            };
            let text = format!("❌ <b>خطا در اتصال حساب:</b>\n\n{}", err_msg);
            bot.send_message(msg.chat.id, text).parse_mode(ParseMode::Html).await?;
        }
    }

    Ok(())
}

/// Handle /setpassword <username> <password> command
#[allow(dead_code)]
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
        .await?;
        return Ok(());
    }

    if password.len() < 6 {
        bot.send_message(
            msg.chat.id,
            "⚠️ رمز عبور باید حداقل ۶ کاراکتر باشد.",
        )
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
            bot.send_message(msg.chat.id, text).parse_mode(ParseMode::Html).await?;
        }
        Err(e) => {
            let text = format!("❌ خطا در تنظیم مشخصات: {}", e);
            bot.send_message(msg.chat.id, text).await?;
        }
    }

    Ok(())
}

/// Show app download menu with OS selection buttons
pub async fn handle_download_app_menu(
    bot: &Bot,
    msg: &Message,
    pool: &DbPool,
) -> anyhow::Result<()> {
    let release_opt = Repository::get_latest_app_release(pool).await.unwrap_or(None);
    let (version, changelog) = match &release_opt {
        Some(r) => (r.version.as_str(), r.changelog.as_str()),
        None => ("1.0.0", "نسخه رسمی کلاینت هوشمند Sentra Connect"),
    };

    let text = format!(
        r#"📥 <b>دانلود اپلیکیشن اختصاصی Sentra Connect</b>

🔹 <b>آخرین نسخه:</b> <code>{}</code>
📝 <b>تغییرات این نسخه:</b>
<i>{}</i>

نرم‌افزار هوشمند سنترا کانکت مجهز به سیستم سوییچ خودکار پروتکل و ضدفیلترینگ هوشمند:
• اتصال تک‌کلیک و بدون قطعی
• حالت‌های ۴ گانه هوشمند (وب‌گردی، دانلود پرسرعت، گیمینگ و آی‌پی ثابت)
• محافظت نشت DNS و Kill Switch داخلی

👇 <b>لطفاً نسخه مورد نظر خود را جهت دریافت انتخاب نمایید:</b>"#,
        version,
        if changelog.is_empty() { "نسخه رسمی با قابلیت سوییچ هوشمند و پروتکل‌های ضد فیلترینگ" } else { changelog }
    );

    bot.send_message(msg.chat.id, text)
        .parse_mode(ParseMode::Html)
        .reply_markup(download_app_inline_keyboard(release_opt.as_ref()))
        .await?;

    Ok(())
}

/// Handle download for Windows or Android directly via Telegram file_id or GitHub Release
pub async fn handle_download_platform_callback(
    bot: &Bot,
    q: &CallbackQuery,
    pool: &DbPool,
    platform: &str,
) -> anyhow::Result<()> {
    let release_opt = Repository::get_latest_app_release(pool).await?;

    match release_opt {
        Some(release) => {
            let is_windows = platform == "windows";
            let platform_fa = if is_windows { "ویندوز (Windows 10/11)" } else { "اندروید (Android)" };
            let file_id_opt = if is_windows { &release.windows_file_id } else { &release.android_file_id };
            let github_url_opt = if is_windows { &release.windows_github_url } else { &release.android_github_url };

            let caption = format!(
                r#"🚀 <b>اپلیکیشن اختصاصی Sentra Connect برای {}</b>

🔹 <b>نسخه:</b> <code>{}</code>
📝 <b>تغییرات این نسخه:</b>
{}

💡 <b>راهنمای ورود و استفاده:</b>
۱. فایل را نصب و اجرا نمایید.
۲. با ایمیل و رمز عبور خود وارد شوید یا حساب جدید بسازید.
۳. جهت فعال‌سازی بخش دانلود، حساب تلگرام خود را تایید نمایید."#,
                platform_fa,
                release.version,
                if release.changelog.is_empty() {
                    "نسخه رسمی با قابلیت سوییچ هوشمند پروتکل‌ها و ضد فیلترینگ"
                } else {
                    &release.changelog
                }
            );

            if let Some(file_id) = file_id_opt {
                if let Some(msg) = &q.message {
                    bot.send_document(msg.chat().id, InputFile::file_id(file_id.clone()))
                        .caption(caption)
                        .parse_mode(ParseMode::Html)
                        .await?;
                }
                bot.answer_callback_query(q.id.clone())
                    .text(format!("فایل نصبی {} ارسال شد.", platform_fa))
                    .await?;
            } else {
                let default_direct_url = if is_windows {
                    crate::bot::keyboards::GITHUB_RELEASE_WINDOWS_URL
                } else {
                    crate::bot::keyboards::GITHUB_RELEASE_ANDROID_URL
                };
                let download_url = github_url_opt.as_deref().unwrap_or(default_direct_url);
                let msg_text = format!(
                    r#"🌐 <b>دانلود مستقیم {} از گیت‌هاب (Sentra Release):</b>

🔹 <b>نسخه:</b> <code>{}</code>
🔗 <b>لینک دانلود مستقیم:</b>
{}

💡 <i>فایل نصب استاندارد و امضاشده به محض کلیک دانلود می‌شود.</i>"#,
                    platform_fa, release.version, download_url
                );
                if let Some(msg) = &q.message {
                    bot.send_message(msg.chat().id, msg_text)
                        .parse_mode(ParseMode::Html)
                        .await?;
                }
                bot.answer_callback_query(q.id.clone()).await?;
            }
        }
        None => {
            let is_windows = platform == "windows";
            let platform_fa = if is_windows { "ویندوز (Windows 10/11)" } else { "اندروید (Android)" };
            let direct_url = if is_windows {
                crate::bot::keyboards::GITHUB_RELEASE_WINDOWS_URL
            } else {
                crate::bot::keyboards::GITHUB_RELEASE_ANDROID_URL
            };
            let msg_text = format!(
                r#"🚀 <b>دانلود آخرین نسخه رسمی {} (Sentra Connect v1.0):</b>

🔗 <b>لینک مستقیم انتشار گیتهاب:</b>
{}

💡 <i>می‌توانید آخرین نسخه رسمی و امضاشده را مستقیماً از لینک فوق دریافت فرمایید.</i>"#,
                platform_fa, direct_url
            );

            if let Some(msg) = &q.message {
                bot.send_message(msg.chat().id, msg_text)
                    .parse_mode(ParseMode::Html)
                    .await?;
            }
            bot.answer_callback_query(q.id.clone())
                .text(format!("لینک دانلود مستقیم {} ارسال شد.", platform_fa))
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

    let text = format!(
        r#"🍏 <b>اشتراک اختصاصی iOS و مک (پروتکل OpenVPN)</b>

سطح اشتراک فعلی شما: <b>{}</b>

برای دریافت فایل کانفیگ سازگار با اپلیکیشن <b>OpenVPN Connect</b> روی آیفون، آیپد یا سیستم‌عامل مک، یکی از حالت‌های اتصال زیر را انتخاب کنید:

🌐 <b>۱. وب‌گردی (Web Browsing):</b> ۲ گیگابایت سهمیه روزانه رایگان، مناسب گشت‌وگذار روزمره
⚡ <b>۲. دانلود (Download):</b> ۳ گیگابایت سهمیه روزانه رایگان، بهینه‌سازی سرعت بالا
🎮 <b>۳. گیمینگ (Gaming):</b> کاهش پینگ و جیتر (به‌زودی اضافه می‌شود)
🔒 <b>۴. آی‌پی ثابت ترید/جمنای (Static IP):</b> آی‌پی ثابت تمیز مسکونی آمریکا (ویژه کاربران Pro و Flow+)

👇 <b>لطفاً حالت اتصال مورد نظر خود را انتخاب نمایید:</b>"#,
        sub.tier
    );

    if let Some(msg) = &q.message {
        bot.send_message(msg.chat().id, text)
            .parse_mode(ParseMode::Html)
            .reply_markup(ios_modes_inline_keyboard(&sub.tier))
            .await?;
    }
    bot.answer_callback_query(q.id.clone()).await?;
    Ok(())
}
